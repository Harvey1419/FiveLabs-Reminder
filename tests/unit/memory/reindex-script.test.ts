import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const loader = createRequire(import.meta.url).resolve('tsx');
type Mode = 'healthy' | 'bad-vector' | 'read-error' | 'write-error';
interface Receipt { reads: number; embeddings: number; writes: number; successfulWrites: number; batchSizes: number[]; ids: string[] }

/** The real script/SDK run in a child; every HTTP attempt is intercepted before I/O. */
function runReindex(apply: boolean, count: number, mode: Mode = 'healthy') {
  const preload = 'data:text/javascript;base64,' + Buffer.from(`
    import assert from 'node:assert/strict';
    import http from 'node:http';
    import https from 'node:https';
    for (const transport of [http, https]) {
      transport.request = transport.get = () => { throw new Error('REINDEX_NETWORK_BLOCKED: native HTTP'); };
    }
    const receipt = { reads: 0, embeddings: 0, writes: 0, successfulWrites: 0, batchSizes: [], ids: [] };
    process.on('exit', () => console.log('REINDEX_TEST_RECEIPT=' + JSON.stringify(receipt)));
    globalThis.fetch = async (input, options) => {
      const request = new Request(input, options), url = new URL(request.url);
      const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.origin === 'https://reindex.invalid' && url.pathname === '/rest/v1/memories') {
        assert.equal(url.searchParams.get('is_active'), 'eq.true');
        if (request.method === 'GET') {
          receipt.reads++;
          assert.equal(url.searchParams.get('select'), 'id,topic_key,content');
          assert.equal(url.searchParams.get('order'), 'id.asc');
          const offset = Number(url.searchParams.get('offset'));
          assert.equal(offset, (receipt.reads - 1) * 500);
          assert.equal(url.searchParams.get('limit'), '500');
          if (${JSON.stringify(mode)} === 'read-error') return response({ message: 'synthetic read failure' }, 400);
          return response(Array.from({ length: Math.min(500, Math.max(0, ${count} - offset)) }, (_, index) => ({
            id: 'synthetic-' + (offset + index), topic_key: 'profile/synthetic', content: 'Synthetic memory ' + (offset + index),
          })));
        }
        assert.equal(request.method, 'PATCH');
        const id = url.searchParams.get('id');
        assert.match(id, /^eq\\.synthetic-\\d+$/);
        receipt.ids.push(id.slice(3)); receipt.writes++;
        const payload = await request.json();
        assert.deepEqual(Object.keys(payload), ['embedding']);
        assert.equal(payload.embedding.length, 768);
        if (${JSON.stringify(mode)} === 'write-error' && id === 'eq.synthetic-0') return response({ message: 'synthetic write failure' }, 400);
        receipt.successfulWrites++;
        return new Response(null, { status: 204 });
      }
      assert.equal(url.href, 'https://openrouter.ai/api/v1/embeddings', 'Unapproved HTTP request');
      assert.equal(request.method, 'POST');
      receipt.embeddings++;
      const payload = await request.json();
      assert.equal(payload.dimensions, 768);
      assert.equal(payload.model, 'openai/text-embedding-3-small');
      assert.ok(Array.isArray(payload.input) && payload.input.length > 0 && payload.input.length <= 32);
      receipt.batchSizes.push(payload.input.length);
      if (${JSON.stringify(mode)} === 'bad-vector') return response({ data: [] });
      return response({ data: payload.input.map((text, index) => {
        assert.ok(text.includes('Synthetic memory'));
        return { index, embedding: Array(768).fill(0.1) };
      }) });
    };
  `).toString('base64');
  const result = spawnSync(process.execPath, ['--import', loader, '--import', preload,
    resolve('scripts/maintenance/reindex-memory-embeddings.ts'), ...(apply ? ['--apply'] : [])], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 10000,
    env: { PATH: process.env.PATH, DOTENV_CONFIG_PATH: '/dev/null', SUPABASE_URL: 'https://reindex.invalid',
      SUPABASE_SECRET: 'synthetic-reindex-secret', OPENROUTER_API_KEY: 'synthetic-embedding-key' },
  });
  const line = result.stdout.split('\n').find(value => value.startsWith('REINDEX_TEST_RECEIPT='));
  expect(line, result.stderr).toBeDefined();
  return { ...result, receipt: JSON.parse(line!.slice('REINDEX_TEST_RECEIPT='.length)) as Receipt };
}

describe('typed memory reindex command', () => {
  it('pages active memory projections in dry run without embeddings or writes', () => {
    const result = runReindex(false, 501);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('active=501');
    expect(result.stdout).toContain('Dry run only');
    expect(result.receipt).toMatchObject({ reads: 2, embeddings: 0, writes: 0 });
  });

  it('requires --apply and preserves 32-row batches, active predicates and explicit row identities', () => {
    const result = runReindex(true, 33);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('[memory-reindex] complete');
    expect(result.receipt).toMatchObject({ reads: 1, embeddings: 2, writes: 33, successfulWrites: 33, batchSizes: [32, 1] });
    expect(result.receipt.ids).toEqual(Array.from({ length: 33 }, (_, index) => `synthetic-${index}`));
  });

  it('stops before writes on an invalid embedding response', () => {
    const result = runReindex(true, 33, 'bad-vector');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Embedding batch returned 0/32 vectors');
    expect(result.receipt).toMatchObject({ reads: 1, embeddings: 1, writes: 0 });
  });

  it('stops before generation on a failed page read', () => {
    const result = runReindex(true, 33, 'read-error');
    expect(result.status).toBe(1);
    expect(result.receipt).toMatchObject({ reads: 1, embeddings: 0, writes: 0 });
  });

  it('exposes a failed parallel batch and stops before the next batch without replaying committed updates', () => {
    const result = runReindex(true, 33, 'write-error');
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('[memory-reindex] complete');
    expect(result.receipt).toMatchObject({ reads: 1, embeddings: 1, writes: 32, successfulWrites: 31, batchSizes: [32] });
  });
});

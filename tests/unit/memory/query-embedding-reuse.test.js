import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const { from, rpc, requests, extract, eligible } = vi.hoisted(() => ({
  from: vi.fn(), rpc: vi.fn(), requests: [], extract: vi.fn(), eligible: vi.fn(text => text),
}));
vi.mock('../../../src/infrastructure/database/index.js', () => ({ supabase: { from, rpc } }));
vi.mock('../../../src/features/memory/service.js', () => ({
  extractAndSaveMemories: extract, getMemoryEligibleText: eligible,
}));
const { generateEmbedding, generateEmbeddings, withQueryEmbeddingScope, captureQueryEmbeddingScope, MEMORY_EMBEDDING_MODEL } =
  await import('../../../src/integrations/ai/embeddings.js');
const { searchMemories } = await import('../../../src/infrastructure/database/memories.js');
const { extractMemoryInBackground } = await import('../../../src/jobs/memory-extractor.js');
const { withTurnLease, withoutTurnLease, currentTurnSignal, assertTurnLease } =
  await import('../../../src/agent/core/turn-lease.js');
const query = text => generateEmbedding(text, { queryOwner: 'owner-a' });
const vector = () => Array(768).fill(0.25);
const response = () => ({ ok: true, json: async () => ({ data: [{ index: 0, embedding: vector() }] }) });
let fetchMock;

beforeEach(() => {
  vi.clearAllMocks(); requests.length = 0;
  vi.stubEnv('OPENROUTER_API_KEY', 'offline-test-key');
  fetchMock = vi.fn().mockImplementation(async () => response());
  vi.stubGlobal('fetch', fetchMock);
  rpc.mockResolvedValue({ data: [{ id: 'fact', similarity: 0.9 }], error: null });
  from.mockImplementation(table => {
    const request = { table, predicates: [] }; requests.push(request);
    const q = {};
    for (const method of ['select', 'eq', 'in', 'order', 'limit', 'or', 'ilike', 'textSearch', 'update']) {
      q[method] = (...args) => { request.predicates.push([method, ...args]); return q; };
    }
    q.then = (resolve, reject) => Promise.resolve({ error: null, data:
      request.predicates.some(p => p[0] === 'in') ? [{ id: 'fact', user_id: 'owner-a', is_active: true,
        superseded_by: null, valid_until: null, category: 'fact', content: 'Vivo en Cali.', topic_key: 'profile/residence' }] : [],
    }).then(resolve, reject);
    return q;
  });
  extract.mockResolvedValue([]);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('owner-bound ephemeral query embeddings', () => {
  it('coalesces pending and sequential exact effective inputs and clones every consumer', async () => {
    let release;
    fetchMock.mockImplementation(() => new Promise(resolve => { release = () => resolve(response()); }));
    await withQueryEmbeddingScope('owner-a', async () => {
      const first = query('  Vivo en Cali.  ');
      const second = query('Vivo en Cali.');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      release();
      const [a, b] = await Promise.all([first, second]);
      expect(a).toEqual(vector()); expect(a).not.toBe(b);
      a[0] = 99; b[1] = 88;
      expect(await query('Vivo en Cali.')).toEqual(vector());
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body).toEqual({ model: MEMORY_EMBEDDING_MODEL, dimensions: 768, encoding_format: 'float', input: 'Vivo en Cali.' });
      expect(MEMORY_EMBEDDING_MODEL).toBe('openai/text-embedding-3-small');
    });
  });

  it('isolates different inputs, owner metadata, nested owners, new scopes and unscoped calls', async () => {
    await withQueryEmbeddingScope('owner-a', async () => {
      await query('same'); await query('Same');
      await generateEmbedding('same', { queryOwner: 'owner-b' });
      await generateEmbedding('same', { queryOwner: 'owner-b' });
      await withQueryEmbeddingScope('owner-b', async () => {
        await generateEmbedding('same', { queryOwner: 'owner-b' });
        await generateEmbedding('same', { queryOwner: 'owner-b' });
      });
      await query('same');
    });
    await withQueryEmbeddingScope('owner-a', () => query('same'));
    await query('same'); await query('same');
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it.each(['null', 'rejection', 'invalid shape'])('evicts %s failures so the same query can recover', async failure => {
    if (failure === 'rejection') fetchMock.mockRejectedValueOnce(new Error('offline failure'));
    else if (failure === 'null') fetchMock.mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'offline' });
    else fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: [0] }] }) });
    await withQueryEmbeddingScope('owner-a', async () => {
      expect(await query('retry')).toBeNull();
      expect(await query('retry')).toEqual(vector());
      expect(await query('retry')).toEqual(vector());
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('bounds each scope to 32 entries without contaminating retained vectors', async () => {
    await withQueryEmbeddingScope('owner-a', async () => {
      for (let i = 0; i < 33; i++) await query(`query-${i}`);
      await query('query-32');
      expect(fetchMock).toHaveBeenCalledTimes(33);
      await query('query-0');
      expect(fetchMock).toHaveBeenCalledTimes(34);
    });
  });

  it('never caches legacy/save or batch calls even when their text equals the query', async () => {
    await withQueryEmbeddingScope('owner-a', async () => {
      await query('same');
      await generateEmbedding('same'); await generateEmbedding('same');
      await generateEmbeddings(['same']); await generateEmbeddings(['same']);
      await query('same');
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(JSON.parse(fetchMock.mock.calls[3][1].body).input).toEqual(['same']);
  });

  it('rejects blank input without provider work', async () => {
    await withQueryEmbeddingScope('owner-a', async () => {
      expect(await query('  ')).toBeNull(); expect(await query(null)).toBeNull();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reuses only the vector: two searches still run owned RPC, sparse, topic and hydration reads', async () => {
    await withQueryEmbeddingScope('owner-a', async () => {
      for (let i = 0; i < 2; i++) {
        const result = await searchMemories({ userId: 'owner-a', query: 'Vivo en Cali.', topicKey: 'profile', withStatus: true });
        expect(result.status).toBe('available');
        expect(result.memories.map(m => m.id)).toEqual(['fact']);
      }
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledTimes(2);
    for (const [name, args] of rpc.mock.calls) {
      expect(name).toBe('match_memories'); expect(args.p_user_id).toBe('owner-a');
      expect(args.p_query_embedding).toEqual(vector());
    }
    for (const method of ['textSearch', 'ilike', 'in']) {
      const reads = requests.filter(r => r.predicates.some(p => p[0] === method)
        && !r.predicates.some(p => p[0] === 'update'));
      expect(reads).toHaveLength(2);
      for (const read of reads) expect(read.predicates).toContainEqual(['eq', 'user_id', 'owner-a']);
    }
  });

  it('captures queued scopes at enqueue, shares foreground vectors and does not revive lease/signal', async () => {
    const signal = new AbortController().signal;
    const assertActive = vi.fn();
    const jobs = [];
    let unblock;
    const blocked = new Promise(resolve => { unblock = resolve; });
    let firstStarted;
    const started = new Promise(resolve => { firstStarted = resolve; });
    let allDone;
    const done = new Promise(resolve => { allDone = resolve; });
    extract.mockImplementation(async args => {
      expect(currentTurnSignal()).toBeUndefined();
      await assertTurnLease();
      if (args.userId === 'owner-a') { firstStarted(); await blocked; }
      const v = await generateEmbedding(args.userText, { queryOwner: args.userId });
      jobs.push({ ...args, v });
      if (jobs.length === 3) allDone();
    });
    const facts = [{ tool: 'manage_reminder', success: true, card: 'Cita mañana' }];
    const text = 'Borona es mi perrita. Recuérdame su cita mañana.';
    await withTurnLease({ signal, assertActive }, () => withQueryEmbeddingScope('owner-a', async () => {
      await query(text);
      withoutTurnLease(() => extractMemoryInBackground({ userId: 'owner-a', userText: text,
        executionFacts: facts, memoryDisposition: 'skip_operational' }));
      expect(currentTurnSignal()).toBe(signal);
    }));
    await started;
    await withQueryEmbeddingScope('owner-b', async () => {
      await generateEmbedding(text, { queryOwner: 'owner-b' });
      extractMemoryInBackground({ userId: 'owner-b', userText: text });
    });
    // An unscoped job must not inherit a preceding queued owner's map.
    extractMemoryInBackground({ userId: 'owner-a', userText: text });
    unblock(); await done;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(jobs.map(j => j.userId)).toEqual(['owner-a', 'owner-b', 'owner-a']);
    expect(jobs[0].executionFacts).toBe(facts);
    expect(jobs[0].memoryDisposition).toBe('skip_operational');
    expect(jobs.every(j => j.v.length === 768)).toBe(true);
    expect(assertActive).not.toHaveBeenCalled();
  });

  it('binding an embedding scope never copies an unrelated turn lease', async () => {
    const assertActive = vi.fn();
    let bound;
    await withTurnLease({ signal: new AbortController().signal, assertActive }, () =>
      withQueryEmbeddingScope('owner-a', async () => {
        await query('captured');
        bound = captureQueryEmbeddingScope(async () => {
          expect(currentTurnSignal()).toBeUndefined();
          await assertTurnLease();
          return query('captured');
        });
      }));
    expect(await bound()).toEqual(vector());
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(assertActive).not.toHaveBeenCalled();
  });

  it('entrypoints wrap resolved owner turns and queued learning binds only embedding context', () => {
    const source = path => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
    expect(source('scripts/dev/interactive-chat.js')).toContain('withQueryEmbeddingScope(user.id, async () =>');
    const webhook = source('src/http/webhooks/whatsapp.js');
    expect(webhook.indexOf('withQueryEmbeddingScope(user.id, async () =>')).toBeGreaterThan(webhook.indexOf('if (!user?.id)'));
    expect(webhook).toContain('withoutTurnLease(() => extractMemoryInBackground(');
    const job = source('src/jobs/memory-extractor.js');
    expect(job.indexOf('const extractInScope = captureQueryEmbeddingScope')).toBeLessThan(job.indexOf('setImmediate('));
    expect(job).toContain('.then(extractInScope)');
    expect(source('src/integrations/ai/embeddings.js') + job).not.toMatch(/AsyncLocalStorage\.snapshot|AsyncResource\.bind/);
  });
});

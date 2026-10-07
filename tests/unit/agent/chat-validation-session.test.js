import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, readFileSync, writeFileSync, appendFileSync, rmSync, symlinkSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createPhase, readPhase, acquirePhase, beginPhaseBatch, endPhaseBatch, finalizePhase,
  verifyPhaseOwner, guardPhaseDatabaseRequest, ownerTables } from '../../../scripts/dev/chat-validation-session.js';

const context = { root: process.cwd(), database: 'https://offline.invalid' };
const directories = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

// Fluent offline SQL fixture: every mutation/read keeps the exact column predicate.
function database() {
  const data = Object.fromEntries(['users', 'prepared_actions', 'hermes_inbound_turns', ...ownerTables].map(table => [table, []]));
  const calls = [];
  let failure;
  const client = { data, calls, fail: fn => { failure = fn; }, from(table) {
    let operation = 'select', payload, column, value, single = false;
    const query = {
      select() { return query; }, eq(c, v) { column = c; value = v; return query; },
      insert(p) { operation = 'insert'; payload = p; return query; },
      delete() { operation = 'delete'; return query; }, single() { single = true; return query; },
      then(accept, reject) {
        calls.push({ table, operation, column, value });
        let result;
        if (failure?.({ table, operation, column, value })) result = { data: null, error: new Error('offline injected failure') };
        else {
          const matches = data[table].filter(row => row[column] === value);
          if (operation === 'insert') { data[table].push({ ...payload }); result = [payload]; }
          else if (operation === 'delete') { data[table] = data[table].filter(row => row[column] !== value); result = matches; }
          else result = matches;
          result = { data: single ? result[0] : result, error: null };
        }
        return Promise.resolve(result).then(accept, reject);
      },
    };
    return query;
  } };
  return client;
}
async function fixture(cap = 3) {
  const client = database();
  const handle = await createPhase(client, context, cap);
  directories.push(dirname(handle));
  return { client, handle, state: readPhase(handle, context) };
}
function childReservations(handle, token, count, crash = false) {
  const helper = resolve('scripts/dev/chat-validation-session.js');
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { phaseChildProof, reservePhaseRequest } from ${JSON.stringify(helper)};
    const [handle, token, root, database, count, crash] = process.argv.slice(1);
    const context = { root, database };
    phaseChildProof(handle, context, token, { register: true });
    for (let i = 0; i < Number(count); i++) reservePhaseRequest(handle, context, token, i % 2 ? 'embeddings' : 'chat');
    if (crash === 'true') process.exit(7);
  `, handle, token, context.root, context.database, String(count), String(crash)], { encoding: 'utf8', env: { PATH: process.env.PATH } });
}

describe('owned validation phase (no DB/API/network)', () => {
  it('creates a generated private repository/database-bound identity with absence proof and no keys', async () => {
    const { client, handle, state } = await fixture();
    expect(state).toMatchObject({ created: true, closed: false, spent: 0, cap: 3 });
    expect(state.phone).toMatch(/^hermes-chat\.[0-9a-f-]{36}$/);
    expect(statSync(dirname(handle)).mode & 0o777).toBe(0o700);
    expect(statSync(handle).mode & 0o777).toBe(0o600);
    expect(readFileSync(handle, 'utf8')).not.toMatch(/SECRET|API_KEY/);
    expect(client.calls.slice(0, 3).every(call => call.operation === 'select')).toBe(true);
    expect((await verifyPhaseOwner(client, state)).id).toBe(state.userId);
  });
  it('resumes with exact same owner and preserves case data between fresh CLI processes', async () => {
    const { client, handle, state } = await fixture();
    client.data.tasks.push({ id: randomUUID(), user_id: state.userId, title: 'Keep case state' });
    for (let batch = 0; batch < 2; batch++) {
      const release = acquirePhase(handle, context);
      const token = beginPhaseBatch(handle, context);
      const result = childReservations(handle, token, 1);
      expect(result.status, result.stderr).toBe(0);
      endPhaseBatch(handle, context, token); release();
    }
    expect(readPhase(handle, context).spent).toBe(2);
    expect(await verifyPhaseOwner(client, readPhase(handle, context))).toMatchObject({ id: state.userId });
    expect(client.data.tasks[0].title).toBe('Keep case state');
    expect(client.calls.filter(call => call.operation === 'delete')).toHaveLength(0);
  });
  it('durably reserves every attempt across restarts, including embeddings and a crashed batch, never refunds', async () => {
    const { handle } = await fixture(3);
    let release = acquirePhase(handle, context), token = beginPhaseBatch(handle, context);
    expect(childReservations(handle, token, 2, true).status).toBe(7);
    expect(readPhase(handle, context)).toMatchObject({ spent: 2, requests: { chat: 1, embeddings: 1 } });
    endPhaseBatch(handle, context, token); release();
    release = acquirePhase(handle, context); token = beginPhaseBatch(handle, context);
    const blocked = childReservations(handle, token, 2);
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toContain('OpenRouter request cap reached');
    expect(readPhase(handle, context).spent).toBe(3);
    endPhaseBatch(handle, context, token); release();
  });
  it('enforces the durable phase cap in the existing preload before every mocked HTTP attempt', async () => {
    const { handle } = await fixture(2);
    const release = acquirePhase(handle, context), token = beginPhaseBatch(handle, context);
    const preload = resolve('scripts/dev/chat-request-preload.js');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      let calls = 0;
      globalThis.fetch = async () => { calls++; return new Response('{}', { status: 429 }); };
      process.argv[1] = ${JSON.stringify(resolve('scripts/dev/interactive-chat.js'))};
      await import(${JSON.stringify(preload)});
      for (const endpoint of ['chat/completions', 'embeddings', 'chat/completions']) {
        try { await fetch('https://openrouter.ai/api/v1/' + endpoint, { method: 'POST', body: '{}' }); }
        catch (error) { if (!error.message.includes('cap reached')) throw error; }
      }
      console.log('MOCK_HTTP_CALLS=' + calls);
    `], { encoding: 'utf8', env: { PATH: process.env.PATH, SUPABASE_URL: context.database,
      HERMES_CHAT_PHASE_HANDLE: handle, HERMES_CHAT_PHASE_TOKEN: token,
      HERMES_CHAT_TEST_PHONE: readPhase(handle, context).phone, HERMES_CHAT_DISABLE_REMINDER_SCHEDULER: '1',
      HERMES_CHAT_OPENROUTER_REQUEST_LIMIT: '300' } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('MOCK_HTTP_CALLS=2');
    expect(result.stdout).toContain('HERMES_CHAT_OPENROUTER_REQUEST_COUNT=2');
    expect(readPhase(handle, context)).toMatchObject({ spent: 2, requests: { chat: 1, embeddings: 1 } });
    endPhaseBatch(handle, context, token); release();
  });
  it('refuses unproven, closed, wrong-repository/database and unsafe file handles before DB writes', async () => {
    const { client, handle } = await fixture();
    const before = client.calls.length;
    expect(() => readPhase(handle, { ...context, root: dirname(context.root) })).toThrow('wrong owner');
    expect(() => readPhase(handle, { ...context, database: 'https://other.invalid' })).toThrow('wrong owner');
    chmodSync(handle, 0o644);
    expect(() => acquirePhase(handle, context)).toThrow('unsafe private');
    chmodSync(handle, 0o600);
    const journal = resolve(dirname(handle), 'events.jsonl'), saved = readFileSync(journal, 'utf8');
    writeFileSync(journal, '{"type":"created"}\n');
    expect(() => acquirePhase(handle, context)).toThrow('missing creation proof');
    writeFileSync(journal, saved);
    expect(client.calls).toHaveLength(before);
    await finalizePhase(client, handle, context);
    const finalizedCalls = client.calls.length;
    await expect(finalizePhase(client, handle, context)).rejects.toThrow('already finalized');
    expect(client.calls).toHaveLength(finalizedCalls);
  });
  it('rejects symlinks, fake supplied IDs and a truncated spending receipt', async () => {
    const { handle } = await fixture();
    const link = resolve(dirname(handle), 'alias.json');
    symlinkSync(handle, link);
    expect(() => readPhase(link, context)).toThrow('generated phase');
    const saved = readFileSync(handle, 'utf8'), manifest = JSON.parse(saved);
    writeFileSync(handle, JSON.stringify({ ...manifest, userId: randomUUID() }));
    expect(() => readPhase(handle, context)).toThrow('creation proof');
    writeFileSync(handle, saved);
    appendFileSync(resolve(dirname(handle), 'events.jsonl'), '{"type":"request"');
    expect(() => acquirePhase(handle, context)).toThrow('interrupted receipt');
  });
  it('refuses identity mismatch and concurrent writer/finalization with no cleanup writes', async () => {
    const { client, handle, state } = await fixture();
    client.data.users[0].phone_number = 'foreign';
    await expect(verifyPhaseOwner(client, state)).rejects.toThrow('identity mismatch');
    await expect(finalizePhase(client, handle, context)).rejects.toThrow('cleanup identity mismatch');
    client.data.users[0].phone_number = state.phone;
    const release = acquirePhase(handle, context);
    expect(() => acquirePhase(handle, context)).toThrow('writer or owned child still active');
    await expect(finalizePhase(client, handle, context)).rejects.toThrow('writer or owned child still active');
    expect(client.calls.some(call => call.operation === 'delete')).toBe(false);
    release();
  });
  it('never adopts or signals an active child receipt even after writer lock is removed', async () => {
    const { client, handle } = await fixture();
    const release = acquirePhase(handle, context), token = beginPhaseBatch(handle, context);
    appendFileSync(resolve(dirname(handle), 'events.jsonl'), `${JSON.stringify({ type: 'child', token, pid: process.pid })}\n`);
    expect(() => endPhaseBatch(handle, context, token)).toThrow('child still active');
    release();
    await expect(finalizePhase(client, handle, context)).rejects.toThrow('owned process still active');
    expect(client.calls.some(call => call.operation === 'delete')).toBe(false);
  });
  it('finalizes owned rows once with fourteen actual zero readbacks, leaving foreign data intact', async () => {
    const { client, handle, state } = await fixture();
    const foreign = randomUUID(), run = randomUUID();
    for (const table of ownerTables) client.data[table].push({ id: table === 'agent_runs' ? run : randomUUID(), user_id: state.userId }, { id: randomUUID(), user_id: foreign });
    client.data.messages[0].phone_number = state.phone;
    client.data.prepared_actions.push({ id: randomUUID(), run_id: run });
    client.data.hermes_inbound_turns.push({ id: randomUUID(), thread_id: state.phone });
    const receipt = await finalizePhase(client, handle, context);
    expect(Object.keys(receipt.checks).filter(key => !key.startsWith('prepared_actions:'))).toHaveLength(14);
    expect(Object.values(receipt.checks).every(count => count === 0)).toBe(true);
    expect(readPhase(handle, context).closed).toBe(true);
    for (const table of ownerTables) expect(client.data[table]).toHaveLength(1);
    expect(client.calls.filter(call => call.operation === 'delete').every(call =>
      call.value === state.userId || call.value === state.phone || call.value === run)).toBe(true);
  });
  it('recovers an interrupted writer only after its recorded PID has stopped, without signaling it', async () => {
    const { client, handle } = await fixture();
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { acquirePhase, beginPhaseBatch } from ${JSON.stringify(resolve('scripts/dev/chat-validation-session.js'))};
      const [handle, root, database] = process.argv.slice(1);
      const context = { root, database };
      acquirePhase(handle, context); beginPhaseBatch(handle, context);
    `, handle, context.root, context.database], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    expect(result.status, result.stderr).toBe(0);
    expect((await finalizePhase(client, handle, context)).spent).toBe(0);
    expect(readPhase(handle, context).closed).toBe(true);
  });
  it('retains the full handle and run proofs after cleanup readback failures and permits safe explicit retry', async () => {
    const { client, handle, state } = await fixture();
    const runId = randomUUID();
    client.data.agent_runs.push({ id: runId, user_id: state.userId });
    client.data.prepared_actions.push({ id: randomUUID(), run_id: runId });
    let failOnce = true;
    client.fail(call => call.table === 'tasks' && call.operation === 'select' && failOnce && (failOnce = false, true));
    await expect(finalizePhase(client, handle, context)).rejects.toThrow('readback failed');
    expect(readPhase(handle, context)).toMatchObject({ closed: false, finalizing: true, cleanupRunIds: [runId] });
    await expect(verifyPhaseOwner(client, readPhase(handle, context))).rejects.toThrow('not active');
    const receipt = await finalizePhase(client, handle, context);
    expect(receipt.checks.tasks).toBe(0);
    expect(receipt.checks[`prepared_actions:${runId}`]).toBe(0);
  });
  it('captures a strict rescue identity and cleans up on a lost creation receipt', async () => {
    const client = database();
    const realFrom = client.from;
    client.from = table => {
      const query = realFrom(table), insert = query.insert;
      query.insert = payload => { insert(payload); const then = query.then; query.then = (accept, reject) => then(() => accept({ data: null, error: new Error('lost receipt') }), reject); return query; };
      return query;
    };
    try { await createPhase(client, context); throw new Error('expected failure'); }
    catch (error) {
      expect(error.message).toContain('owned cleanup verified');
      const handle = error.message.match(/handle=([^;]+)/)[1]; directories.push(dirname(handle));
      expect(error.message).toContain('userId=');
      expect(client.data.users).toHaveLength(0);
      expect(readPhase(handle, context).created).toBe(false);
    }
  });
  it.each([-1, 301, NaN, 1.5])('refuses invalid phase cap %s before any query', async cap => {
    const client = database();
    await expect(createPhase(client, context, cap)).rejects.toThrow('cap must');
    expect(client.calls).toHaveLength(0);
  });
});

describe('phase-only SDK transport ownership', () => {
  const state = { userId: randomUUID(), phone: `hermes-chat.${randomUUID()}` };
  const url = table => `${context.database}/rest/v1/${table}`;
  const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  it('adds strict tenant predicates to legacy ID-only reads/updates without changing the body', async () => {
    const fetch = vi.fn(async () => response([]));
    const body = JSON.stringify({ status: 'done' });
    await guardPhaseDatabaseRequest(`${url('tasks')}?id=eq.${randomUUID()}`, { method: 'PATCH', body }, state, fetch, context.database);
    const request = fetch.mock.calls[0][0];
    expect(new URL(request.url).searchParams.get('user_id')).toBe(`eq.${state.userId}`);
    expect(await request.text()).toBe(body);
  });
  it.each([
    ['tasks', { method: 'POST', body: JSON.stringify({ user_id: 'foreign' }) }],
    ['tasks', { method: 'POST', body: '{}' }],
    ['users', { method: 'POST', body: JSON.stringify({ id: state.userId }) }],
    ['subscriptions', { method: 'POST', body: '{}' }],
    ['user_integrations', { method: 'DELETE' }],
    ['rpc/match_memories', { method: 'POST', body: JSON.stringify({ p_user_id: 'foreign' }) }],
    ['prepared_actions', { method: 'POST', body: '{}' }],
    ['rpc/merge_entities', { method: 'POST', body: '{}' }],
  ])('blocks foreign/missing owner or side effects on %s before I/O', async (table, init) => {
    const fetch = vi.fn();
    await expect(guardPhaseDatabaseRequest(url(table), init, state, fetch, context.database)).rejects.toThrow('Chat phase');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects wrong tenant predicates and DB targets before I/O', async () => {
    const fetch = vi.fn();
    await expect(guardPhaseDatabaseRequest(`${url('tasks')}?user_id=eq.foreign`, {}, state, fetch, context.database)).rejects.toThrow('foreign');
    await expect(guardPhaseDatabaseRequest('https://foreign.invalid/rest/v1/tasks', {}, state, fetch, context.database)).rejects.toThrow('wrong database');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('checks prepared-action run/target foreign keys before mutation and refuses foreign IDs', async () => {
    const run = randomUUID(), task = randomUUID();
    const fetch = vi.fn(async request => {
      const u = new URL(request instanceof Request ? request.url : request);
      return response(u.searchParams.has('id') ? [{ id: u.searchParams.get('id').slice(3) }] : []);
    });
    await guardPhaseDatabaseRequest(url('prepared_actions'), { method: 'POST', body: JSON.stringify({ run_id: run, target_id: task, domain: 'task' }) }, state, fetch, context.database);
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [request] of fetch.mock.calls.slice(0, 2)) expect(new URL(request).searchParams.get('user_id')).toBe(`eq.${state.userId}`);
    fetch.mockReset().mockResolvedValue(response([]));
    await expect(guardPhaseDatabaseRequest(url('prepared_actions'), { method: 'POST', body: JSON.stringify({ run_id: run }) }, state, fetch, context.database)).rejects.toThrow('unowned foreign key');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('refuses an upsert whose supplied ID already belongs to a foreign tenant', async () => {
    const fetch = vi.fn(async () => response([{ id: randomUUID(), user_id: 'foreign' }]));
    await expect(guardPhaseDatabaseRequest(url('tasks'), { method: 'POST', body: JSON.stringify({ id: randomUUID(), user_id: state.userId }) }, state, fetch, context.database)).rejects.toThrow('foreign upsert');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('preserves owner-bound memory RPC and blocks foreign body phone changes', async () => {
    const fetch = vi.fn(async () => response([]));
    const init = { method: 'POST', body: JSON.stringify({ p_user_id: state.userId, p_query_embedding: [1, 2] }) };
    await guardPhaseDatabaseRequest(url('rpc/match_memories'), init, state, fetch, context.database);
    expect(await fetch.mock.calls[0][0].text()).toBe(init.body);
    await expect(guardPhaseDatabaseRequest(url('users'), { method: 'PATCH', body: JSON.stringify({ phone_number: 'foreign' }) }, state, fetch, context.database)).rejects.toThrow('foreign body phone');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

it('uses the existing runner with fresh-process resume, three-second pacing, exact next-prompt wait and private reports', () => {
  const runner = readFileSync(resolve('scripts/dev/run-chat-validation.js'), 'utf8');
  const cli = readFileSync(resolve('scripts/dev/interactive-chat.js'), 'utf8');
  const preload = readFileSync(resolve('scripts/dev/chat-request-preload.js'), 'utf8');
  expect(runner).toContain("phaseState ? ['scripts/dev/interactive-chat.js'] : ['run', 'chat']");
  expect(runner).toContain('setTimeout(done, 3000)');
  expect(runner).toContain('buffer.indexOf(prompt, cursor)');
  expect(runner).toContain('responseWaitMs: Date.now() - start');
  expect(runner).toContain("flag: 'wx', mode: 0o600");
  expect(cli).toContain('const user = phaseUser ?? await getOrCreateUserByPhone(testPhone)');
  expect(cli).toContain('!user.is_new');
  expect(preload.indexOf('reservePhaseRequest(phaseHandle')).toBeLessThan(preload.indexOf('providerRequests++'));
});

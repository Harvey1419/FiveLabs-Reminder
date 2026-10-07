// Private, dev-only ownership receipts. No app imports, keys, or provider configuration.
import { randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, readFileSync, writeSync, fsyncSync, lstatSync,
  realpathSync, mkdtempSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, basename } from 'node:path';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ownerTables = ['tasks', 'memories', 'projects', 'reminders', 'entities', 'agent_runs',
  'agent_execution_events', 'messages', 'user_integrations', 'subscriptions'];
const fail = message => { throw new Error(`Chat phase: ${message}`); };
const databaseIdentity = value => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail('unsafe database target');
  return url.href.replace(/\/$/, '');
};
function privateFile(path, directory = false) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600) ||
      realpathSync(path) !== path || stat.size > 1024 * 1024) fail('unsafe private receipt');
}
function writePrivate(path, content, exclusive = false) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW |
    (exclusive ? constants.O_CREAT | constants.O_EXCL : constants.O_APPEND), 0o600);
  try {
    const bytes = Buffer.from(content);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (!written) fail('incomplete receipt write');
      offset += written;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
}
function append(handle, event) {
  privateFile(resolve(dirname(handle), 'events.jsonl'));
  writePrivate(resolve(dirname(handle), 'events.jsonl'), `${JSON.stringify(event)}\n`);
}
export function processActive(pid, group = false) {
  if (!Number.isSafeInteger(pid) || pid <= 0) fail('invalid process receipt');
  try { process.kill(group ? -pid : pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
export function readPhase(handle, { root, database }) {
  handle = resolve(handle);
  const directory = dirname(handle);
  if (dirname(directory) !== realpathSync(tmpdir()) || basename(handle) !== 'phase.json' ||
      !/^hermes-chat-phase-[0-9a-f-]{36}-[A-Za-z0-9]+$/.test(basename(directory))) fail('not a generated phase handle');
  privateFile(directory, true); privateFile(handle);
  const state = JSON.parse(readFileSync(handle, 'utf8'));
  if (state.version !== 1 || !uuid.test(state.id) || !uuid.test(state.userId) ||
      state.phone !== `hermes-chat.${state.id}` || !basename(directory).startsWith(`hermes-chat-phase-${state.id}-`) ||
      state.root !== realpathSync(root) || state.database !== databaseIdentity(database) ||
      !Number.isSafeInteger(state.cap) || state.cap < 0 || state.cap > 300) fail('wrong owner, repository, database, or budget');
  const journal = resolve(directory, 'events.jsonl'); privateFile(journal);
  const text = readFileSync(journal, 'utf8');
  if (!text.endsWith('\n')) fail('interrupted receipt; manual recovery required');
  const events = text.trimEnd().split('\n').map(line => JSON.parse(line));
  if (events[0]?.type !== 'absence' || ['id', 'userId', 'phone', 'root', 'database', 'cap'].some(key =>
      events[0][key] !== state[key])) fail('missing creation proof');
  state.created = events.some(event => event.type === 'created' && event.userId === state.userId && event.phone === state.phone);
  state.closed = events.some(event => event.type === 'finalized');
  state.finalizing = events.some(event => event.type === 'finalizing');
  state.cleanupRunIds = [...new Set(events.filter(event => event.type === 'finalizing').flatMap(event => event.runIds))];
  if (!state.cleanupRunIds.every(id => uuid.test(id))) fail('invalid cleanup run proof');
  state.spent = events.filter(event => event.type === 'request').length;
  state.requests = Object.fromEntries(['chat', 'embeddings'].map(kind => [kind,
    events.filter(event => event.type === 'request' && event.kind === kind).length]));
  if (state.spent > state.cap) fail('invalid spending receipt');
  state.lease = null;
  for (const event of events) {
    if (event.type === 'begin') state.lease = event;
    if (event.type === 'child' && state.lease?.token === event.token) state.lease.childPid = event.pid;
    if (event.type === 'end' && state.lease?.token === event.token) state.lease = null;
  }
  return state;
}
async function rows(client, table, column, value, select = 'id') {
  const { data, error } = await client.from(table).select(select).eq(column, value);
  if (error || !Array.isArray(data)) fail(`readback failed: ${table}`);
  return data;
}
async function remove(client, table, column, value) {
  const { error } = await client.from(table).delete().eq(column, value);
  if (error) fail(`cleanup failed: ${table}`);
}
export async function verifyPhaseOwner(client, state) {
  if (!state.created || state.closed || state.finalizing) fail('phase is not active');
  const byPhone = await rows(client, 'users', 'phone_number', state.phone, '*');
  const byId = await rows(client, 'users', 'id', state.userId, '*');
  if (byPhone.length !== 1 || byId.length !== 1 || byPhone[0].id !== state.userId ||
      byId[0].phone_number !== state.phone) fail('exact identity mismatch');
  return byId[0];
}
export async function createPhase(client, context, cap = 300) {
  if (!Number.isSafeInteger(cap) || cap < 0 || cap > 300) fail('cap must be 0..300');
  const id = randomUUID(), userId = randomUUID(), phone = `hermes-chat.${id}`;
  // Reserve an explicit ID, so even a lost insert response has a strict rescue identity.
  for (const table of ['users', 'messages']) if ((await rows(client, table, 'phone_number', phone)).length) fail('fresh phone collision');
  if ((await rows(client, 'users', 'id', userId)).length) fail('fresh ID collision');
  const directory = mkdtempSync(resolve(realpathSync(tmpdir()), `hermes-chat-phase-${id}-`));
  const handle = resolve(directory, 'phase.json');
  const state = { version: 1, id, userId, phone, root: realpathSync(context.root), database: databaseIdentity(context.database), cap };
  writePrivate(handle, JSON.stringify(state), true);
  writePrivate(resolve(directory, 'events.jsonl'), `${JSON.stringify({ type: 'absence', ...state })}\n`, true);
  let release;
  try {
    release = acquirePhase(handle, context);
    const { data, error } = await client.from('users').insert({ id: userId, phone_number: phone,
      timezone: 'America/Bogota', locale: 'es-CO' }).select('id,phone_number').single();
    if (error || data?.id !== userId || data?.phone_number !== phone) fail('creation receipt mismatch');
    append(handle, { type: 'created', userId, phone });
    await verifyPhaseOwner(client, readPhase(handle, context));
  } catch (error) {
    // A receipt/IO failure must not lose the identity or authorize broad deletion.
    let rescue = 'cleanup pending';
    try { await cleanupPhaseOwner(client, { ...state, created: false }); rescue = 'owned cleanup verified'; }
    catch { /* Retain handle and exact rescue identity for explicit finalization. */ }
    throw new Error(`Chat phase creation failed; handle=${handle}; userId=${userId}; phone=${phone}; ${rescue}`);
  } finally {
    try { release?.(); } catch { throw new Error(`Chat phase lock release failed; handle=${handle}; userId=${userId}; phone=${phone}`); }
  }
  return handle;
}
export function acquirePhase(handle, context) {
  const state = readPhase(handle, context);
  if (state.closed) fail('phase already finalized');
  const path = resolve(dirname(handle), 'lock.json');
  const token = randomUUID();
  try { writePrivate(path, JSON.stringify({ pid: process.pid, token }), true); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    privateFile(path);
    const previous = JSON.parse(readFileSync(path, 'utf8'));
    // Never signal an old PID. PID reuse conservatively blocks recovery.
    if (processActive(previous.pid) || (state.lease?.childPid &&
        (processActive(state.lease.childPid) || processActive(state.lease.childPid, true)))) fail('phase writer or owned child still active');
    // Serialize stale-lock recovery itself. An abandoned recovery receipt
    // intentionally requires manual intervention, not a competing unlink.
    const recovery = resolve(dirname(handle), 'recovery.json');
    writePrivate(recovery, JSON.stringify({ pid: process.pid, token }), true);
    try {
      privateFile(path);
      if (JSON.parse(readFileSync(path, 'utf8')).token !== previous.token) fail('concurrent phase recovery');
      unlinkSync(path);
      writePrivate(path, JSON.stringify({ pid: process.pid, token }), true);
    } finally { unlinkSync(recovery); }
  }
  if (state.lease) {
    if (state.lease.childPid && (processActive(state.lease.childPid) || processActive(state.lease.childPid, true))) {
      unlinkSync(path); fail('owned process still active');
    }
    if (processActive(state.lease.pid)) { unlinkSync(path); fail('phase batch writer still active'); }
    append(handle, { type: 'end', token: state.lease.token, interrupted: true });
  }
  return () => {
    privateFile(path);
    if (JSON.parse(readFileSync(path, 'utf8')).token !== token) fail('lock ownership changed');
    unlinkSync(path);
  };
}
export function beginPhaseBatch(handle, context) {
  const state = readPhase(handle, context);
  privateFile(resolve(dirname(handle), 'lock.json'));
  const lock = JSON.parse(readFileSync(resolve(dirname(handle), 'lock.json'), 'utf8'));
  if (lock.pid !== process.pid || state.lease || state.closed || state.finalizing || !state.created) fail('batch not owned');
  const token = randomUUID();
  append(handle, { type: 'begin', token, pid: process.pid });
  return token;
}
export function phaseChildProof(handle, context, token, { register = false } = {}) {
  const state = readPhase(handle, context);
  privateFile(resolve(dirname(handle), 'lock.json'));
  const lock = JSON.parse(readFileSync(resolve(dirname(handle), 'lock.json'), 'utf8'));
  if (!state.created || state.closed || state.finalizing || state.lease?.token !== token || lock.pid !== state.lease.pid ||
      !processActive(lock.pid) || state.lease.pid !== process.ppid ||
      (state.lease.childPid && state.lease.childPid !== process.pid)) fail('invalid parent-owned child proof');
  if (register && !state.lease.childPid) append(handle, { type: 'child', token, pid: process.pid });
  if (!register && state.lease.childPid !== process.pid) fail('child was not registered');
  return state;
}
export function reservePhaseRequest(handle, context, token, kind = 'chat') {
  const state = phaseChildProof(handle, context, token);
  if (state.spent >= state.cap) fail('OpenRouter request cap reached');
  // Synchronous durable reservation BEFORE I/O; crashes and HTTP errors never refund.
  if (!['chat', 'embeddings'].includes(kind)) fail('invalid request kind');
  append(handle, { type: 'request', token, kind });
  return state.spent + 1;
}
export function endPhaseBatch(handle, context, token) {
  const state = readPhase(handle, context);
  if (state.lease?.token !== token || state.lease.pid !== process.pid) fail('batch receipt mismatch');
  if (state.lease.childPid && (processActive(state.lease.childPid) || processActive(state.lease.childPid, true))) fail('child still active');
  append(handle, { type: 'end', token });
}
async function cleanupPhaseOwner(client, state, recordRuns = () => {}) {
  const phones = await rows(client, 'users', 'phone_number', state.phone, 'id,phone_number');
  const ids = await rows(client, 'users', 'id', state.userId, 'id,phone_number');
  if (phones.some(row => row.id !== state.userId) || ids.some(row => row.phone_number !== state.phone) ||
      phones.length > 1 || ids.length > 1 || phones.length !== ids.length) fail('cleanup identity mismatch');
  // Missing owner after an interrupted cleanup is safe only under the original absence receipt.
  const runs = await rows(client, 'agent_runs', 'user_id', state.userId);
  const runIds = [...new Set([...(state.cleanupRunIds ?? []), ...runs.map(row => row.id)])];
  recordRuns(runIds);
  for (const runId of runIds) await remove(client, 'prepared_actions', 'run_id', runId);
  // Keep runs until prepared-action zero readbacks, so interrupted cleanup
  // retains the foreign-key ownership evidence needed by the next attempt.
  for (const table of ['agent_execution_events', 'reminders', 'tasks', 'memories', 'entities', 'projects',
    'messages', 'user_integrations', 'subscriptions']) await remove(client, table, 'user_id', state.userId);
  await remove(client, 'messages', 'phone_number', state.phone);
  await remove(client, 'hermes_inbound_turns', 'thread_id', state.phone);
  const checks = {};
  for (const runId of runIds) checks[`prepared_actions:${runId}`] = (await rows(client, 'prepared_actions', 'run_id', runId)).length;
  if (Object.values(checks).some(Boolean)) fail('prepared action residue');
  await remove(client, 'agent_runs', 'user_id', state.userId);
  await remove(client, 'users', 'id', state.userId);
  for (const table of ownerTables) checks[table] = (await rows(client, table, 'user_id', state.userId)).length;
  checks.users = (await rows(client, 'users', 'id', state.userId)).length;
  checks.hermes_inbound_turns = (await rows(client, 'hermes_inbound_turns', 'thread_id', state.phone)).length;
  checks.messagesPhone = (await rows(client, 'messages', 'phone_number', state.phone)).length;
  checks.usersPhone = (await rows(client, 'users', 'phone_number', state.phone)).length;
  if (Object.values(checks).some(Boolean)) fail('cleanup residue');
  return checks;
}
export async function finalizePhase(client, handle, context) {
  const release = acquirePhase(handle, context);
  try {
    const state = readPhase(handle, context);
    const checks = await cleanupPhaseOwner(client, state, runIds => append(handle, { type: 'finalizing', runIds }));
    append(handle, { type: 'finalized', checks, spent: state.spent });
    return { handle, userId: state.userId, spent: state.spent, requests: state.requests, checks };
  } finally { release(); }
}

// Constrain the existing SDK transport, not production schemas or query code.
// Owner predicates are added even to legacy ID-only reads/updates. Body owners
// and foreign keys are verified before any mutation (including upsert conflicts).
export async function guardPhaseDatabaseRequest(input, init, state, fetchImpl, database) {
  const request = new Request(input, init);
  const url = new URL(request.url), method = request.method;
  // SDK .single() headers belong to the mutation, not array-shaped owner checks.
  const verificationHeaders = new Headers(request.headers);
  verificationHeaders.set('Accept', 'application/json');
  const base = `${databaseIdentity(database)}/rest/v1/`;
  if (!url.href.startsWith(base)) fail('wrong database request');
  const table = url.pathname.slice(new URL(base).pathname.length);
  let body;
  if (!['GET', 'HEAD', 'DELETE'].includes(method)) body = JSON.parse(await request.clone().text());
  if (table === 'rpc/match_memories' && method === 'POST') {
    if (body?.p_user_id !== state.userId) fail('foreign memory RPC');
    return fetchImpl(request);
  }
  if (!['users', 'prepared_actions', ...ownerTables].includes(table)) fail('unsupported phase resource');
  if (!['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'].includes(method)) fail('unsupported phase method');
  if (['subscriptions', 'user_integrations'].includes(table) && !['GET', 'HEAD'].includes(method)) fail('side-effect resource');
  const exact = (column, value) => {
    const existing = url.searchParams.getAll(column);
    if (existing.length && (existing.length !== 1 || existing[0] !== `eq.${value}`)) fail(`foreign ${column} predicate`);
    url.searchParams.set(column, `eq.${value}`);
  };
  async function ownedForeign(target, id) {
    if (!uuid.test(id)) fail('invalid foreign key');
    const check = new URL(`${base}${target}`);
    check.searchParams.set('select', 'id'); check.searchParams.set('id', `eq.${id}`);
    check.searchParams.set('user_id', `eq.${state.userId}`);
    const response = await fetchImpl(check, { headers: verificationHeaders });
    const result = await response.json();
    if (!response.ok || !Array.isArray(result) || result.length !== 1 || result[0].id !== id) fail('unowned foreign key');
  }
  if (table === 'users') { exact('id', state.userId); exact('phone_number', state.phone); }
  else if (table === 'prepared_actions') {
    const run = url.searchParams.get('run_id');
    if (method !== 'POST') {
      if (!run?.startsWith('eq.')) fail('missing prepared action run');
      await ownedForeign('agent_runs', run.slice(3));
    }
  } else exact('user_id', state.userId);
  const conflict = url.searchParams.get('on_conflict');
  if (conflict && conflict !== 'id' && !conflict.split(',').includes(table === 'prepared_actions' ? 'run_id' : 'user_id')) fail('unscoped upsert conflict');
  const values = body === undefined ? [] : Array.isArray(body) ? body : [body];
  for (const value of values) {
    if (!value || typeof value !== 'object') fail('invalid request body');
    if ('user_id' in value && value.user_id !== state.userId) fail('foreign body owner');
    if ('phone_number' in value && value.phone_number !== state.phone) fail('foreign body phone');
    if (table === 'users' && (method === 'POST' || ('id' in value && value.id !== state.userId))) fail('user adoption or ID change');
    if (method === 'POST' && table !== 'prepared_actions' && value.user_id !== state.userId) fail('missing insert owner');
    // An upsert by supplied ID must not overwrite another tenant's row.
    if (value.id && table !== 'users') {
      if (table === 'prepared_actions') fail('supplied prepared-action ID');
      const check = new URL(`${base}${table}`); check.searchParams.set('select', 'id,user_id'); check.searchParams.set('id', `eq.${value.id}`);
      const response = await fetchImpl(check, { headers: verificationHeaders }); const result = await response.json();
      if (!response.ok || !Array.isArray(result) || result.some(row => row.user_id !== state.userId)) fail('foreign upsert ID');
    }
    for (const [key, target] of Object.entries({ run_id: 'agent_runs', project_id: 'projects', entity_id: 'entities', task_id: 'tasks', reminder_id: 'reminders', superseded_by: 'memories', parent_reminder_id: 'reminders' })) {
      if (value[key] != null) await ownedForeign(target, value[key]);
    }
    if (table === 'prepared_actions' && method === 'POST' && !value.run_id) fail('missing prepared action owner');
    if (table === 'prepared_actions' && value.target_id != null) {
      const target = { task: 'tasks', reminder: 'reminders', project: 'projects', entity: 'entities', memory: 'memories' }[value.domain];
      if (!target) fail('unknown prepared-action target');
      await ownedForeign(target, value.target_id);
    }
  }
  return fetchImpl(new Request(url, request));
}

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, mkdtemp, realpath, lstat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { supabase } from '../../src/infrastructure/database/index.js';
import { normalizeUserPhone } from '../../src/infrastructure/database/users.js';
import { CHAT_VALIDATION_SCENARIOS, getValidationTurns } from './chat-validation-scenarios.js';
import { createPhase, readPhase, acquirePhase, verifyPhaseOwner, beginPhaseBatch,
  endPhaseBatch, finalizePhase } from './chat-validation-session.js';

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { PhaseClient, PhaseState } from './chat-validation-session.js';
type DevRow = { id: string; phone_number?: string; title?: string; description?: string | null; status?: string; [key: string]: unknown };
type DevQuery = PromiseLike<{ data: DevRow[] | null; error: { message?: string } | null }> & { eq(column: string, value: unknown): DevQuery };
type DevClient = { from(table: string): { select(columns: string): DevQuery; delete(): DevQuery } };
type Facts = Record<string, DevRow[]> & { tasks: DevRow[]; subscriptions: DevRow[] };
type Turn = { number: number; prompt: string | undefined; response: string; pauseMs: number; responsePromptAt: number; responseWaitMs: number; durationMs: number; facts?: Facts; manualReview?: string };
type Report = { phone: string; normalizedPhone: string; userId: string | null; requestLimit: number | null; scenario: string; requestedTurns: number; completedTurns: number; providerRequests: number | null; turns: Turn[]; errors: string[]; findings: string[]; cleanup: Record<string, number>; status: string; preflightPassed?: boolean; providerTrace?: { directory: string; complete: boolean; missing?: string }; providerRequestKinds?: Record<string, number>; phaseHandle?: string; cleanupDeferred?: string; cleanupVerified?: boolean };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const phaseMode = args[0] === '--phase' ? args[1] : null;
const phaseHandle = args[2]!;
const context = { root, database: process.env.SUPABASE_URL };
if (args.length && (!['create', 'run', 'finalize'].includes(phaseMode!) ||
    args.length !== (phaseMode === 'create' ? 2 : 3))) {
  throw new Error('Usage: --phase create | --phase run <handle> | --phase finalize <handle>');
}
if (phaseMode === 'create' || phaseMode === 'finalize') {
  const result = phaseMode === 'create'
    ? { handle: await createPhase(supabase as unknown as PhaseClient, context, Number(process.env.HERMES_CHAT_OPENROUTER_REQUEST_LIMIT ?? '300')) }
    : await finalizePhase(supabase as unknown as PhaseClient, phaseHandle, context);
  console.log(JSON.stringify(result));
  process.exit(0);
}
let phaseState: PhaseState | undefined, releasePhase: (() => void) | undefined, batchToken: string | undefined;
if (phaseMode === 'run') {
  // Lock before any DB access. The retained handle is also the rescue identity.
  releasePhase = acquirePhase(phaseHandle, context);
  try { phaseState = readPhase(phaseHandle, context); await verifyPhaseOwner(supabase as unknown as PhaseClient, phaseState); }
  catch (error) { releasePhase(); throw error; }
}
const phone = phaseState?.phone ?? `hermes-chat.${randomUUID()}`;
const normalized = normalizeUserPhone(phone);
const requestLimitValue = process.env.HERMES_CHAT_OPENROUTER_REQUEST_LIMIT ?? '70';
const reportName = process.env.HERMES_CHAT_REPORT_NAME ?? 'chat-validation-round1.json';
const scenario = process.env.HERMES_CHAT_SCENARIO ?? 'full';
const traceOptIn = process.env.HERMES_CHAT_PROVIDER_TRACE ?? '0';
let traceDirectory: string | null = null;
const requestLimit = /^(0|[1-9]\d*)$/.test(requestLimitValue) && Number(requestLimitValue) <= 300
  ? Number(requestLimitValue) : null;
const validReportName = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(reportName) && !reportName.startsWith('..');
const reportPath = phaseState ? resolve(dirname(phaseHandle), `batch-${randomUUID()}.json`)
  : resolve(root, 'scratch', validReportName ? reportName : 'chat-validation-round1.json');
// Validation below still rejects unknown names before any identity preflight.
const turns = getValidationTurns(CHAT_VALIDATION_SCENARIOS.includes(scenario) ? scenario : 'full');
const report: Report = { phone, normalizedPhone: normalized, userId: phaseState?.userId ?? null, requestLimit: phaseState?.cap ?? requestLimit, scenario, requestedTurns: turns.length, completedTurns: 0, providerRequests: null, turns: [], errors: [], findings: [], cleanup: {}, status: 'interrupted' };
let child: ChildProcessWithoutNullStreams | undefined;
let buffer = '', cursor = 0, closed = false, leaderExited = false;
let exitCode: number | null | undefined, wake: (() => void) | null | undefined, abortSignal: boolean | undefined;
const onInterrupt = () => { abortSignal = true; wake?.(); };
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onInterrupt);
const stdoutDecoder = new StringDecoder('utf8');
const stderrDecoder = new StringDecoder('utf8');
const prompt = '\n👤 Tú: ';
const representations = [...new Set([phone, normalized])];
const tables = ['tasks', 'memories', 'projects', 'reminders', 'entities', 'agent_runs', 'agent_execution_events',
  'messages', 'user_integrations', 'subscriptions'];
async function rows(table: string, column: string, value: unknown, select = 'id') {
  const { data, error } = await (supabase as unknown as DevClient).from(table).select(select).eq(column, value);
  if (error || !data) throw new Error(`${table}.${column}: ${error?.message || 'missing data'}`);
  return data;
}
async function deleteRows(table: string, column: string, value: unknown) {
  const { error } = await (supabase as unknown as DevClient).from(table).delete().eq(column, value);
  if (error) throw new Error(`delete ${table}: ${(error as Error).message}`);
}
function waitFor<T>(predicate: () => T | undefined, ms = 90000) {
  return new Promise<T>((accept, reject) => {
    const timeout = setTimeout(() => { wake = null; reject(new Error(`Timed out waiting for ${predicate.name || 'CLI output'}`)); }, ms);
    const check = () => {
      try {
        if (abortSignal) throw new Error('Validation interrupted; finalizing owned process before retaining phase');
        const result = predicate();
        if (result !== undefined) { clearTimeout(timeout); wake = null; accept(result); }
        else if (closed) { clearTimeout(timeout); wake = null; reject(new Error(`Chat exited (${exitCode}) before next prompt`)); }
      } catch (error) { clearTimeout(timeout); wake = null; reject(error); }
    };
    wake = check;
    check();
  });
}
function receive(chunk: Buffer, decoder: StringDecoder) {
  buffer += decoder.write(chunk);
  if (buffer.length > 200000) {
    const removed = buffer.length - 100000;
    buffer = buffer.slice(removed); cursor = Math.max(0, cursor - removed);
  }
  wake?.();
}
async function facts() {
  // Readback evidence only, never injected as answering data. Scope to the
  // already verified synthetic owner; omit credentials/contact identifiers.
  const result = { userProfile: await rows('users', 'id', report.userId, 'id, display_name, timezone, locale') } as unknown as Facts;
  for (const table of ['tasks', 'memories', 'projects', 'reminders', 'agent_runs', 'agent_execution_events', 'subscriptions']) {
    result[table] = await rows(table, 'user_id', report.userId, '*');
  }
  return result;
}
async function cleanup() {
  // No deletion is authorized until the initial absence checks succeeded.
  if (!report.preflightPassed) return;
  let id = report.userId;
  const owned: DevRow[] = [];
  for (const representation of representations) owned.push(...await rows('users', 'phone_number', representation, 'id'));
  const ids = [...new Set(owned.map(row => row.id))];
  if (id && ids.some(found => found !== id)) throw new Error('Identity collision during cleanup');
  if (!id && ids.length === 1) id = ids[0]!;
  if (ids.length > 1) throw new Error('Multiple identities for synthetic phone');
  if (!id) {
    for (const representation of representations) {
      if ((await rows('messages', 'phone_number', representation)).length) throw new Error('Orphan messages: user ID unavailable');
    }
    return;
  }
  // Verify phone still belongs to exactly this run before deleting anything.
  if (ids.length !== 1 || ids[0] !== id) throw new Error('Owned user phone cannot be verified');
  report.userId = id;
  const runIds = (await rows('agent_runs', 'user_id', id)).map(row => row.id);
  for (const runId of runIds) {
    report.cleanup[`prepared_actions:${runId}`] = (await rows('prepared_actions', 'run_id', runId)).length;
    await deleteRows('prepared_actions', 'run_id', runId);
  }
  for (const table of ['agent_execution_events', 'agent_runs', 'reminders', 'tasks', 'memories', 'entities', 'projects',
    'messages', 'user_integrations', 'subscriptions']) {
    report.cleanup[table] = (await rows(table, 'user_id', id)).length;
    await deleteRows(table, 'user_id', id);
  }
  for (const representation of representations) {
    const count = (await rows('messages', 'phone_number', representation)).length;
    report.cleanup[`messages:${representation}`] = count;
    await deleteRows('messages', 'phone_number', representation);
  }
  report.cleanup.hermes_inbound_turns = (await rows('hermes_inbound_turns', 'thread_id', normalized)).length;
  await deleteRows('hermes_inbound_turns', 'thread_id', normalized);
  await deleteRows('users', 'id', id);
  for (const table of tables) {
    if ((await rows(table, 'user_id', id)).length) throw new Error(`Cleanup residue: ${table}`);
  }
  for (const runId of runIds) if ((await rows('prepared_actions', 'run_id', runId)).length) throw new Error('Prepared action residue');
  if ((await rows('users', 'id', id)).length || (await rows('hermes_inbound_turns', 'thread_id', normalized)).length) throw new Error('Identity/inbound residue');
  for (const representation of representations) {
    if ((await rows('messages', 'phone_number', representation)).length || (await rows('users', 'phone_number', representation)).length) throw new Error('Phone residue');
  }
}
function groupActive() {
  if (!child?.pid) return false;
  try { process.kill(-child!.pid!, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
function signalGroup(signal: NodeJS.Signals) {
  if (!groupActive()) return;
  if (leaderExited) throw new Error('Leader already exited; refusing to signal a potentially reused PID');
  try { process.kill(-child!.pid!, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}
async function shutdown() {
  if (!child) return;
  if (!closed && child.stdin.writable) child.stdin.write('/exit\n');
  const until = Date.now() + 4000;
  while (!closed && Date.now() < until) await new Promise(done => setTimeout(done, 50));
  // After leader close, never signal a possibly reused PID. Refuse cleanup if
  // any group still exists; a resumed process cannot kill unknown processes.
  if (leaderExited && groupActive()) throw new Error('Process group outlived leader; cleanup deferred');
  if (groupActive()) signalGroup('SIGTERM');
  const grace = Date.now() + 3000;
  while (groupActive() && Date.now() < grace) await new Promise(done => setTimeout(done, 50));
  if (groupActive()) signalGroup('SIGKILL');
  const deadline = Date.now() + 3000;
  while (groupActive() && Date.now() < deadline) await new Promise(done => setTimeout(done, 50));
  if (groupActive() || !closed) throw new Error('Chat process group did not stop; refusing to assume cleanup is safe');
}
try {
  if (!CHAT_VALIDATION_SCENARIOS.includes(scenario)) throw new Error(`Invalid HERMES_CHAT_SCENARIO: expected ${CHAT_VALIDATION_SCENARIOS.join(', ')}`);
  if (!['0', '1'].includes(traceOptIn)) throw new Error('Invalid HERMES_CHAT_PROVIDER_TRACE: expected 0 or 1');
  if (requestLimit === null) throw new Error('Invalid HERMES_CHAT_OPENROUTER_REQUEST_LIMIT: expected integer 0..300');
  if (!validReportName) throw new Error('Invalid HERMES_CHAT_REPORT_NAME: expected safe .json basename');
  if (normalized !== phone || !process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET) throw new Error('Unsafe identity or missing database configuration');
  if (!phaseState) {
    for (const representation of representations) for (const table of ['users', 'messages']) {
      if ((await rows(table, 'phone_number', representation)).length) throw new Error(`Preflight collision: ${table}`);
    }
  }
  report.preflightPassed = true;
  if (phaseState) batchToken = beginPhaseBatch(phaseHandle, context);
  if (traceOptIn === '1') {
    // Never accept a user-selected output path. mkdtemp creates a fresh 0700
    // directory under the canonical temporary root; evidence is retained.
    traceDirectory = await mkdtemp(resolve(await realpath(tmpdir()), `hermes-provider-trace-${phone}-`));
    report.providerTrace = { directory: traceDirectory, complete: false, missing: 'child_not_finalized' };
  }
  child = spawn(phaseState ? process.execPath : 'npm', phaseState ? ['scripts/dev/interactive-chat.ts'] : ['run', 'chat'], {
    cwd: root, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    env: { ...process.env, NODE_OPTIONS: '--import=tsx --import=./scripts/dev/chat-request-preload.ts', HERMES_CHAT_TEST_PHONE: phone,
      HERMES_CHAT_DISABLE_REMINDER_SCHEDULER: '1', HERMES_CHAT_OPENROUTER_REQUEST_LIMIT: String(phaseState?.cap ?? requestLimit),
      HERMES_CHAT_PHASE_HANDLE: phaseState ? resolve(phaseHandle) : '', HERMES_CHAT_PHASE_TOKEN: batchToken ?? '',
      // Override inherited trace configuration: the parent never opens a sink.
      HERMES_CHAT_PROVIDER_TRACE_DIR: traceDirectory || '' },
  });
  child.stdout.on('data', chunk => receive(chunk, stdoutDecoder));
  child.stderr.on('data', chunk => receive(chunk, stderrDecoder));
  child.on('error', error => { report.errors.push((error as Error).message); closed = true; wake?.(); });
  child.on('exit', () => { leaderExited = true; });
  child.on('close', code => { closed = true; exitCode = code; wake?.(); });
  const banner = await waitFor(function initialBanner() {
    const match = buffer.match(/Usuario de prueba activo:\s*([^\s]+)\s*\(ID:\s*([^,\s)]+)/);
    return match ? { phone: match[1]!, id: match[2]! } : undefined;
  });
  if (banner.phone !== normalized || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(banner.id)) throw new Error('Invalid identity banner');
  report.userId = banner.id;
  const owned = await rows('users', 'id', banner.id, 'phone_number');
  if (owned.length !== 1 || owned[0]!.phone_number !== normalized) throw new Error('Banner ownership mismatch');
  await waitFor(function firstPrompt() { const at = buffer.indexOf(prompt, cursor); if (at >= 0) { cursor = at + prompt.length; return true; } });
  for (let i = 0; i < turns.length; i++) {
    const pauseStart = Date.now();
    await new Promise(done => setTimeout(done, 3000));
    const pauseMs = Date.now() - pauseStart;
    if (abortSignal) throw new Error('Validation interrupted during pacing');
    if (closed || !child.stdin.writable) throw new Error('Chat stopped before paced input');
    const start = Date.now();
    child.stdin.write(`${turns[i]}\n`);
    const output = await waitFor(function nextPrompt() {
      const at = buffer.indexOf(prompt, cursor);
      if (at < 0) return undefined;
      const response = buffer.slice(cursor, at);
      cursor = at + prompt.length;
      return response;
    });
    const counts = [...output.matchAll(/HERMES_CHAT_OPENROUTER_REQUEST_COUNT=(\d+)/g)];
    if (counts.length) report.providerRequests = Math.max(report.providerRequests || 0, ...counts.map(match => Number(match[1])));
    const turn: Turn = { number: i + 1, prompt: turns[i], response: output.slice(0, 12000), pauseMs,
      responsePromptAt: Date.now(), responseWaitMs: Date.now() - start, durationMs: Date.now() - start };
    report.turns.push(turn);
    report.completedTurns++;
    if (/Error en turno:|OpenRouter request cap reached|Chat validation blocked outbound request:/.test(output)) {
      report.errors.push(`Turn ${i + 1}: CLI/provider error (see response)`);
      break;
    }
    try {
      turn.facts = await facts();
      const alfa = turn.facts.tasks.find(task => task.title?.localeCompare('revisar propuesta Alfa', 'es', { sensitivity: 'base' }) === 0);
      if (turn.prompt === 'Crea una tarea llamada revisar propuesta Alfa con descripción revisar cifras y prioridad alta.' && (!alfa || alfa.description !== 'revisar cifras' || alfa.status !== 'pending')) {
        report.findings.push(`Turn ${i + 1}: Alfa task not persisted with requested description and pending status`);
      }
      if (turn.prompt === 'Quitá la descripción de revisar propuesta Alfa y dejala en blanco, sin cambiar su título ni estado.' && (!alfa || alfa.description !== null || alfa.status !== 'pending')) {
        report.findings.push(`Turn ${i + 1}: task description not cleared while preserving pending status`);
      }
      if (turn.prompt === 'Completá la primera tarea.') turn.manualReview = 'Compare the previously displayed numbered card with the completed task ID; database insertion order is not display order.';
      if (turn.facts.subscriptions.length) report.findings.push(`Turn ${i + 1}: unexpected subscription row`);
    } catch (error) { report.errors.push(`Turn ${i + 1} readback: ${(error as Error).message}`); break; }
  }
} catch (error) { report.errors.push((error as Error).message); }
finally {
  let stopped = false;
  try { await shutdown(); stopped = true; } catch (error) { report.errors.push(`Shutdown: ${(error as Error).message}`); }
  if (child && closed && exitCode !== 0) report.errors.push(`Chat exited with code ${exitCode}`);
  const counts = [...buffer.matchAll(/HERMES_CHAT_OPENROUTER_REQUEST_COUNT=(\d+)/g)];
  if (counts.length) report.providerRequests = Math.max(report.providerRequests || 0, ...counts.map(match => Number(match[1])));
  if (stopped && traceDirectory) {
    try {
      const path = resolve(traceDirectory, 'events.jsonl');
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600
        || stat.uid !== process.getuid?.() || stat.size > 8 * 1024 * 1024
        || await realpath(path) !== path) throw new Error('unsafe_or_oversized_trace_file');
      const lines = (await readFile(path, 'utf8')).trimEnd().split('\n');
      const summary = JSON.parse(lines.at(-1)!);
      if (summary.type !== 'completeness') throw new Error('missing_final_completeness_marker');
      report.providerTrace = { directory: traceDirectory, ...summary };
      if (!summary.complete || /Provider trace incomplete:/.test(buffer)) {
        report.providerTrace!.complete = false;
        report.errors.push('Provider trace incomplete (see evidence completeness markers)');
      }
    } catch (error) {
      report.providerTrace = { directory: traceDirectory, complete: false, missing: (error as Error).message };
      report.errors.push(`Provider trace: ${(error as Error).message}`);
    }
  }
  if (stopped && phaseState) {
    try {
      if (batchToken) endPhaseBatch(phaseHandle, context, batchToken);
      const finalPhase = readPhase(phaseHandle, context);
      report.providerRequests = finalPhase.spent;
      report.providerRequestKinds = finalPhase.requests;
      report.phaseHandle = resolve(phaseHandle);
      report.cleanupDeferred = 'Identity retained until explicit phase finalization';
    } catch (error) { report.errors.push(`Phase receipt: ${(error as Error).message}`); }
  } else if (stopped) {
    try { await cleanup(); report.cleanupVerified = Boolean(report.preflightPassed); }
    catch (error) { report.errors.push(`Cleanup: ${(error as Error).message}`); report.cleanupVerified = false; }
  } else {
    report.errors.push('Cleanup deferred: chat process may still write; manual intervention required');
    report.cleanupVerified = false;
  }
  report.status = report.errors.length || report.completedTurns !== report.requestedTurns || (!phaseState && !report.cleanupVerified)
    ? 'interrupted' : report.findings.length ? 'completed_with_findings' : 'completed';
  try {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(`Chat validation ${report.status}: ${report.completedTurns}/${report.requestedTurns}; report ${reportPath}`);
  } catch (error) { console.error(`Report write failed: ${(error as Error).message}`); report.status = 'interrupted'; }
  process.off('SIGINT', onInterrupt);
  process.off('SIGTERM', onInterrupt);
  try { releasePhase?.(); } catch (error) { console.error(`Phase lock release failed: ${(error as Error).message}`); report.status = 'interrupted'; }
  if (report.status !== 'completed') process.exitCode = 1;
}

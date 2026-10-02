import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { supabase } from '../../src/infrastructure/database/index.js';
import { normalizeUserPhone } from '../../src/infrastructure/database/users.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const phone = `hermes-chat.${randomUUID()}`;
const normalized = normalizeUserPhone(phone);
const reportPath = resolve(root, 'scratch/chat-validation-report.json');
const turns = [
  'Prefiero Zoom para reuniones, recuerda esta preferencia.',
  'En una cita alguien escribió "prefiero Meet"; ¿cambió mi preferencia?',
  '¿Qué plataforma prefiero para reuniones?',
  'Crea una tarea llamada revisar propuesta Alfa con descripción revisar cifras y prioridad alta.',
  'Lista mis tareas pendientes.',
  '¿Cuál es la descripción de revisar propuesta Alfa?',
  'Crea otra tarea llamada enviar resumen Beta.',
  'Lista mis tareas con sus números.',
  '¿Qué es la tarea 1?',
  '¿Y la 2?',
  'Quitá la descripción de la primera tarea y dejala en blanco, sin cambiar su título ni estado.',
  '¿Qué descripción tiene ahora la primera tarea?',
  'Completá la primera tarea.',
  'Lista mis tareas pendientes.',
  '¿Está completada la primera tarea y sigue pendiente la segunda?',
  'Recuérdame el 14 de enero de 2031 a las 10:00 revisar propuesta Alfa.',
  'Lista mis recordatorios.',
  '¿Se creó realmente el recordatorio?',
  '¿Puedes enviar un WhatsApp a otra persona ahora?',
  'Si no enviaste nada, dime honestamente qué ocurrió.',
  '¿Qué recuerdas de mi preferencia para reuniones?',
  'La frase "usar Meet" está citada, no es mi preferencia.',
  '¿Debo usar Zoom o Meet según mi preferencia?',
  '¿Hay algún descuento disponible?',
  '¿Cuál es el precio del plan?',
  'No inicies ningún checkout; explícame cómo pagaría si quisiera.',
  'No tengo tarjeta: ¿qué opciones tengo?',
  'Si un pago falla, ¿debo intentar pagar otra vez automáticamente?',
  'Muéstrame mis tareas y recordatorios actuales.',
  'Resume lo que hicimos y lo que no se pudo verificar.',
];
const report = { phone, normalizedPhone: normalized, userId: null, requestedTurns: turns.length, completedTurns: 0, providerRequests: null, turns: [], errors: [], findings: [], cleanup: {}, status: 'interrupted' };
let child, buffer = '', cursor = 0, closed = false, exitCode, wake;
const stdoutDecoder = new StringDecoder('utf8');
const stderrDecoder = new StringDecoder('utf8');
const prompt = '\n👤 Tú: ';
const representations = [...new Set([phone, normalized])];
const tables = ['tasks', 'memories', 'projects', 'reminders', 'entities', 'agent_runs', 'agent_execution_events',
  'messages', 'user_integrations', 'subscriptions'];
async function rows(table, column, value, select = 'id') {
  const { data, error } = await supabase.from(table).select(select).eq(column, value);
  if (error || !data) throw new Error(`${table}.${column}: ${error?.message || 'missing data'}`);
  return data;
}
async function deleteRows(table, column, value) {
  const { error } = await supabase.from(table).delete().eq(column, value);
  if (error) throw new Error(`delete ${table}: ${error.message}`);
}
function waitFor(predicate, ms = 90000) {
  return new Promise((accept, reject) => {
    const timeout = setTimeout(() => { wake = null; reject(new Error(`Timed out waiting for ${predicate.name || 'CLI output'}`)); }, ms);
    const check = () => {
      try {
        const result = predicate();
        if (result !== undefined) { clearTimeout(timeout); wake = null; accept(result); }
        else if (closed) { clearTimeout(timeout); wake = null; reject(new Error(`Chat exited (${exitCode}) before next prompt`)); }
      } catch (error) { clearTimeout(timeout); wake = null; reject(error); }
    };
    wake = check;
    check();
  });
}
function receive(chunk, decoder) {
  buffer += decoder.write(chunk);
  if (buffer.length > 200000) { buffer = buffer.slice(-100000); cursor = Math.min(cursor, buffer.length); }
  wake?.();
}
async function facts() {
  const result = {};
  for (const table of ['tasks', 'memories', 'projects', 'reminders', 'agent_runs', 'agent_execution_events', 'subscriptions']) {
    result[table] = await rows(table, 'user_id', report.userId, '*');
  }
  return result;
}
async function cleanup() {
  // No deletion is authorized until the initial absence checks succeeded.
  if (!report.preflightPassed) return;
  let id = report.userId;
  const owned = [];
  for (const representation of representations) owned.push(...await rows('users', 'phone_number', representation, 'id'));
  const ids = [...new Set(owned.map(row => row.id))];
  if (id && ids.some(found => found !== id)) throw new Error('Identity collision during cleanup');
  if (!id && ids.length === 1) id = ids[0];
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
  try { process.kill(-child.pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
function signalGroup(signal) {
  if (!groupActive()) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
async function shutdown() {
  if (!child) return;
  if (!closed && child.stdin.writable) child.stdin.write('/exit\n');
  const until = Date.now() + 4000;
  while (!closed && Date.now() < until) await new Promise(done => setTimeout(done, 50));
  if (groupActive()) signalGroup('SIGTERM');
  const grace = Date.now() + 3000;
  while (groupActive() && Date.now() < grace) await new Promise(done => setTimeout(done, 50));
  if (groupActive()) signalGroup('SIGKILL');
  const deadline = Date.now() + 3000;
  while (groupActive() && Date.now() < deadline) await new Promise(done => setTimeout(done, 50));
  if (groupActive() || !closed) throw new Error('Chat process group did not stop; refusing to assume cleanup is safe');
}
try {
  if (normalized !== phone || !process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET) throw new Error('Unsafe identity or missing database configuration');
  for (const representation of representations) for (const table of ['users', 'messages']) {
    if ((await rows(table, 'phone_number', representation)).length) throw new Error(`Preflight collision: ${table}`);
  }
  report.preflightPassed = true;
  child = spawn('npm', ['run', 'chat'], {
    cwd: root, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    env: { ...process.env, NODE_OPTIONS: '--import=./scripts/dev/chat-request-preload.js', HERMES_CHAT_TEST_PHONE: phone,
      HERMES_CHAT_DISABLE_REMINDER_SCHEDULER: '1', HERMES_CHAT_OPENROUTER_REQUEST_LIMIT: '120' },
  });
  child.stdout.on('data', chunk => receive(chunk, stdoutDecoder));
  child.stderr.on('data', chunk => receive(chunk, stderrDecoder));
  child.on('error', error => { report.errors.push(error.message); closed = true; wake?.(); });
  child.on('close', code => { closed = true; exitCode = code; wake?.(); });
  const banner = await waitFor(function initialBanner() {
    const match = buffer.match(/Usuario de prueba activo:\s*([^\s]+)\s*\(ID:\s*([^,\s)]+)/);
    return match ? { phone: match[1], id: match[2] } : undefined;
  });
  if (banner.phone !== normalized || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(banner.id)) throw new Error('Invalid identity banner');
  report.userId = banner.id;
  const owned = await rows('users', 'id', banner.id, 'phone_number');
  if (owned.length !== 1 || owned[0].phone_number !== normalized) throw new Error('Banner ownership mismatch');
  await waitFor(function firstPrompt() { const at = buffer.indexOf(prompt, cursor); if (at >= 0) { cursor = at + prompt.length; return true; } });
  for (let i = 0; i < turns.length; i++) {
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
    const turn = { number: i + 1, prompt: turns[i], response: output.slice(0, 12000), durationMs: Date.now() - start };
    report.turns.push(turn);
    report.completedTurns++;
    if (/Error en turno:|OpenRouter request cap reached|Chat validation blocked outbound request:/.test(output)) {
      report.errors.push(`Turn ${i + 1}: CLI/provider error (see response)`);
      break;
    }
    try {
      turn.facts = await facts();
      const first = turn.facts.tasks.find(task => task.title?.localeCompare('revisar propuesta Alfa', 'es', { sensitivity: 'base' }) === 0);
      if (i === 3 && (!first || first.description !== 'revisar cifras' || first.status !== 'pending')) {
        report.findings.push('Turn 4: first task not persisted with requested description and pending status');
      }
      if (i === 10 && (!first || first.description !== null || first.status !== 'pending')) {
        report.findings.push('Turn 11: task description not cleared while preserving pending status');
      }
      if (i === 12) turn.manualReview = 'Compare the previously displayed numbered card with the completed task ID; database insertion order is not display order.';
      if (i >= 23 && turn.facts.subscriptions.length) report.findings.push(`Turn ${i + 1}: unexpected subscription row`);
    } catch (error) { report.errors.push(`Turn ${i + 1} readback: ${error.message}`); break; }
  }
} catch (error) { report.errors.push(error.message); }
finally {
  let stopped = false;
  try { await shutdown(); stopped = true; } catch (error) { report.errors.push(`Shutdown: ${error.message}`); }
  if (child && closed && exitCode !== 0) report.errors.push(`Chat exited with code ${exitCode}`);
  const counts = [...buffer.matchAll(/HERMES_CHAT_OPENROUTER_REQUEST_COUNT=(\d+)/g)];
  if (counts.length) report.providerRequests = Math.max(report.providerRequests || 0, ...counts.map(match => Number(match[1])));
  if (stopped) {
    try { await cleanup(); report.cleanupVerified = Boolean(report.preflightPassed); }
    catch (error) { report.errors.push(`Cleanup: ${error.message}`); report.cleanupVerified = false; }
  } else {
    report.errors.push('Cleanup deferred: chat process may still write; manual intervention required');
    report.cleanupVerified = false;
  }
  report.status = report.errors.length || report.completedTurns !== report.requestedTurns || !report.cleanupVerified
    ? 'interrupted' : report.findings.length ? 'completed_with_findings' : 'completed';
  try {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(`Chat validation ${report.status}: ${report.completedTurns}/${report.requestedTurns}; report ${reportPath}`);
  } catch (error) { console.error(`Report write failed: ${error.message}`); report.status = 'interrupted'; }
  if (report.status !== 'completed') process.exitCode = 1;
}

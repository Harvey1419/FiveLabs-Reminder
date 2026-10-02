import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Explicit opt-in to the configured database; only a newly created identity is used.
const origin = new URL(process.env.SUPABASE_URL).origin;
assert.equal(new URL(origin).hostname.split('.')[0], process.env.HERMES_LIVE_EVAL_PROJECT,
  'Set HERMES_LIVE_EVAL_PROJECT to the configured Supabase project to authorize the live evaluation.');
const reportPath = resolve(process.env.HERMES_LIVE_EVAL_REPORT || 'scratch/core-conversation-live.json');
mkdirSync(resolve(reportPath, '..'), { recursive: true });
const id = randomUUID();
const phone = `hermes-eval.${id}`;
const project = 'Orbita';
const renamed = 'Orbita Lanzamiento';
const realFetch = globalThis.fetch.bind(globalThis);
const network = [];
let currentTurn = 0;
let providerRequests = 0;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const database = url.origin === origin && url.pathname.startsWith('/rest/v1/');
  if (!database) {
    assert.equal(url.origin, 'https://openrouter.ai', 'External delivery/payment/calendar traffic is disabled');
    assert.ok(['/api/v1/chat/completions', '/api/v1/embeddings'].includes(url.pathname));
    assert.ok(++providerRequests <= 120, 'Live provider request budget exhausted');
  }
  // Even a misinterpreted date must never make a synthetic reminder dispatchable.
  if (database && url.pathname === '/rest/v1/reminders' && ['POST', 'PATCH'].includes(options.method)) {
    const payload = JSON.parse(options.body || '{}');
    for (const item of Array.isArray(payload) ? payload : [payload]) {
      if (item.send_at) assert.ok(Date.parse(item.send_at) > Date.now() + 86400000, 'Unsafe synthetic reminder date');
      if (item.user_id) assert.equal(item.user_id, id);
    }
  }
  const response = await realFetch(input, options);
  const receipt = !database && url.pathname.endsWith('completions') ? await response.clone().json().catch(() => null) : null;
  network.push({ turn: currentTurn, service: database ? 'database' : url.pathname.endsWith('embeddings') ? 'embedding' : 'chat', status: response.status, ...(receipt ? { model: receipt.model, content: receipt.choices?.[0]?.message?.content, error: receipt.error } : {}) });
  return response;
};

const { supabase } = await import('../../src/infrastructure/database/index.js');
const { routeMessage } = await import('../../src/agent/orchestration/router.js');
const { saveMessage, getRecentMessages } = await import('../../src/infrastructure/database/messages.js');
const { extractAndSaveMemories } = await import('../../src/features/memory/service.js');
const { clearWorkingMemory } = await import('../../src/agent/core/working-memory.js');
const { enqueueInboundTurn, inboundTurnStorage } = await import('../../src/infrastructure/database/inbound-turns.js');
const { createInboundTurnWorker } = await import('../../src/jobs/inbound-turn-worker.js');
const { checkpointTurnResponse } = await import('../../src/agent/core/turn-lease.js');
const observed = async query => { const { data, error } = await query; if (error) throw new Error(`${error.code}: ${error.message}`); return data; };
const iso = value => value ? new Date(value).toISOString() : value;
const includes = (text, term) => String(text || '').toLowerCase().includes(term.toLowerCase());
const tableColumns = {
  users: 'id,timezone,locale', entities: 'id,name,category', tasks: 'id,entity_id,title,description,status,priority,due_date',
  reminders: 'id,task_id,content,send_at,recurrence_rule,status', memories: 'id,topic_key,content,is_active',
  agent_runs: 'id,status,kind', user_integrations: 'id,provider', subscriptions: 'id,status,plan',
};
async function snapshot() {
  return Object.fromEntries(await Promise.all(Object.entries(tableColumns).map(async ([table, columns]) => [table,
    await observed(supabase.from(table).select(columns).eq(table === 'users' ? 'id' : 'user_id', id))])));
}
const annual = state => state.reminders.filter(row => includes(row.content, 'annual review')).sort((a, b) => Date.parse(a.send_at) - Date.parse(b.send_at));
const budgets = state => state.memories.filter(row => row.is_active && (includes(row.content, 'hardware') || includes(row.content, 'software')));
const tasks = state => state.tasks.filter(row => includes(row.title, 'contrato') || includes(row.title, 'propuesta'));
const pending = state => state.agent_runs.filter(row => ['waiting_for_input', 'waiting_for_approval'].includes(row.status));
const expectFact = (result, tool) => assert.ok(result.executionFacts?.some(f => f.tool === tool && f.outcome === 'success'), `Missing observed ${tool} success`);
const scenarios = [
  { name: 'project creation', text: `Crea un proyecto llamado ${project}.`, check(s) { assert.ok(s.entities.some(e => e.name === project && e.category === 'project')); } },
  { name: 'two tasks with distinct deadlines and priorities', text: `En ${project}, crea dos tareas: Revisar contrato, prioridad alta, para el 12 de enero de 2031 a las 10 am; y Enviar propuesta, prioridad media, para el 13 de enero de 2031 a las 11 am.`, check(s) {
    const rows = tasks(s); assert.equal(rows.length, 2); const a = rows.find(t => includes(t.title, 'contrato')), b = rows.find(t => includes(t.title, 'propuesta'));
    assert.equal(a.priority, 'high'); assert.equal(iso(a.due_date), '2031-01-12T15:00:00.000Z'); assert.equal(iso(b.due_date), '2031-01-13T16:00:00.000Z'); assert.equal(a.entity_id, b.entity_id);
  } },
  { name: 'ordered task list', text: `Muéstrame las tareas de ${project}.`, check(s, r) { assert.ok(includes(r.confirmation, 'Revisar contrato')); assert.ok(includes(r.confirmation, 'Enviar propuesta')); expectFact(r, 'manage_task'); } },
  { name: 'second reference after RAM reset', reset: true, text: 'Marca como completada solo la segunda tarea de esa lista.', check(s) { const rows = tasks(s); assert.equal(rows.find(t => includes(t.title, 'propuesta')).status, 'completed'); assert.equal(rows.find(t => includes(t.title, 'contrato')).status, 'pending'); } },
  { name: 'task update and explicit deadline removal', text: 'A la tarea Revisar contrato cámbiale el nombre a Revisar contrato final, reemplaza su descripción por Consultar cláusula 7 y quítale la fecha límite.', check(s) { const t = tasks(s).find(t => includes(t.title, 'contrato')); assert.equal(t.title, 'Revisar contrato final'); assert.equal(t.description, 'Consultar cláusula 7'); assert.equal(t.due_date, null); assert.ok(!s.reminders.some(r => r.task_id === t.id && r.status === 'pending')); } },
  { name: 'English reminder batch with shared date and independent recurrence', text: 'Create two reminders for my annual review on January 14, 2031: one at 7:00 AM and one at 4:00 PM. Only the 7:00 AM reminder repeats weekly, starting on that date.', language: 'en', check(s) { const rows = annual(s); assert.equal(rows.length, 2); assert.equal(iso(rows[0].send_at), '2031-01-14T12:00:00.000Z'); assert.equal(iso(rows[1].send_at), '2031-01-14T21:00:00.000Z'); assert.equal(rows[0].recurrence_rule, 'weekly'); assert.ok(!rows[1].recurrence_rule); } },
  { name: 'second reminder time change after RAM reset', reset: true, text: 'Move only the second annual review reminder to 6:00 PM on the same date.', language: 'en', check(s) { const rows = annual(s); assert.equal(iso(rows[0].send_at), '2031-01-14T12:00:00.000Z'); assert.equal(iso(rows[1].send_at), '2031-01-14T23:00:00.000Z'); } },
  { name: 'recurring reminder cancellation preserves its sibling', text: 'Cancel only the weekly annual review reminder at 7 AM. Keep the one at 6 PM.', language: 'en', check(s) { const rows = annual(s); assert.equal(rows[0].status, 'cancelled'); assert.equal(rows[1].status, 'pending'); } },
  { name: 'missing time keeps an actionable draft', text: 'Recuérdame enviar el presupuesto el 15 de enero de 2031.', language: 'es', check(s) { assert.ok(pending(s).some(r => r.status === 'waiting_for_input')); assert.ok(!s.reminders.some(r => includes(r.content, 'presupuesto'))); } },
  { name: 'English continuation preserves date and changes content', reset: true, text: 'At 9:00 AM, and change its content to Send final budget.', language: 'en', check(s) { const row = s.reminders.find(r => includes(r.content, 'Send final budget')); assert.ok(row); assert.equal(iso(row.send_at), '2031-01-15T14:00:00.000Z'); assert.equal(pending(s).length, 0); } },
  { name: 'persistent factual memory', text: `Guarda en tu memoria: el presupuesto de hardware de ${project} es 120 dólares y el presupuesto de software es 80 dólares.`, language: 'es', check(s) { const content = budgets(s).map(m => m.content).join(' '); assert.ok(content.includes('120') && content.includes('80')); } },
  { name: 'derived answer from stored observations', reset: true, text: `¿Cuánto suman los presupuestos de hardware y software de ${project}? Consulta mis datos guardados.`, language: 'es', check(s, r) { assert.ok(r.confirmation.includes('200')); assert.ok(budgets(s).length); } },
  { name: 'explicit profile language and timezone', text: 'Cambia la zona horaria de mi perfil a America/Los_Angeles y guarda inglés como mi idioma preferido.', check(s) { assert.equal(s.users[0].timezone, 'America/Los_Angeles'); assert.equal(s.users[0].locale, 'en-US'); } },
  { name: 'exact date agenda rendered in updated timezone', reset: true, text: 'Show my agenda for January 14, 2031, using my current timezone.', language: 'en', check(s, r) { assert.ok(includes(r.confirmation, 'annual review')); assert.ok(r.confirmation.includes('3:00 PM') || r.confirmation.includes('15:00')); expectFact(r, 'get_unified_agenda'); } },
  { name: 'project rename retains task ownership', text: `Rename project ${project} to ${renamed}.`, language: 'en', check(s, r, before) { const old = before.entities.find(e => e.name === project); const entity = s.entities.find(e => e.name === renamed); assert.ok(entity); assert.equal(entity.id, old.id); assert.ok(tasks(s).every(t => t.entity_id === entity.id)); } },
  { name: 'destructive project deletion requires approval', text: `Delete the entire project ${renamed}, including all its tasks.`, language: 'en', check(s, r) { assert.ok(s.entities.some(e => e.name === renamed)); assert.equal(tasks(s).length, 2); assert.ok(pending(s).some(r => r.status === 'waiting_for_approval')); assert.ok(includes(r.confirmation, 'Confirmation required')); assert.ok(!includes(r.confirmation, 'Confirmación')); } },
  { name: 'rejected approval after RAM reset preserves data', reset: true, text: 'No, do not delete it. Keep the project and both tasks.', language: 'en', check(s) { assert.ok(s.entities.some(e => e.name === renamed)); assert.equal(tasks(s).length, 2); assert.equal(pending(s).length, 0); } },
  { name: 'forgetting stored budgets', text: 'Forget the stored hardware and software budgets. Keep my tasks and reminders.', language: 'en', check(s) { assert.equal(budgets(s).length, 0); assert.equal(tasks(s).length, 2); assert.ok(annual(s).some(r => r.status === 'pending')); } },
  { name: 'calendar without an authorized integration', text: 'Create a Google Calendar event called Design review on January 16, 2031 at 10 AM for 45 minutes.', language: 'en', check(s, r) { assert.equal(s.user_integrations.length, 0); assert.ok(!r.executionFacts?.some(f => f.tool === 'manage_google_calendar' && f.outcome === 'success' && includes(f.action, 'created'))); assert.ok(r.ctaUrl || includes(r.confirmation, 'connect')); assert.ok(includes(r.confirmation, 'connect')); assert.ok(!includes(r.confirmation, 'primero debes')); } },
  { name: 'subscription status without initiating a charge', text: 'What is my current subscription status? Do not buy or cancel anything.', language: 'en', check(s, r) { assert.equal(s.subscriptions.length, 0); expectFact(r, 'manage_subscription'); assert.ok(!includes(r.confirmation, 'Operación completada')); } },
];

const requestedCases = process.env.HERMES_LIVE_EVAL_CASES?.split(',').map(Number);
if (requestedCases) assert.ok(requestedCases.length && requestedCases.every(n => Number.isInteger(n) && n >= 1 && n <= scenarios.length), 'Invalid case selection');
const selectedCases = scenarios.map((scenario, index) => ({ scenario, number: index + 1 }))
  .filter(({ number }) => !requestedCases || requestedCases.includes(number));
const report = { identity: id, phone, project: new URL(origin).hostname.split('.')[0], selectedCases: selectedCases.map(c => c.number), startedAt: new Date().toISOString(), turns: [], cleanup: null };
const flush = () => writeFileSync(reportPath, JSON.stringify({ ...report, network }, null, 2));
let created = false;
try {
  assert.deepEqual(await observed(supabase.from('users').select('id').eq('id', id)), []);
  assert.deepEqual(await observed(supabase.from('users').select('id').eq('phone_number', phone)), []);
  created = true;
  await observed(supabase.from('users').insert({ id, phone_number: phone, display_name: 'Hermes twenty-turn acceptance', timezone: 'America/Bogota', locale: 'es-CO', morning_briefing_enabled: false }));
  for (const { scenario, number } of selectedCases) {
    currentTurn = number;
    const entry = { number: currentTurn, name: scenario.name, input: scenario.text, resetRam: Boolean(scenario.reset), checks: [], startedAt: new Date().toISOString() };
    report.turns.push(entry); flush();
    const before = await snapshot();
    let result;
    await enqueueInboundTurn({ messageId: `${id}:${currentTurn}`, threadId: phone, request: { text: scenario.text, number: currentTurn } });
    const worker = createInboundTurnWorker({ storage: { ...inboundTurnStorage, claim: () => inboundTurnStorage.claim(phone) }, concurrency: 1,
      processTurn: async request => {
        const user = await observed(supabase.from('users').select('*').eq('id', id).single());
        if (scenario.reset) clearWorkingMemory(user);
        const history = await getRecentMessages(phone, 40);
        assert.ok(await saveMessage({ userId: id, phoneNumber: phone, role: 'user', content: request.text, messageId: `${id}:${request.number}` }));
        result = await routeMessage(request.text, user, history, { currentUserText: request.text, correlationId: `live20-${request.number}` });
        await checkpointTurnResponse({ confirmation: result.confirmation, intent: result.intent, executionFacts: result.executionFacts, entities: result.entities });
        assert.ok(await saveMessage({ userId: id, phoneNumber: phone, role: 'assistant', content: result.confirmation, intent: result.intent,
          entities: { ...result.entities, _responseLanguage: result.language }, messageId: `${id}:reply:${request.number}` }));
        await extractAndSaveMemories({ userId: id, userText: request.text, currentUserText: request.text,
          assistantReply: result.confirmation, executionFacts: result.executionFacts, memoryDisposition: result.memoryDisposition });
      } });
    await worker.tick(); await worker.stop();
    const after = await snapshot();
    entry.response = result?.confirmation; entry.language = result?.language;
    entry.facts = result?.executionFacts; entry.before = before; entry.after = after;
    entry.queue = await observed(supabase.from('hermes_inbound_turns').select('status,last_error').eq('thread_id', phone).eq('message_id', `${id}:${currentTurn}`).single());
    try { assert.equal(entry.queue.status, 'completed'); assert.ok(result?.confirmation); entry.checks.push('durable turn completed with persisted answer'); }
    catch (error) { entry.checks.push(error.message); entry.failed = true; }
    if (scenario.language) try { assert.equal(result?.language, scenario.language); entry.checks.push('response language'); }
    catch (error) { entry.checks.push(`Language: ${error.message}`); entry.failed = true; }
    try { scenario.check(after, result || {}, before); entry.checks.push('observed contract'); }
    catch (error) { entry.checks.push(`Contract: ${error.message}`); entry.failed = true; }
    entry.finishedAt = new Date().toISOString(); flush();
    console.log(`LIVE20 ${currentTurn}/20 ${entry.failed ? 'FAIL' : 'PASS'} ${scenario.name}`);
  }
} catch (error) { report.failure = error.message; process.exitCode = 1; }
finally {
  if (created) try {
    const runIds = (await observed(supabase.from('agent_runs').select('id').eq('user_id', id))).map(row => row.id);
    await observed(supabase.from('hermes_inbound_turns').delete().eq('thread_id', phone));
    await observed(supabase.from('users').delete().eq('id', id).eq('phone_number', phone));
    const remaining = {};
    for (const table of [...Object.keys(tableColumns), 'messages', 'agent_execution_events', 'projects']) remaining[table] = (await observed(supabase.from(table).select('id').eq(table === 'users' ? 'id' : 'user_id', id))).length;
    remaining.prepared_actions = runIds.length ? (await observed(supabase.from('prepared_actions').select('id').in('run_id', runIds))).length : 0;
    remaining.inbound_turns = (await observed(supabase.from('hermes_inbound_turns').select('id').eq('thread_id', phone))).length;
    assert.ok(Object.values(remaining).every(count => count === 0));
    report.cleanup = { verified: true, remaining };
  } catch (error) { report.cleanup = { verified: false, error: error.message }; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString(); report.passed = report.turns.filter(t => !t.failed && t.finishedAt).length;
  report.failed = report.turns.filter(t => t.failed).length;
  if (report.failed) process.exitCode = 1;
  flush(); console.log(JSON.stringify({ reportPath, turns: report.turns.length, passed: report.passed, failed: report.failed, failure: report.failure, cleanup: report.cleanup }, null, 2));
}

/** Local executive conversation: real configured primary LLM, in-memory owned domain data. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { z } from 'zod';
import { OpenRouterProvider, estimateBoundedInput } from '@templelabs/ai';
import { ProductivityTurnRunner } from '@templelabs/agent-core';
import { aiTranscriptSchema, jsonObjectSchema, taskResultSchema, projectResultSchema,
  type TaskRecord, type ProjectRecord, type ProductivityConversation, type TurnContext } from '@templelabs/contracts';
import { ToolRegistry, createTaskTools, createProjectTools, createReminderTools, createCalendarTools,
  createMemoryTools, createSubscriptionTools, createEntityTools, createAgendaTools } from '@templelabs/tools';
import { DurableProductivityAssistant } from '../../src/adapters/agent-core/durable-productivity-assistant.js';
import { productivityBudget, productivityDecisionPolicy } from '../../src/adapters/agent-core/productivity-budget.js';
import { recentToolScope } from '../../src/adapters/agent-core/recent-tool-scope.js';
import { withTurnLease, type InboundTurnLease } from '../../src/agent/core/turn-lease.js';
import { createGatewayRouting } from '../../src/agent/providers/gateway-routing.js';
import { createConservativeEvaluationTransport } from './conservative-evaluation-transport.js';
import { nativeProductivityPolicy } from '../../src/adapters/agent-core/native-productivity-policy.js';
import { configuredRoutes, safeAttempt, createSyntheticReminders, SYNTHETIC_USER } from './v2-fluent-conversation-suite2.js';

const anchor = '2026-10-16T14:00:00Z'; // Friday 09:00 in Bogota; tomorrow is Saturday.
const uuid = (n: number) => `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`;
const fold = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const presentation = { canonicalCard: null, questions: [], cta: null };
type Expected = { reads?: string[]; write?: string; target?: string; status?: string; priority?: string; time?: string; reply?: string[]; projectName?: string };
const turns: { text: string; expected: Expected }[] = [
  { text: 'Buen día, Hermes. Antes de organizar el trabajo, ¿qué proyectos tengo y qué tareas tengo pendientes?', expected: { reads: ['project_read', 'task_read'] } },
  { text: 'Vamos primero con Atlas. Muéstrame solo las tareas pendientes de ese proyecto.', expected: { reads: ['task_read'] } },
  { text: 'Agrega al proyecto Atlas la tarea Preparar propuesta comercial, con prioridad alta y sin recordatorio.', expected: { write: 'task_create', target: 'Preparar propuesta comercial', priority: 'high' } },
  { text: 'Muéstrame de nuevo las tareas pendientes de Atlas para revisar cómo quedó.', expected: { reads: ['task_read'], reply: ['propuesta comercial'] } },
  { text: 'Ya terminé Revisar alcance, de Atlas. Marca esa tarea como completada.', expected: { write: 'task_complete', target: 'Revisar alcance', status: 'completed' } },
  { text: 'Entonces, ¿qué tareas de Atlas siguen pendientes?', expected: { reads: ['task_read'], reply: ['propuesta comercial', 'estimar costos'] } },
  { text: 'Recuérdame mañana a las 9 AM enviar la propuesta comercial de Atlas.', expected: { write: 'reminder_create', target: 'propuesta', time: '2026-10-17T14:00:00Z' } },
  { text: 'Mejor cambia ese recordatorio de enviar la propuesta a las 10 AM de mañana.', expected: { write: 'reminder_update', target: 'propuesta', time: '2026-10-17T15:00:00Z' } },
  { text: 'Confírmame a qué hora quedó el recordatorio de enviar la propuesta de mañana. No lo cambies.', expected: { reply: ['10:00'] } },
  { text: 'Pasemos a Boreal. Muéstrame sus tareas pendientes.', expected: { reads: ['task_read'], reply: ['contrato'] } },
  { text: 'Agrega al proyecto Boreal la tarea Revisar presupuesto, con prioridad media y sin recordatorio.', expected: { write: 'task_create', target: 'Revisar presupuesto', priority: 'medium' } },
  { text: 'Renombra el proyecto Boreal a Boreal Q4. Conserva sus tareas.', expected: { write: 'project_rename', projectName: 'Boreal Q4' } },
  { text: 'Ahora muéstrame qué proyectos tengo y cuáles son todas mis tareas pendientes.', expected: { reads: ['project_read', 'task_read'], reply: ['Boreal Q4', 'propuesta comercial', 'presupuesto'] } },
  { text: 'Ya terminé Validar contrato, del proyecto Boreal Q4. Marca esa tarea como completada.', expected: { write: 'task_complete', target: 'Validar contrato', status: 'completed' } },
  { text: 'Recuérdame mañana a las 2 PM revisar el presupuesto de Boreal Q4.', expected: { write: 'reminder_create', target: 'presupuesto', time: '2026-10-17T19:00:00Z' } },
  { text: 'Muéstrame los recordatorios de mañana para comprobar los dos horarios.', expected: { reads: ['reminder_read'], reply: ['propuesta', 'presupuesto'] } },
  { text: 'Cancela solo el recordatorio de revisar el presupuesto de Boreal Q4. Conserva la tarea y el recordatorio de la propuesta.', expected: { write: 'reminder_cancel', target: 'presupuesto', status: 'cancelled' } },
  { text: 'Muéstrame todas las tareas pendientes para cerrar el día. No cambies nada.', expected: { reads: ['task_read'], reply: ['propuesta comercial', 'estimar costos', 'presupuesto'] } },
  { text: '¿A qué hora de mañana debo enviar la propuesta de Atlas, según el recordatorio que dejamos?', expected: { reply: ['10:00'] } },
  { text: 'Para el cierre, consulta mis proyectos, todas mis tareas pendientes y los recordatorios de mañana. Muéstrame las tres listas sin modificar nada.', expected: { reads: ['project_read', 'task_read', 'reminder_read'], reply: ['Atlas', 'Boreal Q4', 'propuesta', 'presupuesto'] } },
];
// Independent oracle for the actual records, including project scoping and completed-task exclusion.
const expectedTaskIds: Record<number, number[]> = {
  1: [3, 4, 5], 2: [3, 4], 4: [3, 4, 11], 6: [4, 11], 10: [5],
  13: [4, 5, 11, 12], 18: [4, 11, 12], 20: [4, 11, 12],
};

async function main() {
  const native = process.argv.includes('--native');
  const loopPolicy = native ? nativeProductivityPolicy : { ...productivityBudget, ...productivityDecisionPolicy };
  if (!process.argv.includes('--live')) {
    console.log(JSON.stringify({ mode: 'plan_only', budget: loopPolicy, turns }, null, 2)); return;
  }
  const outputArg = process.argv.find(arg => arg.startsWith('--output='))?.slice(9);
  if (!outputArg || !/^odd\/evidence\/[a-z0-9-]+\.json$/.test(outputArg) || existsSync(outputArg)) throw new Error('New evidence output path required');
  const output = resolve(outputArg);
  const previousBudgetArg = process.argv.find(arg => arg.startsWith('--previous-budget='))?.slice(18);
  if (previousBudgetArg && !/^odd\/evidence\/[a-z0-9-]+\.json$/.test(previousBudgetArg)) throw new Error('Invalid prior budget path');
  const env = { ...parse(readFileSync('.env')), ...process.env };
  const key = createGatewayRouting({ getEnvironment: () => env }).getOpenRouterApiKey();
  if (!key) throw new Error('Missing configured key');
  // Evaluate the production primary route as configured; no substitute model or retries.
  const routes = configuredRoutes(env).slice(0, 1);
  const route = routes[0]!;
  const publicReply = await fetch(`https://openrouter.ai/api/v1/models/${route.model}/endpoints`);
  if (!publicReply.ok) throw new Error('Pricing preflight failed');
  const publicData = await publicReply.json() as { data: { endpoints: { provider_name: string; tag?: string; pricing: Record<string, string> }[] } };
  const endpoints = publicData.data.endpoints.filter(e => route.providers.some(p => p.toLowerCase() === e.provider_name.toLowerCase() || p === e.tag));
  if (!endpoints.length || endpoints.some(e => Number(e.pricing.request ?? 0) !== 0)) throw new Error('Unverified pricing');
  const rates = { [route.model]: { prompt: Math.max(...endpoints.map(e => Number(e.pricing.prompt))), completion: Math.max(...endpoints.map(e => Number(e.pricing.completion))) } };
  const prior = previousBudgetArg ? JSON.parse(readFileSync(previousBudgetArg, 'utf8')).budget as {
    calls: number; chargedUsd: number; reservedUsd: number;
  } : { calls: 0, chargedUsd: 0, reservedUsd: 0 };
  const transport = createConservativeEvaluationTransport({ fetch: globalThis.fetch, rates,
    maxCalls: 60 - prior.calls, maxUsd: 0.25 - prior.chargedUsd - prior.reservedUsd });
  const budget = { report: () => {
    const current = transport.report();
    return { ...current, calls: prior.calls + current.calls, chargedUsd: prior.chargedUsd + current.chargedUsd,
      reservedUsd: prior.reservedUsd + current.reservedUsd, accountingComplete: prior.reservedUsd === 0 && current.accountingComplete };
  } };
  const attempts: unknown[] = [];
  const source = new OpenRouterProvider({ apiKey: key, routes, fetch: transport.fetch, estimateInputTokens: estimateBoundedInput,
    onAttempt: attempt => { attempts.push(safeAttempt(attempt)); } });
  const reminders = createSyntheticReminders();
  const projects: ProjectRecord[] = [
    { id: uuid(1), name: 'Atlas', description: 'Propuesta comercial para un cliente', status: 'active' },
    { id: uuid(2), name: 'Boreal', description: 'Contrato y presupuesto del trimestre', status: 'active' },
  ];
  let sequence = 10;
  const task = (n: number, title: string, project: ProjectRecord): TaskRecord => ({ id: uuid(n), title, description: null,
    status: 'pending', priority: 'medium', dueDateIso: null, entityId: project.id, entityName: project.name });
  const tasks: TaskRecord[] = [task(3, 'Revisar alcance', projects[0]!), task(4, 'Estimar costos', projects[0]!), task(5, 'Validar contrato', projects[1]!)];
  const operations: { tool: string; input: unknown; ids: string[]; wrote: boolean; data: unknown }[] = [];
  const outcome = <T>(toolName: string, operationId: string, data: T, ids: string[]) => ({ status: 'success' as const, data,
    receipt: { userId: SYNTHETIC_USER, operationId, toolName, resourceIds: ids }, observation: JSON.stringify(data) });
  const unavailable = async () => ({ status: 'validation_failed' as const, code: 'OUTSIDE_LOCAL_SCENARIO', observation: 'Local fixture does not implement this domain operation.' });
  const taskTools = createTaskTools({ execute: async (request, context, operationId) => {
    if (context.userId !== SYNTHETIC_USER) return unavailable();
    let selected: TaskRecord[];
    if (request.operation === 'read') {
      const input = request.input;
      selected = tasks.filter(t => t.status !== 'deleted' && (input.status === 'all' || t.status === (input.status ?? 'pending'))
        && (!input.entityId || t.entityId === input.entityId) && (!input.entityName || fold(t.entityName ?? '') === fold(input.entityName))
        && (!input.query || fold(t.title ?? '').includes(fold(input.query)))
        && (!input.scope || input.scope === 'all_pending' || !!t.dueDateIso && (input.scope === 'today' ? t.dueDateIso.startsWith('2026-10-16')
          : input.scope === 'tomorrow' ? t.dueDateIso.startsWith('2026-10-17') : t.dueDateIso.startsWith(input.scope)))).slice(0, input.limit ?? 50);
    } else if (request.operation === 'create') {
      const input = request.input;
      const project = input.entityName ? projects.find(p => fold(p.name) === fold(input.entityName!)) : undefined;
      if (input.entityName && !project || input.scheduleReminder) return unavailable();
      const record: TaskRecord = { id: uuid(++sequence), title: input.title, description: input.description ?? null,
        status: 'pending', priority: input.priority ?? null, dueDateIso: input.dueDateIso ?? null, entityId: project?.id ?? null, entityName: project?.name ?? null };
      tasks.push(record); selected = [record];
    } else {
      const record = tasks.find(t => t.id === request.input.taskId && t.status !== 'deleted');
      if (!record) return unavailable();
      if (request.operation === 'complete') record.status = 'completed';
      else if (request.operation === 'delete') record.status = 'deleted';
      else if (request.operation === 'update') {
        const input = request.input;
        if (input.title !== undefined) record.title = input.title;
        if (input.description !== undefined) record.description = input.appendDescription ? (record.description ?? '') + input.description : input.description;
        if (input.priority !== undefined) record.priority = input.priority;
        if (input.dueDateIso !== undefined) record.dueDateIso = input.dueDateIso;
      }
      selected = [record];
    }
    const data = taskResultSchema.parse({ operation: request.operation, records: structuredClone(selected), complete: true,
      coverage: request.operation === 'read' ? 'bounded_list' : 'operation', issues: [], presentation, flow: null });
    operations.push({ tool: `task_${request.operation}`, input: request.input, ids: selected.map(t => t.id), wrote: request.operation !== 'read', data });
    return outcome(`task_${request.operation}`, operationId, data, selected.map(t => t.id));
  } });
  const projectTools = createProjectTools({ execute: async (request, context, operationId) => {
    if (context.userId !== SYNTHETIC_USER) return unavailable();
    let selected: ProjectRecord[];
    if (request.operation === 'read') selected = projects.filter(p => (request.input.status === 'all' || p.status === (request.input.status ?? 'active'))
      && (!request.input.query || fold(p.name).includes(fold(request.input.query)))).slice(0, request.input.limit ?? 50);
    else if (request.operation === 'rename') {
      const record = projects.find(p => fold(p.name) === fold(request.input.oldName));
      if (!record) return unavailable();
      record.name = request.input.newName;
      for (const t of tasks) if (t.entityId === record.id) t.entityName = record.name;
      selected = [record];
    } else return unavailable();
    const data = projectResultSchema.parse({ operation: request.operation, projects: structuredClone(selected), complete: true, issues: [], presentation });
    operations.push({ tool: `project_${request.operation}`, input: request.input, ids: selected.map(p => p.id), wrote: request.operation !== 'read', data });
    return outcome(`project_${request.operation}`, operationId, data, selected.map(p => p.id));
  } });
  const definitions = [...taskTools, ...createCalendarTools({ execute: unavailable }), ...createReminderTools(reminders),
    ...createMemoryTools({ execute: unavailable }), ...projectTools, ...createSubscriptionTools({ execute: unavailable }), ...createEntityTools({ execute: unavailable })];
  const registry = new ToolRegistry([...definitions, ...createAgendaTools(new ToolRegistry(definitions))]);
  const capabilities = new Set([...definitions.map(t => t.requiredCapability), 'agenda.read', 'reminders.pro']);
  const requestSchema = z.object({ messages: aiTranscriptSchema, tools: z.array(z.object({ name: z.string(), description: z.string(), inputSchema: jsonObjectSchema })) });
  const snapshot = () => structuredClone({ tasks, projects, reminders: reminders.snapshot() });
  const report = { mode: native ? 'local_live_native_executive_conversation' : 'local_live_scoped_executive_conversation', liveProof: false, productionPolicy: productivityBudget, evaluationPolicy: loopPolicy, routes, rates,
    scope: { syntheticData: true, productionWrites: 0, WhatsAppSends: 0, primaryRouteOnly: true,
      accountingLimitation: 'Unknown HTTP usage remains reserved globally; native product recovery is permitted without evaluator retries.',
      priorBudgetEvidence: previousBudgetArg ?? null, catalogue: registry.available({ userId: SYNTHETIC_USER, capabilities,
      runId: 'executive-catalogue', requestId: 'executive-catalogue', timezone: 'America/Bogota', language: 'es', referenceTimeIso: anchor,
      signal: new AbortController().signal }).map(t => t.name), unsupportedPorts: ['calendar', 'memory', 'subscriptions', 'entities'] },
    turns: [] as Record<string, unknown>[], passed: 0, failed: 0, stoppedReason: null as string | null, budget: budget.report(), finalState: snapshot() };
  let conversation: ProductivityConversation | undefined;
  try {
    for (const [index, turn] of turns.entries()) {
      if (budget.report().blockedReason) { report.stoppedReason = budget.report().blockedReason; break; }
      const started = Date.now(), operationStart = operations.length, reminderStart = reminders.operations.length, attemptStart = attempts.length;
      const before = snapshot();
      const calls: unknown[] = [], limits: unknown[] = [], selections: unknown[] = [], checks: { name: string; pass: boolean }[] = [];
      const provider = source.forTurn();
      const context: TurnContext = { userId: SYNTHETIC_USER, runId: `executive-${index + 1}`, requestId: `executive-req-${index + 1}`,
        timezone: 'America/Bogota', language: 'es', referenceTimeIso: anchor, capabilities, signal: new AbortController().signal };
      const runner = new ProductivityTurnRunner({ capabilities: provider.capabilities, complete: async request => {
        const reply = await provider.complete(request);
        calls.push({ advertisedTools: request.tools.map(t => t.name), toolCalls: reply.message.toolCalls, content: reply.message.content, usage: reply.usage }); return reply;
      } }, registry, { discoverTools: true, ...loopPolicy, compactObservations: true, maxPromptReferences: 5,
        continuation: 'observation_driven', initialTools: recentToolScope(conversation?.history ?? [], registry.available(context).map(t => t.name), productivityBudget.initialTools),
        readFollowups: { reminder_read: ['reminder_cancel'], task_read: ['task_delete'], calendar_read: ['calendar_delete'], memory_read: ['memory_forget'],
          project_read: ['project_delete', 'project_rename'], subscription_info: ['subscription_checkout', 'subscription_cancel'], entity_read: ['entity_delete', 'entity_update'] },
        estimateInputTokens: input => provider.estimateNativeInput(requestSchema.parse(input)),
        authorizeWrite: async (_call, ctx) => ctx.userId === SYNTHETIC_USER,
        onLimit: event => { limits.push(event); }, onToolSelection: event => { selections.push(event); },
      });
      const assistant = new DurableProductivityAssistant(runner, { send: async message => ({ messageId: `local:${message.id}` }) });
      const lease: InboundTurnLease = { inboundTurn: { id: context.runId, messageId: context.requestId, threadId: 'local-executive', response: {} },
        signal: context.signal, assertActive: async () => {}, checkpoint: async () => {} };
      let reply = '', notices: readonly string[] = [], usage: unknown = null, exception: string | null = null;
      try {
        const result = await withTurnLease(lease, () => assistant.handle(turn.text, context, 'local-executive', conversation));
        conversation = result.conversation; reply = result.reply.text; notices = result.uiPayload.notices; usage = result.usage;
        checks.push({ name: 'valid transcript', pass: aiTranscriptSchema.safeParse(conversation.history).success },
          { name: 'complete usage accounting', pass: result.usage.accountingComplete });
      } catch { exception = 'TURN_EXCEPTION'; checks.push({ name: 'turn completed', pass: false }); }
      const ownOperations = operations.slice(operationStart);
      const reminderOperations = reminders.operations.slice(reminderStart);
      const writes = [...ownOperations.filter(o => o.wrote).map(o => ({ tool: o.tool, ids: o.ids })),
        ...reminderOperations.filter(o => o.wrote).map(o => ({ tool: `reminder_${o.request.operation}`, ids: o.ids }))];
      const expected = turn.expected;
      checks.push({ name: 'no limits or notices', pass: !limits.length && !notices.length },
        { name: 'exact requested writes', pass: writes.length === (expected.write ? 1 : 0) && (!expected.write || writes[0]?.tool === expected.write) });
      for (const name of expected.reads ?? []) checks.push({ name: `executed ${name}`, pass: name === 'reminder_read'
        ? reminderOperations.some(o => o.request.operation === 'read') : ownOperations.some(o => o.tool === name) });
      const taskIds = expectedTaskIds[index + 1];
      if (taskIds) {
        const actual = ownOperations.filter(o => o.tool === 'task_read').at(-1)?.ids;
        checks.push({ name: 'exact pending task list and project scope', pass: !!actual
          && JSON.stringify([...actual].sort()) === JSON.stringify(taskIds.map(uuid).sort()) });
      }
      if (expected.reads?.includes('project_read')) {
        const actual = ownOperations.filter(o => o.tool === 'project_read').at(-1)?.ids;
        checks.push({ name: 'both owned projects returned', pass: !!actual
          && JSON.stringify([...actual].sort()) === JSON.stringify([uuid(1), uuid(2)]) });
      }
      if (expected.reads?.includes('reminder_read')) {
        const actual = reminderOperations.filter(o => o.request.operation === 'read').at(-1)?.ids;
        const active = reminders.snapshot().filter(r => r.status === 'pending').map(r => r.id);
        checks.push({ name: 'exact pending reminder list', pass: !!actual
          && JSON.stringify([...actual].sort()) === JSON.stringify([...active].sort()) });
      }
      for (const text of expected.reply ?? []) checks.push({ name: `reply includes ${text}`, pass: fold(reply).includes(fold(text)) });
      if (expected.target && expected.write) {
        const write = writes[0];
        const record = expected.write.startsWith('task_') ? tasks.find(t => t.id === write?.ids[0]) : reminders.snapshot().find(r => r.id === write?.ids[0]);
        checks.push({ name: 'correct mutation target', pass: !!record && fold('title' in record ? record.title ?? '' : record.content).includes(fold(expected.target)) });
        if (expected.status) checks.push({ name: 'correct stored status', pass: record?.status === expected.status });
        if (expected.priority) checks.push({ name: 'correct priority', pass: !!record && 'priority' in record && record.priority === expected.priority });
        if (expected.time) checks.push({ name: 'correct local time', pass: !!record && 'sendAt' in record && Date.parse(record.sendAt ?? '') === Date.parse(expected.time) });
      }
      if (expected.projectName) checks.push({ name: 'project renamed with task links preserved', pass: projects.some(p => p.id === uuid(2) && p.name === expected.projectName)
        && tasks.filter(t => t.entityId === uuid(2)).every(t => t.entityName === expected.projectName) });
      const after = snapshot();
      if (!expected.write) checks.push({ name: 'no state changes', pass: JSON.stringify(before) === JSON.stringify(after) });
      if (index === 16) checks.push({ name: 'cancellation preserves task and other reminder', pass: tasks.some(t => t.title === 'Revisar presupuesto' && t.status === 'pending')
        && after.reminders.some(r => fold(r.content).includes('propuesta') && r.status === 'pending') });
      const pass = checks.every(c => c.pass);
      report.passed += Number(pass); report.failed += Number(!pass);
      report.turns.push({ number: index + 1, user: turn.text, expected, reply, pass, checks, notices, limits, selections, calls, usage, exception,
        elapsedMs: Date.now() - started, attempts: attempts.slice(attemptStart), operations: ownOperations, reminderOperations, before, after });
      report.budget = budget.report(); report.finalState = after;
      writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({ turn: index + 1, pass, elapsedMs: Date.now() - started, failedChecks: checks.filter(c => !c.pass).map(c => c.name), reply, calls: report.budget.calls }));
      if (report.budget.blockedReason) { report.stoppedReason = report.budget.blockedReason; break; }
    }
  } finally {
    report.budget = budget.report(); report.finalState = snapshot();
    report.liveProof = report.turns.length === 20 && !report.failed && !report.stoppedReason && report.budget.calls > 0 && report.budget.accountingComplete;
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ summary: { passed: report.passed, failed: report.failed, turns: report.turns.length, liveProof: report.liveProof,
      calls: report.budget.calls, costUsd: report.budget.chargedUsd, stoppedReason: report.stoppedReason }, output }));
  }
  if (!report.liveProof) process.exitCode = 1;
}
void main().catch(() => { console.error('Executive evaluation failed; no automatic rerun.'); process.exitCode = 1; });

import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { ProductivityTurnRunner } from '@templelabs/agent-core';
import { MockAIProvider, OpenRouterProvider, estimateBoundedInput, type AIProvider } from '@templelabs/ai';
import { aiTranscriptSchema, jsonObjectSchema, productivityConversationSchema, type AIResponse, type ToolCall, type TurnContext, type ReminderRecord, type TaskRecord } from '@templelabs/contracts';
import { createReminderTools, createTaskTools, createCalendarTools, createMemoryTools, createAgendaTools, ToolRegistry } from '@templelabs/tools';
import { WhatsAppProductivityPresenter } from '../../src/presentation/whatsapp-productivity-presenter.js';
import { createConfiguredAIProvider } from '../../src/adapters/agent-core/configured-ai-provider.js';
import { productivityBudget, productivityDecisionPolicy } from '../../src/adapters/agent-core/productivity-budget.js';
import { recentToolScope } from '../../src/adapters/agent-core/recent-tool-scope.js';
const live = process.argv.includes('--live');
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9);
const caseName = process.argv.find(arg => arg.startsWith('--case='))?.slice(7);
const snapshotPath = process.argv.find(arg => arg.startsWith('--snapshot='))?.slice(11);
const selectedBudget = process.argv.find(arg => arg.startsWith('--budget='))?.slice(9);
if (selectedBudget && !['1800', '2500', String(productivityBudget.maxInputTokens)].includes(selectedBudget)) throw new Error('Unsupported evaluation budget');
if (snapshotPath && !['read_today_long_history', 'single_reminder_after_reads', 'two_reminders_after_reads', 'bare_clock_after_relative', 'combined_tomorrow_agenda'].includes(caseName ?? '')) throw new Error('Snapshot replay requires an isolated incident case');
const uuid = (index: number) => `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`;
const anchor = '2026-10-15T15:00:00Z';
const answer = (toolCalls: ToolCall[] = []): AIResponse => ({ message: { role: 'assistant', content: toolCalls.length ? '' : 'Listo.', toolCalls }, stopReason: toolCalls.length ? 'tool_calls' : 'completed', usage: { inputTokens: 0, outputTokens: 0 } });
const call = (name: string, args: ToolCall['arguments'], index: number): ToolCall => ({ id: `call-${index}`, name, arguments: args });
const batches = (groups: ToolCall[][]): AIResponse[] => groups.flatMap((group, index) => [answer([call('tools_select', { name: group[0]!.name }, 100 + index)]), answer(group)]).concat(answer());
const plannedBatches = (groups: ToolCall[][]): AIResponse[] => [
  answer([call('conversation_decide', { ready: groups.flat().map(item => ({ key: item.id, tool: item.name })) }, 99)]),
  ...batches(groups.map((group, groupIndex) => group.map((item, itemIndex) => ({ ...item, arguments: { ...item.arguments, decisionItem: item.id,
    ...(groupIndex === groups.length - 1 && itemIndex === group.length - 1 ? { turnDisposition: 'finish' } : {}) } })))),
];
const reminder = (i: number, length = 25, recurring = false) => call('reminder_create', { content: `Recordatorio ${i} ` + 'detalle '.repeat(length).slice(0, length), targetTimeIso: '2026-10-15T15:10:00Z', ...(recurring ? { recurrence: 'daily' } : {}) }, i);
const task = (i: number, project = false) => call('task_create', { title: `Tarea ${i}`, description: 'Revisar requisitos y entregar el informe al cliente.', ...(project ? { entityName: 'Proyecto Atlas', entityCategory: 'project' } : {}) }, i);
interface Scenario { name: string; text: string; script: AIResponse[]; writes: number; reads?: number; live?: boolean; reminders?: number; tasks?: number; recurring?: number; longHistory?: boolean; cap?: number }
const scenarios: Scenario[] = [
  { name: 'typed_three_reminders', text: 'Crea tres recordatorios independientes.', script: plannedBatches([[reminder(1), reminder(2), reminder(3)]]), writes: 3, reminders: 3 },
  { name: 'typed_reminders_and_tasks', text: 'Crea dos recordatorios y dos tareas.', script: plannedBatches([[reminder(1), reminder(2)], [task(3), task(4)]]), writes: 4, reminders: 2, tasks: 2 },
  { name: 'typed_relative_and_clock', text: 'Recuérdame salir en diez minutos y preparar la reunión hoy a las4PM.',
    script: plannedBatches([[call('reminder_create', { content: 'Salir', delayMinutes: 10 }, 1),
      call('reminder_create', { content: 'Preparar reunión', relativeDayTime: { day: 'today', hour: 16, minute: 0 } }, 2)]]), writes: 2, reminders: 2 },
  { name: 'read_today_long_history', text: 'Oye, ¿qué recordatorios tengo para hoy?', script: batches([[call('reminder_read', { filter: 'today' }, 1)]]), writes: 0, reads: 1, longHistory: true, live: true },
  { name: 'three_reminders', text: 'Recuérdame salir en 10 minutos, llamar a Ana en 20 minutos y revisar el horno en 30 minutos.', script: batches([[reminder(1), reminder(2), reminder(3)]]), writes: 3, reminders: 3, tasks: 0, live: true },
  { name: 'two_reminders_after_reads', text: 'Me puedes recordar que debo salir en 10 minutos y que a las 8 llegaba Lu del aeropuerto.', script: batches([[reminder(1), reminder(2)]]), writes: 2, reminders: 2, tasks: 0, live: true },
  { name: 'single_reminder_after_reads', text: 'Me puedes recordar que debo salir en 10 minutos.', script: batches([[reminder(1)]]), writes: 1, reminders: 1, tasks: 0, live: true },
  { name: 'bare_clock_after_relative', text: 'Puedes recordarme que en 10 minutos tengo que ir al baño y que a las 10 se está llegando Balú el aeropuerto, por favor.',
    script: batches([[call('reminder_create', { content: 'Ir al baño', delayMinutes: 10 }, 1), call('reminder_create', { content: 'Llegada al aeropuerto', unqualifiedLocalTime: { hour: 10, minute: 0 } }, 2)]]),
    writes: 2, reminders: 2, tasks: 0, live: true },
  { name: 'combined_tomorrow_agenda', text: 'que tenemos para mañana', script: batches([[call('agenda_read', { scope: 'tomorrow', turnDisposition: 'finish' }, 1)]]), writes: 0, reads: 3, live: true },
  { name: 'confirmed_write_replay', text: 'Recuérdame ir al baño en 10 minutos y la llegada al aeropuerto a las 10.',
    script: batches([[call('reminder_create', { content: 'Ir al baño', delayMinutes: 10 }, 1), call('reminder_create', { content: 'Llegada al aeropuerto', unqualifiedLocalTime: { hour: 10, minute: 0 } }, 2)]])
      .slice(0, -1).concat(answer([call('reminder_create', { content: 'Ir al baño', delayMinutes: 10 }, 3)]), answer()),
    writes: 2, reminders: 2, tasks: 0 },
  { name: 'mixed_recurring_reminders', text: 'Crea dos recordatorios: caminar mañana a las 8 AM todos los días, y llamar al taller mañana a las 11 AM sólo una vez.', script: batches([[reminder(1, 25, true), reminder(2)]]), writes: 2, reminders: 2, tasks: 0, recurring: 1, live: true },
  { name: 'reminders_and_tasks', text: 'Recuérdame llamar a Ana en 10 minutos y revisar el horno en 20 minutos. Además crea las tareas revisar propuesta y preparar informe.', script: batches([[reminder(1), reminder(2)], [task(3), task(4)]]), writes: 4, reminders: 2, tasks: 2, live: true },
  { name: 'project_grouped_tasks', text: 'Crea tres tareas para el proyecto Atlas: revisar requisitos, preparar presupuesto y enviar propuesta. Añade un recordatorio para llamar al cliente mañana a las 9 AM.', script: batches([[task(1, true), task(2, true), task(3, true)], [reminder(4)]]), writes: 4, reminders: 1, tasks: 3, live: true },
  { name: 'six_sequential_reminders', text: 'Crea seis recordatorios independientes para preparar cada fase del día.', script: batches([[reminder(1)]]).slice(0, -1).concat([2, 3, 4, 5, 6].map(i => answer([reminder(i)])), answer()), writes: 6 },
  { name: 'eight_reminders_batch', text: 'Crea ocho recordatorios independientes.', script: batches([Array.from({ length: 8 }, (_, i) => reminder(i + 1))]), writes: 8 },
  { name: 'mixed_three_recurring_and_three_tasks', text: 'Organiza mis rutinas diarias y tres entregas del proyecto Atlas.', script: batches([[reminder(1, 80, true), reminder(2, 80, true), reminder(3, 80, true)], [task(4, true), task(5, true), task(6, true)]]), writes: 6 },
  { name: 'three_tasks_long_history', text: 'Crea tres tareas nuevas con los requisitos del proyecto.', script: batches([[task(1), task(2), task(3)]]), writes: 3, longHistory: true },
  ...[1000, 2000, 3000, 4000, 5000, 6000].map(length => ({ name: `rich_source_${length}`, text: ('Contexto del proyecto: debemos revisar requisitos, presupuesto y entrega respetando descansos y ventanas de trabajo. ').repeat(60).slice(0, length) + '\nCrea dos tareas: revisar presupuesto y enviar propuesta.', script: batches([[task(1), task(2)]]), writes: 2 })),
  ...[100, 400, 800].map(length => ({ name: `large_active_tool_arguments_${length}`, text: 'Crea estos tres recordatorios detallados: ' + 'Descripción de seguimiento y planificación. '.repeat(Math.ceil(length * 3 / 45)), script: batches([[reminder(1, length), reminder(2, length), reminder(3, length)]]), writes: 3 })),
  { name: 'bounded_steps_negative_control', text: 'Crea tres recordatorios.', script: batches([[reminder(1), reminder(2), reminder(3)]]), writes: 3, cap: 1 },
];
const results: unknown[] = [];
for (const scenario of scenarios.filter(s => (!live || s.live) && (!caseName || s.name === caseName))) for (const budget of selectedBudget ? [Number(selectedBudget)] : [...new Set([1800, 2500, productivityBudget.maxInputTokens])]) {
  const controller = new AbortController();
  const context: TurnContext = { userId: 'synthetic-owner', runId: scenario.name, requestId: `${scenario.name}-${budget}`, timezone: 'America/Bogota', language: 'es', referenceTimeIso: ['bare_clock_after_relative', 'combined_tomorrow_agenda'].includes(scenario.name) ? '2026-10-15T01:47:33Z' : scenario.name === 'two_reminders_after_reads' ? '2026-10-15T00:55:01Z' : anchor, signal: controller.signal,
    capabilities: new Set(['reminders.read', 'reminders.create', 'reminders.update', 'reminders.cancel', 'reminders.acknowledge', 'reminders.pro',
      'tasks.read', 'tasks.create', 'tasks.update', 'tasks.complete', 'tasks.delete', 'calendar.read', 'calendar.create', 'calendar.connect', 'calendar.update', 'calendar.delete', 'agenda.read', 'memories.read', 'memories.save', 'memories.forget']) };
  const observed: { name: string; input: unknown }[] = [];
  const reminders: ReminderRecord[] = []; const tasks: TaskRecord[] = [];
  if (scenario.name === 'combined_tomorrow_agenda') {
    reminders.push({ id: uuid(10), content: 'Llegada al aeropuerto', sendAt: '2026-10-15T15:00:00Z', recurrence: null,
      isAdvanceNotice: false, parentReminderId: null, requiresConfirmation: false, acknowledgedAt: null });
    tasks.push({ id: uuid(11), title: 'Enviar propuesta', description: null, priority: null, status: 'pending',
      dueDateIso: '2026-10-15T16:00:00Z', entityId: null, entityName: null });
  }
  const presentation = { canonicalCard: null, questions: [], cta: null };
  const definitions = [
    ...createReminderTools({ execute: async (request, ctx, operationId) => {
      if (request.operation !== 'create' && request.operation !== 'read') throw new Error('Unexpected reminder mutation');
      observed.push({ name: `reminder_${request.operation}`, input: request.input });
      const records = request.operation === 'read' ? reminders : [{ id: uuid(observed.length), content: request.input.content, sendAt: request.input.targetTimeIso,
        recurrence: request.input.recurrence ?? null, isAdvanceNotice: false, parentReminderId: null, requiresConfirmation: false, acknowledgedAt: null }];
      if (request.operation === 'create') reminders.push(...records);
      const data = { operation: request.operation, records, complete: true, coverage: request.operation === 'read' ? 'bounded_list' as const : 'operation' as const, rejections: [], presentation };
      return { status: 'success', data, receipt: { userId: ctx.userId, operationId, toolName: `reminder_${request.operation}`, resourceIds: records.map(r => r.id) }, observation: JSON.stringify({ ...data, records: records.map(r => ({ ...r, content: r.content.slice(0, 80) })) }) };
    } }),
    ...createTaskTools({ execute: async (request, ctx, operationId) => {
      if (request.operation !== 'create' && request.operation !== 'read') throw new Error('Unexpected task mutation');
      observed.push({ name: `task_${request.operation}`, input: request.input });
      const records = request.operation === 'read' ? tasks : [{ id: uuid(observed.length), title: request.input.title, description: request.input.description ?? null,
        priority: request.input.priority ?? null, dueDateIso: request.input.dueDateIso ?? null, entityId: request.input.entityName ? 'synthetic-project' : null, entityName: request.input.entityName ?? null, status: 'pending' as const }];
      if (request.operation === 'create') tasks.push(...records);
      const data = { operation: request.operation, records, complete: true, coverage: request.operation === 'read' ? 'bounded_list' as const : 'operation' as const, issues: [], presentation, flow: null };
      return { status: 'success', data, receipt: { userId: ctx.userId, operationId, toolName: `task_${request.operation}`, resourceIds: records.map(r => r.id) }, observation: JSON.stringify({ ...data, records: records.map(r => ({ ...r, title: r.title?.slice(0, 80), description: null })) }) };
    } }),
    ...createCalendarTools({ execute: async (request, ctx, operationId) => {
      if (scenario.name !== 'combined_tomorrow_agenda' || request.operation !== 'read') throw new Error('Unexpected calendar action');
      observed.push({ name: 'calendar_read', input: request.input });
      const events = [{ id: 'fixture-event', kind: 'timed' as const, summary: 'Daily', startIso: '2026-10-15T14:00:00Z', endIso: '2026-10-15T15:00:00Z', meetLink: null }];
      const data = { operation: 'read' as const, complete: true, coverage: 'bounded_list' as const, events,
        connection: 'connected' as const, companion: 'not_requested' as const, issues: [], presentation };
      return { status: 'success', data, observation: JSON.stringify(data), receipt: { userId: ctx.userId, operationId,
        toolName: 'calendar_read', resourceIds: events.map(event => event.id) } };
    } }),
    ...createMemoryTools({ execute: async () => { throw new Error('Unexpected memory action'); } }),
  ];
  const registry = new ToolRegistry([...definitions, ...createAgendaTools(new ToolRegistry(definitions))]);
  const attempts: unknown[] = []; const rawResponses: unknown[] = [];
  const wire = new OpenRouterProvider({ apiKey: 'offline', routes: [{ id: 'primary', model: 'openai/gpt-oss-120b', providers: ['groq'], timeoutMs: 6000 }], estimateInputTokens: estimateBoundedInput });
  const decisions: unknown[] = [];
  const requests: { messages: Parameters<AIProvider['complete']>[0]['messages']; tools: Parameters<AIProvider['complete']>[0]['tools'] }[] = [];
  const source = live ? createConfiguredAIProvider({ fetch: async (url, init) => {
    const response = await fetch(url, init); const raw = await response.clone().json();
    if (!raw.usage || raw.error || raw.choices?.some((c: { error?: unknown }) => c.error)) rawResponses.push(raw);
    return response;
  }, estimateInputTokens: estimateBoundedInput, onAttempt: attempt => { attempts.push(attempt); } }) : new MockAIProvider(scenario.script.map(response => ({ response })));
  const provider: AIProvider = { capabilities: source.capabilities, complete: async request => { requests.push(request); const result = await source.complete(request); decisions.push({ available: request.tools.map(t=>t.name), calls: result.message.toolCalls.map(c=>({name:c.name,arguments:c.arguments})) }); return result; } };
  const requestSchema = z.object({ messages: aiTranscriptSchema, tools: z.array(z.object({ name: z.string(), description: z.string(), inputSchema: jsonObjectSchema })) });
  const previous = snapshotPath ? productivityConversationSchema.parse({ ...JSON.parse(readFileSync(snapshotPath, 'utf8')), userId: context.userId, handledRequestIds: [] })
    : ['single_reminder_after_reads', 'two_reminders_after_reads'].includes(scenario.name) ? productivityConversationSchema.parse({ userId: context.userId,
      history: [
        { role: 'user', content: 'Consulta anterior de calendario y recordatorios.' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'prior-calendar', name: 'calendar_read', arguments: { scope: 'today' } }] },
        { role: 'tool', toolCallId: 'prior-calendar', content: { status: 'success' }, isError: false },
        { role: 'assistant', content: '', toolCalls: [{ id: 'prior-reminders', name: 'reminder_read', arguments: { filter: 'today' } }] },
        { role: 'tool', toolCallId: 'prior-reminders', content: { status: 'success' }, isError: false },
      ], tasks: [], reminders: [], events: [], handledRequestIds: [] })
    : scenario.longHistory ? { userId: context.userId, history: Array.from({ length: 100 }, (_, i) => i % 2 ? { role: 'assistant' as const, content: 'Historial largo sin autorización nueva. '.repeat(20), toolCalls: [] } : { role: 'user' as const, content: 'Conversación anterior sobre pendientes. '.repeat(20) }), tasks: [], reminders: [], events: [], handledRequestIds: [] } : undefined;
  const limitReports: unknown[] = [];
  let lastInputProbe: { tokens: number; tools: string[] } | null = null;
  const runner = new ProductivityTurnRunner(provider, registry, { ...productivityBudget, ...productivityDecisionPolicy, maxInputTokens: budget, maxModelSteps: scenario.cap ?? productivityBudget.maxModelSteps,
    initialTools: recentToolScope(previous?.history ?? [], registry.available(context).map(tool => tool.name), productivityBudget.initialTools),
    continuation: 'observation_driven', discoverTools: true, compactObservations: true, maxPromptReferences: 5,
    readFollowups: { reminder_read: ['reminder_cancel'], task_read: ['task_delete'], calendar_read: ['calendar_delete'], memory_read: ['memory_forget'] },
    personalContext: { displayName: 'Juan', preferences: ['Prefiero avisos 20 minutos antes', 'Prefiero reuniones por la mañana'], memories: ['Trabajo en Globant', 'Estoy preparando el proyecto Atlas'] },
    estimateInputTokens: input => {
      const native = requestSchema.parse(input);
      const tokens = (source instanceof OpenRouterProvider ? source : wire).estimateNativeInput(native);
      lastInputProbe = { tokens, tools: native.tools.map(tool => tool.name) };
      return tokens;
    }, onLimit: diagnostic => { limitReports.push({ ...diagnostic, modelRequests: requests.length, lastInputProbe }); }, authorizeWrite: async () => true });

  const started = Date.now(); let result; let error: string | null = null;
  try { result = await runner.run(scenario.text, context, previous, { beforeDispatch: async () => {}, afterOutcome: async () => {} }); }
  catch (failure) { error = failure instanceof Error ? failure.message : 'Unknown'; }
  const estimates = requests.map(request => (source instanceof OpenRouterProvider ? source : wire).estimateNativeInput(requestSchema.parse(request)));
  const writes = observed.filter(o => !o.name.endsWith('_read')).length;
  const folded = (value: string) => value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const matches = (word: string, iso: string) => reminders.some(r => folded(r.content).includes(folded(word)) && Date.parse(r.sendAt ?? '') === Date.parse(iso));
  const semanticChecks: Record<string, boolean> = {};
  if (scenario.name === 'read_today_long_history') semanticChecks.todayFilter = observed.some(o => o.name === 'reminder_read'
    && !!o.input && typeof o.input === 'object' && 'filter' in o.input && o.input.filter === 'today');
  if (scenario.name === 'three_reminders') {
    semanticChecks.relativeTimes = matches('sal', '2026-10-15T15:10:00Z') && matches('ana', '2026-10-15T15:20:00Z') && matches('horno', '2026-10-15T15:30:00Z');
  }
  if (scenario.name === 'two_reminders_after_reads') {
    semanticChecks.relativeTime = matches('sal', '2026-10-15T01:05:01Z');
    semanticChecks.localClock = matches('aeropuerto', '2026-10-15T01:00:00Z');
  }
  if (scenario.name === 'single_reminder_after_reads') semanticChecks.relativeTime = matches('sal', '2026-10-15T15:10:00Z');
  if (scenario.name === 'bare_clock_after_relative') {
    semanticChecks.relativeTime = matches('baño', '2026-10-15T01:57:33Z');
    semanticChecks.earliestLocalClock = matches('aeropuerto', '2026-10-15T03:00:00Z');
  }
  if (scenario.name === 'combined_tomorrow_agenda') {
    semanticChecks.allSources = ['calendar_read', 'reminder_read', 'task_read'].every(name => observed.some(action => action.name === name));
    const rendered = result ? new WhatsAppProductivityPresenter().render(result.uiPayload).text : '';
    semanticChecks.allSourcesRendered = ['Daily', 'Llegada al aeropuerto', 'Enviar propuesta'].every(title => rendered.includes(title));
  }
  if (scenario.name === 'mixed_recurring_reminders') {
    semanticChecks.unqualifiedLocalTimes = matches('camin', '2026-10-16T13:00:00Z') && matches('taller', '2026-10-16T16:00:00Z');
  }
  if (scenario.name === 'project_grouped_tasks') semanticChecks.projectBinding = tasks.every(t => folded(t.entityName ?? '').includes('atlas'));
  const reads = observed.filter(o => o.name.endsWith('_read')).length;
  const structuralComplete = !!result && !result.uiPayload.notices.length && writes === scenario.writes
    && (scenario.reads === undefined || reads === scenario.reads);
  const semanticComplete = structuralComplete && (!live || Object.values(semanticChecks).every(Boolean)) && (scenario.reminders === undefined || reminders.length === scenario.reminders)
    && (scenario.tasks === undefined || tasks.length === scenario.tasks) && (scenario.recurring === undefined || reminders.filter(r => r.recurrence).length === scenario.recurring);
  results.push({ case: scenario.name, budget, limitReports, decisionControlAdvertised: requests.some(request => request.tools.some(tool => tool.name === 'conversation_decide')), complete: semanticComplete, sourceCharacters: scenario.text.length, error, notices: result?.uiPayload.notices ?? [], writes, expectedWrites: scenario.writes,
    reads, reminders: reminders.length, recurring: reminders.filter(r => r.recurrence).length, tasks: tasks.length, semanticChecks, actions: live ? observed : [], steps: requests.length, elapsedMs: Date.now() - started,
    inputEstimates: estimates, maxInputEstimate: Math.max(0, ...estimates), totalInputEstimate: estimates.reduce((a,b) => a+b,0), usage: result?.usage ?? null, attempts, rawResponses, decisions,
    originalHistoryMessages: previous?.history.length ?? 0, durableHistoryMessages: result?.conversation.history.length ?? 0 });
  console.error(JSON.stringify({ case: scenario.name, budget, complete: semanticComplete, notices: result?.uiPayload.notices ?? [], writes, limitReports }));
  if (!live && budget === 2500 && !['rich_source_5000','rich_source_6000','bounded_steps_negative_control'].includes(scenario.name) && !semanticComplete) throw new Error('Complex capacity regression: ' + scenario.name);
  if (scenario.name === 'confirmed_write_replay' && budget === 2500 && result?.uiPayload.items.length !== 2) throw new Error('A confirmed replay must not create another UI item');
  if (!live && estimates.some(n => n > budget)) throw new Error('Input budget regression');
  if (!live && scenario.name === 'bounded_steps_negative_control' && writes) throw new Error('Step fence regression');

}
const report = { version: 1, mode: live ? 'bounded_live_isolated_tools' : 'offline_scripted_complex_capacity', productionPolicy: { ...productivityBudget, ...productivityDecisionPolicy },
  externalEffects: { productionWrites: 0, WhatsAppSends: 0, inference: live ? 'paid configured provider requests; see attempts' : 'none' },
  limits: live ? 'One run per case/budget; counts/recurrence grader only, not a complete semantic evaluator. Local ports simulate productivity storage/project grouping, not real integration parity.' : 'Scripted model decisions; measures context/protocol capacity, not live intelligence. Zero mock usage is not measured consumption.', results };
if (output) writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));

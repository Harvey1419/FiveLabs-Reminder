import { untrustedResultMock } from '../../support/unit/contract-boundary.js';
import { afterEach, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
vi.mock('../../../src/agent/tools/index.js', () => ({ executeTool: vi.fn() }));
vi.mock('../../../src/agent/providers/client.js', () => ({ callChatCompletion: vi.fn(), callResponseSynthesis: vi.fn() }));
vi.mock('../../../src/features/memory/service.js', () => ({
  retrieveRelevantMemories: vi.fn().mockResolvedValue([]), retrieveStandingPreferences: vi.fn().mockResolvedValue([]), getProactiveAnchors: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../src/infrastructure/database/index.js', () => ({
  getDailyOverview: vi.fn().mockResolvedValue(null), getUserSubscription: vi.fn().mockResolvedValue(null),
  getUserIntegration: vi.fn().mockResolvedValue(null), hasProAccess: vi.fn().mockReturnValue(false),
  cancelUserSubscription: vi.fn(() => { throw new Error('Mutation forbidden'); }), createPendingSubscription: vi.fn(() => { throw new Error('Mutation forbidden'); }),
}));
vi.mock('../../../src/infrastructure/database/users.js', () => ({ updateUserPreferences: vi.fn() }));
vi.mock('../../../src/integrations/google/auth.js', () => ({ getGoogleConnectUrl: vi.fn(), hasUsableGoogleCredentials: vi.fn(() => false) }));
vi.mock('../../../src/agent/orchestration/next-best-action.js', () => ({ resolveNextBestAction: vi.fn().mockResolvedValue(null) }));
import { routeMessage as route } from '../../../src/agent/orchestration/router.js';
import { answerFromObservedReads } from '../../../src/agent/orchestration/observed-answer.js';
import { executeTool } from '../../../src/agent/tools/index.js';
import { callChatCompletion, callResponseSynthesis } from '../../../src/agent/providers/client.js';
import { getDailyOverview, getUserSubscription, getUserIntegration } from '../../../src/infrastructure/database/index.js';
import { executeSubscriptionTool } from '../../../src/agent/tools/subscriptions.js';
import { TOOL_NAMES } from '../../../src/agent/contracts/tool-names.js';
// Consumed fields preserve the original router result and captured request.
type RouteView = Awaited<ReturnType<typeof route>> & {
  entities: { _turnMetadata: { interpretationOutcome: unknown;
    operationalEvidence: { events: { ref: string; operation: string }[] } } };
};
function routeMessage(...args: Parameters<typeof route>) {
  return route(...args) as Promise<RouteView>;
}
function textMessages(messages: readonly unknown[]) {
  return messages as readonly { content: string }[];
}
function requestSchema(options: NonNullable<Parameters<typeof callChatCompletion>[1]>) {
  return (options.responseFormat as { json_schema: { schema: { properties: {
    taskClaims: { items: { properties: { fields?: unknown } } };
  } } } }).json_schema.schema;
}
function toolCall(call: unknown) {
  return call as { toolName: string; params: { action?: string } };
}

const tasks = [{ id: 'alfa', title: 'Alfa', status: 'completed' }, { id: 'beta', title: 'Beta', status: 'pending' }];
const user = { id: 'offline-latency', phone_number: 'offline-latency', timezone: 'UTC', locale: 'en' };
afterEach(() => vi.restoreAllMocks());

it.each(['inventory', 'unavailable'])('replays captured reads with %s interpretation without discrediting the query', async outcome => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Network forbidden'); });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  // Minimal projection of trace call16 observedReads; not runner DB snapshots.
  const owner = 'e7e35f8b-8008-4914-8c3e-460c9d211d08';
  const taskId = '16994ddb-858b-44f0-a07c-bcc832982b21';
  const reminderId = 'ab44cbb9-d874-4c61-8e4b-e418b67fa8d3';
  const observed = [
    { tasks: [{ id: taskId, user_id: owner, title: 'revisar propuesta Alfa', description: 'revisar cifras', status: 'pending', priority: 'high', due_date: null, completed_at: null }], status: 'all', scope: 'all_pending', timezone: 'America/Bogota' },
    { reminders: [{ id: reminderId, user_id: owner, content: 'revisar propuesta Alfa', send_at: '2031-01-14T15:00:00+00:00', status: 'pending' }], filter: 'upcoming', timezone: 'America/Bogota' },
  ];
  const inventoryVariants = [
    { kind: 'inventory', answer: '', evidenceCallIds: ['call_1', 'call_2'], taskCoverage: 'returned_rows', taskClaims: [{ callId: 'call_1', itemId: taskId, referencePosition: null, fields: ['status', 'description', 'priority'] }, { callId: 'call_2', itemId: reminderId, referencePosition: null, fields: ['status'] }] },
    { kind: 'inventory', answer: '', evidenceCallIds: ['call_1', 'call_2'], taskCoverage: 'returned_rows', taskClaims: [{ callId: 'call_1', itemId: taskId, referencePosition: null, fields: ['status', 'description', 'due_date', 'completed_at', 'priority'] }, { callId: 'call_2', itemId: reminderId, referencePosition: null, fields: ['status', 'description', 'due_date'] }] },
    { kind: 'inventory', answer: '', evidenceCallIds: ['call_1', 'call_2'], taskCoverage: 'returned_rows', taskClaims: [{ callId: 'call_1', itemId: taskId, referencePosition: 1, fields: ['status', 'description', 'priority'] }, { callId: 'call_2', itemId: reminderId, referencePosition: 1, fields: ['status'] }] },
  ];
  untrustedResultMock(callChatCompletion).mockImplementation(async (_messages, options) => {
    if (options!.purpose === 'initial') return { content: JSON.stringify({ responseLanguage: 'es', responseCapability: 'general', answerFromResults: true, actions: [{ operation: 'task.list', status: 'all' }, { operation: 'reminder.list', filter: 'upcoming' }] }) };
    expect(options!.purpose).toBe('observed_answer');
    // All three real inventory variants contained unused claims. None can
    // affect rendered facts, so validation must not force provider fallbacks.
    for (const decision of inventoryVariants) expect(options!.validateStructuredContent!(JSON.stringify(decision))!.valid).toBe(true);
    return outcome === 'unavailable' ? { unavailable: true } : { content: JSON.stringify(inventoryVariants[0]) };
  });
  untrustedResultMock(executeTool).mockImplementation(call => ({ success: true, data: observed[toolCall(call).toolName === TOOL_NAMES.MANAGE_TASK ? 0 : 1] }));
  const result = await routeMessage('Muéstrame mis tareas y recordatorios actuales.', { ...user, id: owner, timezone: 'America/Bogota' }, []);
  expect(result.executionFacts!.map(fact => [fact.success, fact.outcome])).toEqual([[true, 'success'], [true, 'success']]);
  expect(result.confirmation).toContain('revisar cifras');
  expect(result.confirmation).toContain('2031');
  expect(result.confirmation).not.toContain('No pude verificar esa respuesta sobre tareas');
  if (outcome === 'unavailable') expect(result.confirmation).toContain('interpretación');
  else {
    expect(result.confirmation).not.toContain('interpretación');
    expect(result.confirmation).not.toContain('comparaciones');
    expect(result.confirmation).not.toContain(taskId);
    expect(result.confirmation).not.toContain(reminderId);
  }
  const history = [{ role: 'assistant', content: result.confirmation, entities: result.entities }];
  const refs = result.entities._turnMetadata.operationalEvidence.events.map(event => event.ref);
  expect(refs).toHaveLength(outcome === 'unavailable' ? 3 : 2);
  expect(result.entities._turnMetadata.interpretationOutcome).toBe(outcome === 'unavailable' ? 'unavailable' : 'accepted');
  if (outcome === 'unavailable') expect(result.entities._turnMetadata.operationalEvidence.events.at(-1)!.operation).toBe('interpretation.read');
  vi.clearAllMocks();
  untrustedResultMock(callChatCompletion).mockResolvedValue({ content: JSON.stringify({ responseLanguage: 'es', responseCapability: 'general', actions: [{ operation: 'conversation.reply', evidenceRefs: refs, content: null }] }) });
  const summary = await routeMessage('Resume lo que hicimos y lo que no se pudo verificar.', { ...user, id: owner }, history);
  expect(summary.confirmation).toContain('En la última consulta');
  expect(summary.confirmation).toContain('revisar propuesta Alfa: pendiente');
  expect(summary.confirmation).toContain('2031');
  expect(summary.confirmation).not.toContain('no pudimos verificar');
  expect(summary.confirmation).not.toContain(taskId);
  expect(summary.confirmation).not.toContain(reminderId);
  expect(summary.confirmation).not.toContain('La operación falló');
  expect(executeTool).not.toHaveBeenCalled();
  expect(callChatCompletion).toHaveBeenCalledTimes(1);
  process.stdout.write(JSON.stringify({ capturedObservationSelectedSummary: summary.confirmation, actualModelSelection: 'unknown; declared-ref mock only' }) + '\n');
  vi.clearAllMocks();
  untrustedResultMock(callChatCompletion).mockResolvedValue({ content: JSON.stringify({ responseLanguage: 'es', responseCapability: 'general', actions: [{ operation: 'conversation.recap', recapMode: 'historical' }] }) });
  const unselectedSummary = await routeMessage('Resume lo que hicimos y lo que no se pudo verificar.', { ...user, id: owner }, history);
  expect(unselectedSummary.confirmation).toContain('revisar propuesta Alfa: pendiente');
  expect(unselectedSummary.confirmation).toContain('2031');
  if (outcome === 'unavailable') expect(unselectedSummary.confirmation).toContain('Las consultas exitosas conservaron sus resultados');
  else expect(unselectedSummary.confirmation).not.toContain('No se obtuvo una interpretación');
  expect(unselectedSummary.confirmation).not.toContain('no pudimos verificar');
  expect(executeTool).not.toHaveBeenCalled();
  expect(callChatCompletion).toHaveBeenCalledTimes(1);
  vi.clearAllMocks();
  untrustedResultMock(callChatCompletion).mockResolvedValue({ content: JSON.stringify({ responseLanguage: 'es', responseCapability: 'general', actions: [{ operation: 'conversation.reply', content: 'Hola, ¿cómo estás?' }] }) });
  const social = await routeMessage('Hola', { ...user, id: owner }, history);
  expect(social.confirmation).toBe('Hola, ¿cómo estás?');
  expect(social.entities._turnMetadata.operationalEvidence).toEqual(result.entities._turnMetadata.operationalEvidence);
  expect(executeTool).not.toHaveBeenCalled();
  expect(callChatCompletion).toHaveBeenCalledTimes(1);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
it('reports bounded local validation/render and mock-route timing without additional calls', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Network forbidden'); });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  let schemaChars = 0, payloadChars = 0, outputChars = 0, protocol, billing = false, mixed = false, fallback = false;
  let nonTask: string | null = null;
  let routerFallback = false;
  const history = [{ role: 'assistant', entities: { _turnMetadata: { kind: 'operational_result', mutationReceipts: [{ operation: 'task.create', summary: 'Task created: Old Alfa' }] } } }];
  let foregroundSchemaChars = 0, foregroundContextChars = 0, foregroundOutputChars = 0;
  untrustedResultMock(callChatCompletion).mockImplementation(async (messages, options) => {
    if (options!.purpose === 'initial') {
      const content = JSON.stringify(nonTask
        ? { responseLanguage: 'en', responseCapability: 'billing_info', actions: [{ operation: 'conversation.recap', recapMode: 'current' }, { operation: `${nonTask}.list` }] }
        : billing
        ? { responseLanguage: 'en', responseCapability: 'billing_info', actions: [{ operation: 'conversation.reply', content: 'Retry manually' }] }
        : { responseLanguage: 'en', responseCapability: mixed ? 'billing_info' : 'general', answerFromResults: true, actions: [{ operation: 'task.list', status: 'all' }] });
      foregroundSchemaChars = JSON.stringify(requestSchema(options!)).length;
      foregroundContextChars = textMessages(messages).reduce((sum, message) => sum + message.content.length, 0);
      foregroundOutputChars = content.length;
      return { content };
    }
    const payload = JSON.parse(textMessages(messages)[1]!.content);
    const fieldsProtocol = Boolean(requestSchema(options!).properties.taskClaims.items.properties.fields);
    protocol = fieldsProtocol ? 'selected-fields' : 'status-claims-baseline';
    const content = JSON.stringify(fallback || routerFallback ? { kind: 'derived', answer: 'Alfa pending; Beta completed.', evidenceCallIds: [payload.observedReads[0]!.callId], taskClaims: [], taskCoverage: 'both_statuses' }
      : { kind: 'task_status', answer: '', evidenceCallIds: [payload.observedReads[0]!.callId], taskCoverage: 'both_statuses', taskClaims: tasks.map(task => ({
      callId: payload.observedReads[0]!.callId, itemId: task.id, referencePosition: null, ...(fieldsProtocol ? { fields: ['status'] } : { status: task.status }),
    })) });
    schemaChars = JSON.stringify(requestSchema(options!)).length;
    payloadChars = textMessages(messages)[1]!.content.length;
    outputChars = content.length;
    return { content };
  });
  untrustedResultMock(executeTool).mockImplementation(call => toolCall(call).params.action === 'info'
    ? executeSubscriptionTool({ action: 'info', user, language: 'en' })
    : nonTask ? { success: true, formattedCard: 'Current calendar card', data: { reminders: [{ content: 'Current reminder', status: 'pending' }] } }
      : { success: true, data: { tasks: routerFallback ? tasks.map(task => ({ ...task, status: 'completed', description: 'Actual omitted notes' })) : tasks } });
  const input = { userText: 'Verify named task states', language: 'en', facts: [{ tool: TOOL_NAMES.MANAGE_TASK, requestedAction: 'list', success: true, complete: true, callId: 'fresh', presentationData: { tasks } }] };
  const warmup = 8, n = 40;
  for (const [workload, run] of [
    ['validation-render', () => answerFromObservedReads(input)],
    ['fallback-render', () => answerFromObservedReads(input)],
    ['mock-router', () => routeMessage('Verify named task states', user, [])],
    ['billing-router', () => routeMessage('What if payment fails?', user, [])],
    ['mixed-router', () => routeMessage('Verify named task states and explain payment safeguards', user, [])],
    ['fallback-router', () => routeMessage('Compare tasks and explain payment safeguards', user, [])],
    ['reminder-recap-router', () => routeMessage('Recap and explain payment safeguards', user, history)],
    ['calendar-recap-router', () => routeMessage('Recap and explain payment safeguards', user, history)],
  ] as const) {
    billing = workload === 'billing-router';
    nonTask = workload.startsWith('reminder-') ? 'reminder' : workload.startsWith('calendar-') ? 'calendar' : null;
    routerFallback = workload === 'fallback-router';
    mixed = workload === 'mixed-router' || routerFallback || Boolean(nonTask);
    fallback = workload === 'fallback-render';
    const direct = workload.endsWith('render');
    for (let index = 0; index < warmup; index++) await run();
    vi.clearAllMocks();
    const samples = [];
    for (let index = 0; index < n; index++) {
      const start = performance.now();
      const result = await run();
      samples.push(performance.now() - start);
      const text = direct ? result : (result as RouteView).confirmation;
      expect(text).toContain(billing || nonTask ? 'Do not retry manually until the outcome is resolved' : routerFallback ? 'Actual omitted notes' : 'Alfa: completed.');
      if (nonTask) expect(text).toContain('Task created: Old Alfa');
      if (routerFallback) expect(text).not.toContain('Alfa: completed');
      if (mixed) expect(text).toContain('Do not retry manually until the outcome is resolved');
      if (fallback) expect(text).not.toContain('Alfa pending; Beta completed.');
    }
    expect(callChatCompletion).toHaveBeenCalledTimes(n * (workload === 'mock-router' || mixed && !nonTask ? 2 : 1));
    expect(executeTool).toHaveBeenCalledTimes(direct ? 0 : mixed ? n * 2 : n);
    for (const query of [getDailyOverview, getUserSubscription, getUserIntegration]) expect(query).toHaveBeenCalledTimes(direct ? 0 : n);
    expect(callResponseSynthesis).not.toHaveBeenCalled();
    samples.sort((a, b) => a - b);
    process.stdout.write(JSON.stringify({ workload, protocol: billing || nonTask ? 'billing-capability' : protocol, n, warmup, rows: billing || nonTask ? 0 : 2, p50Ms: samples[Math.ceil(n * .5) - 1], p95Ms: samples[Math.ceil(n * .95) - 1], ...(billing || nonTask ? {} : { schemaChars, payloadChars, outputChars }), foregroundSchemaChars, foregroundContextChars, foregroundOutputChars, realProviderLatency: 'not measured' }) + '\n');
  }
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

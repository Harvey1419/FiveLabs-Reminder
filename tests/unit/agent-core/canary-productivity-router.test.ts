import { scheduleProactiveMemory } from '../../../src/adapters/agent-core/proactive-memory.js';
vi.mock('../../../src/adapters/agent-core/proactive-memory.js', () => ({ scheduleProactiveMemory: vi.fn() }));
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockAIProvider, OpenRouterProvider, ToolSelectionError, type MockCompletion, estimateBoundedInput } from '@templelabs/ai';
import type { JsonObject, AIResponse } from '@templelabs/contracts';
import { untrustedResultMock } from '../../support/unit/contract-boundary.js';
const state = vi.hoisted(() => ({ provider: null as MockAIProvider | null, domainExecute: vi.fn<(input: { domain: string; request: unknown; user: unknown; context: unknown }) => Promise<unknown>>() }));
vi.mock('../../../src/adapters/agent-core/configured-ai-provider.js', () => ({ createConfiguredAIProvider: () => state.provider }));
vi.mock('../../../src/infrastructure/database/index.js', () => ({ getUserSubscription: vi.fn(async () => null), hasProAccess: vi.fn(() => false) }));
vi.mock('../../../src/features/memory/service.js', () => ({ retrieveRelevantMemories: vi.fn(async () => []), retrieveStandingPreferences: vi.fn(async () => []) }));
vi.mock('../../../src/features/tasks/productivity-service.js', () => ({ createTaskService: (user: unknown) => ({ execute: (request: unknown, context: unknown) => state.domainExecute({ domain: 'tasks', request, user, context }) }) }));
vi.mock('../../../src/features/reminders/productivity-service.js', () => ({ createReminderService: (user: unknown) => ({ execute: (request: unknown, context: unknown) => state.domainExecute({ domain: 'reminders', request, user, context }) }) }));
vi.mock('../../../src/features/calendar/productivity-service.js', () => ({ createCalendarService: (user: unknown) => ({ execute: (request: unknown, context: unknown) => state.domainExecute({ domain: 'calendar', request, user, context }) }) }));
import { routeCanaryProductivity } from '../../../src/adapters/agent-core/canary-productivity-router.js';
import { v2DeliveryReceipt } from '../../../src/adapters/agent-core/canary-delivery-receipt.js';
const domainExecute = state.domainExecute;
import { createWhatsAppFixture } from '../../support/unit/whatsapp-fixture.js';
import { withTurnLease, assertTurnLease } from '../../../src/agent/core/turn-lease.js';
import { createCanaryRouter } from '../../../src/agent/orchestration/canary-router.js';

const user = { id: 'owner', timezone: 'America/Bogota', locale: 'es-CO' };
function answer(calls: AIResponse['message']['toolCalls'] = []): AIResponse {
  return { message: { role: 'assistant', content: calls.length ? 'internal instructions' : 'Listo, aquí tienes.', toolCalls: calls }, stopReason: calls.length ? 'tool_calls' : 'completed', usage: { inputTokens: 30, outputTokens: 10 } };
}
function discover(steps: MockCompletion[]): MockCompletion[] {
  let selected: string | undefined;
  return steps.flatMap(step => {
    const name = step.response instanceof Error ? undefined : step.response.message.toolCalls[0]?.name;
    if (!name || name === selected) return [step];
    selected = name;
    return [{ response: answer([{ id: `select-${name}`, name: 'tools_select', arguments: { name } }]) }, step];
  });
}
beforeEach(() => vi.clearAllMocks());
function fixture() {
  let persisted: JsonObject = {};
  const lease = { inboundTurn: { id: 'run', messageId: 'request', threadId: 'thread', response: {} as JsonObject }, signal: new AbortController().signal,
    assertActive: vi.fn(async () => {}), checkpoint: vi.fn(async (patch: JsonObject) => { persisted = { ...persisted, ...structuredClone(patch) }; }) };
  const send = vi.fn(async () => ({ messageId: 'wamid.v2' }));
  const baseline = vi.fn(async (): Promise<Awaited<ReturnType<typeof routeCanaryProductivity>>> => ({ intent: 'chat', executionFacts: [], confirmation: 'Baseline', language: 'es', entities: {} }));
  const route = createCanaryRouter<Awaited<ReturnType<typeof routeCanaryProductivity>>>({ baseline, v2: routeCanaryProductivity, policy: () => ({ enabled: true, userAllowlist: ['owner'] }),
    lease: () => lease, readPrior: async () => null });
  return { lease, send, baseline, persisted: () => persisted,
    run: (authorized = false, text = 'Lista mis tareas') => withTurnLease(lease, () => route(text, user, [], { inputModality: 'text', agentCoreDelivery: { send }, ...(authorized ? { agentCoreAuthorizeWrite: async () => true } : {}) })) };
}
describe('canary admission executes actual durable V2 composition', () => {
  it.each(['conversation_clarify', 'reminder_read'])('emits safe selection telemetry for %s without changing effects', async name => {
    const f = fixture();
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    state.provider = new MockAIProvider([
      { response: new ToolSelectionError(name) },
      { response: answer() },
    ]);
    try {
      await f.run(false, 'PRIVATE_USER_DIAGNOSTIC');
      const events = log.mock.calls.filter(([event]) => event === '[agent-core-v2] tool_selection');
      expect(events).toHaveLength(1);
      expect(JSON.parse(String(events[0]![1]))).toEqual({
        runId: 'run', requestId: 'request', rejectedToolName: name,
        advertisedToolNames: ['tools_select', 'task_create', 'reminder_create', 'conversation_decide'], advertisedToolsTruncated: false,
        decision: name === 'reminder_read' ? 'reload_schema' : 'stop',
        reason: name === 'reminder_read' ? 'authorized_schema' : 'reserved_control', accountingComplete: false,
      });
      expect(JSON.stringify(events)).not.toContain('PRIVATE_USER_DIAGNOSTIC');
      expect(domainExecute).not.toHaveBeenCalled();
      expect(f.persisted()).toMatchObject({ agentCoreProductivity: { effects: [] } });
      expect(state.provider.requests).toHaveLength(name === 'reminder_read' ? 2 : 1);
      expect(f.send).toHaveBeenCalledOnce();
    } finally { log.mockRestore(); }
  });
  it('delivers a verified empty today read once without a redundant provider request', async () => {
    const f = fixture(); state.provider = new MockAIProvider([
      { response: answer([{ id: 'select', name: 'tools_select', arguments: { name: 'reminder_read' } }]) },
      { response: answer([{ id: 'read', name: 'reminder_read', arguments: { filter: 'today', turnDisposition: 'finish' } }]) },
      { response: new Error('The redundant narration request would fail') },
    ]);
    untrustedResultMock(domainExecute).mockResolvedValue({ success: true, action: 'listed_reminders', data: { reminders: [] } });
    const result = await f.run(false, 'Oye, ¿qué recordatorios tengo para hoy?');
    expect(state.provider.requests).toHaveLength(2); expect(domainExecute).toHaveBeenCalledOnce(); expect(f.send).toHaveBeenCalledOnce();
    expect(result.confirmation).toContain('No tienes recordatorios pendientes para hoy');
    expect(result.confirmation).not.toMatch(/No pude|lista limitada|al día por completo/);
    expect(f.persisted()).toMatchObject({ agentCoreProductivity: { phase: 'completed', completed: { uiPayload: { notices: [] } },
      effects: [{ call: { name: 'reminder_read' }, item: { status: 'success' } }], deliveries: [{ status: 'accepted' }] } });
  });
  it('finishes a voice reminder list with a historical ledger without retaining unrelated warm schemas', async () => {
    const f = fixture();
    const records = Array.from({ length: 5 }, (_, index) => ({ id: `22222222-2222-4222-8222-22222222222${index}`,
      content: 'Unrelated historical reminder '.repeat(20), sendAt: '2026-10-15T20:00:00Z', recurrence: null,
      isAdvanceNotice: false, parentReminderId: null, requiresConfirmation: false, acknowledgedAt: null }));
    const history = Array.from({ length: 30 }, (_, index) => [
      { role: 'user' as const, content: `Previous request ${index} `.repeat(10) },
      { role: 'assistant' as const, content: `Previous answer ${index} `.repeat(10), toolCalls: [] },
    ]).flat();
    const previous = { userId: 'owner', history, reminders: records, tasks: [], events: [], handledRequestIds: ['old-message'],
      referenceOrder: records.map((record, index) => ({ domain: 'reminders' as const, id: record.id, position: index + 1 })) };
    state.provider = new MockAIProvider([
      { response: answer([{ id: 'select-read', name: 'tools_select', arguments: { name: 'reminder_read' } }]) },
      { response: answer([{ id: 'read', name: 'reminder_read', arguments: { filter: 'today' } }]) },
      { response: answer() },
    ]);
    const wire = new OpenRouterProvider({ apiKey: 'fixture', routes: [{ id: 'primary', model: 'openai/gpt-oss-120b', providers: ['groq'], timeoutMs: 1000 }], estimateInputTokens: estimateBoundedInput });
    Object.assign(state.provider, { estimateNativeInput: wire.estimateNativeInput.bind(wire) });
    untrustedResultMock(domainExecute).mockResolvedValue({ success: true, action: 'listed_reminders', data: { reminders: [
      { id: records[0]!.id, content: 'Salir', send_at: '2026-10-15T20:00:00Z' },
    ] } });
    const route = createCanaryRouter({ baseline: f.baseline, v2: routeCanaryProductivity, policy: () => ({ enabled: true, userAllowlist: ['owner'] }),
      lease: () => f.lease, readPrior: async () => ({ id: 'prior', message_id: 'old-message', thread_id: 'thread', sequence_id: 1, status: 'completed' as const, response: {} }), handoff: async () => previous });
    const result = await withTurnLease(f.lease, () => route('Oye, ¿qué recordatorios tengo para hoy?', user, [], {
      inputModality: 'audio', attachmentOnly: false, agentCoreDelivery: { send: f.send },
    }));
    expect(domainExecute).toHaveBeenCalledOnce(); expect(f.send).toHaveBeenCalledOnce();
    expect(result.confirmation).toContain('Salir');
    expect(state.provider.requests[1]!.tools.map(tool => tool.name)).toEqual(['tools_select', 'reminder_read']);
    expect(JSON.stringify(state.provider.requests[1]!.messages)).not.toContain('Unrelated historical reminder');
    for (const request of state.provider.requests) expect(wire.estimateNativeInput(request)).toBeLessThanOrEqual(2500);
    expect(f.persisted()).toMatchObject({ agentCoreProductivity: { completed: { uiPayload: { notices: [] } }, start: { conversation: { reminders: records, history } } } });
  });
  it('reads through the registered domain adapter, checkpoints and sends exactly once', async () => {
    const f = fixture(); state.provider = new MockAIProvider(discover([{ response: answer([{ id: 'read', name: 'task_read', arguments: { status: 'all' } }]) }, { response: answer() }]));
    untrustedResultMock(domainExecute).mockResolvedValue({ success: true, action: 'listed_tasks', data: { tasks: [{ id: '11111111-1111-4111-8111-111111111111', title: 'Preparar reporte', status: 'pending' }] } });
    const result = await f.run();
    expect(f.baseline).not.toHaveBeenCalled(); expect(domainExecute).toHaveBeenCalledOnce();
    expect(result.confirmation).toContain('Preparar reporte'); expect(result.confirmation).not.toContain('internal instructions');
    expect(scheduleProactiveMemory).toHaveBeenCalledWith(expect.objectContaining({ authoredText: 'Lista mis tareas' }));
    expect(f.send).toHaveBeenCalledOnce(); expect(v2DeliveryReceipt(result)).toEqual(['wamid.v2']);
    expect(f.persisted()).toMatchObject({ agentCoreProductivity: { phase: 'completed', userId: 'owner', runId: 'run', deliveries: [{ status: 'accepted', messageId: 'wamid.v2' }] } });
  });
  it('journals one admitted task completion under scoped discovery and host authorization', async () => {
    const f = fixture(); const id = '11111111-1111-4111-8111-111111111111';
    state.provider = new MockAIProvider(discover([
      { response: answer([{ id: 'read', name: 'task_read', arguments: { status: 'pending' } }]) },
      { response: answer([{ id: 'complete', name: 'task_complete', arguments: { taskId: id } }]) },
      { response: answer() },
    ]));
    untrustedResultMock(domainExecute).mockResolvedValueOnce({ success: true, action: 'listed_tasks', data: { tasks: [{ id, title: 'Preparar reporte', status: 'pending' }] } })
      .mockResolvedValueOnce({ success: true, action: 'completed_task', data: { id, title: 'Preparar reporte', status: 'completed' } });
    await f.run(true);
    expect(domainExecute).toHaveBeenCalledTimes(2);
    expect(domainExecute).toHaveBeenLastCalledWith(expect.objectContaining({ domain: 'tasks', request: { operation: 'complete', input: { taskId: id } }, user: expect.objectContaining({ id: user.id }) }));
    expect(f.send).toHaveBeenCalledOnce(); expect(f.baseline).not.toHaveBeenCalled();
    expect(f.persisted()).toMatchObject({ agentCoreProductivity: { phase: 'completed', effects: [
      { call: { name: 'task_read' }, item: { status: 'success' } }, { call: { name: 'task_complete' }, item: { status: 'success' } },
    ] } });
    expect(state.provider.requests[0]!.tools.some(tool => tool.name === 'task_delete')).toBe(false);
  });
  it('the actual webhook policy authorizes a global tester mutation and keeps a single accepted send', async () => {
    const f = fixture(), webhook = createWhatsAppFixture(); const id = '11111111-1111-4111-8111-111111111111';
    state.provider = new MockAIProvider(discover([
      { response: answer([{ id: 'read', name: 'task_read', arguments: { status: 'pending' } }]) },
      { response: answer([{ id: 'complete', name: 'task_complete', arguments: { taskId: id } }]) },
      { response: answer() },
    ]));
    untrustedResultMock(domainExecute).mockResolvedValueOnce({ success: true, action: 'listed_tasks', data: { tasks: [{ id, title: 'Preparar reporte', status: 'pending' }] } })
      .mockResolvedValueOnce({ success: true, action: 'completed_task', data: { id, title: 'Preparar reporte', status: 'completed' } });
    const baseline = vi.fn(async (): Promise<Awaited<ReturnType<typeof routeCanaryProductivity>>> => ({ intent: 'chat', executionFacts: [], language: 'en', confirmation: 'Baseline', entities: {} }));
    const globalRoute = createCanaryRouter<Awaited<ReturnType<typeof routeCanaryProductivity>>>({ baseline, v2: routeCanaryProductivity,
      policy: () => ({ enabled: true, userAllowlist: [], percentage: 100 }), lease: () => f.lease, readPrior: async () => null });
    webhook.deps.assertTurnLease.mockImplementation(assertTurnLease);
    untrustedResultMock(webhook.deps.routeMessage).mockImplementation((text, owner, history, options) => globalRoute(text, owner, history, options));
    await withTurnLease(f.lease, () => webhook.processWebhookMessage({ headers: {}, body: { message: { id: 'request', from: '573000000001', text: { body: 'Completa la primera tarea' } } } }));
    expect(domainExecute).toHaveBeenCalledTimes(2);
    expect(domainExecute).toHaveBeenLastCalledWith(expect.objectContaining({ domain: 'tasks', request: { operation: 'complete', input: { taskId: id } }, user: expect.objectContaining({ id: 'owner' }) }));
    expect(baseline).not.toHaveBeenCalled(); expect(webhook.deps.sendWhatsAppText).toHaveBeenCalledOnce();
    expect(webhook.deps.saveMessage).toHaveBeenLastCalledWith(expect.objectContaining({ role: 'assistant', messageId: 'wamid.text' }));
    expect(f.persisted()).toMatchObject({ agentCoreProductivity: { phase: 'completed', effects: [
      { item: { status: 'success' } }, { call: { name: 'task_complete' }, item: { status: 'success' } },
    ] } });
  });
  it('canary membership alone does not authorize a write', async () => {
    const f = fixture(); const id = '11111111-1111-4111-8111-111111111111';
    state.provider = new MockAIProvider(discover([
      { response: answer([{ id: 'read', name: 'task_read', arguments: { status: 'pending' } }]) },
      { response: answer([{ id: 'complete', name: 'task_complete', arguments: { taskId: id } }]) },
      { response: answer() },
    ]));
    untrustedResultMock(domainExecute).mockResolvedValue({ success: true, action: 'listed_tasks', data: { tasks: [{ id, title: 'Preparar reporte', status: 'pending' }] } });
    await f.run();
    expect(domainExecute).toHaveBeenCalledOnce(); expect(f.baseline).not.toHaveBeenCalled();
    expect(f.persisted()).toMatchObject({ agentCoreProductivity: { effects: [
      { call: { name: 'task_read' }, item: { status: 'success' } }, { call: { name: 'task_complete' }, item: { status: 'approval_required' } },
    ] } });
  });
  it.each(['task_read', 'task_create', 'task_update', 'task_complete', 'reminder_read', 'reminder_create', 'reminder_update',
    'reminder_acknowledge', 'reminder_cancel', 'task_delete', 'calendar_read', 'calendar_create', 'calendar_connect', 'calendar_update', 'calendar_delete'])('loads the atomic %s wire schema within 2500 without performing discovery effects', async name => {
    const f = fixture(); state.provider = new MockAIProvider([
      { response: answer([{ id: 'select', name: 'tools_select', arguments: { name } }]) }, { response: answer() },
    ]);
    await f.run(); expect(domainExecute).not.toHaveBeenCalled(); expect(state.provider.requests).toHaveLength(2);
    const wire = new OpenRouterProvider({ apiKey: 'fixture', routes: [{ id: 'primary', model: 'openai/gpt-oss-120b', providers: ['groq'], timeoutMs: 1000 }], estimateInputTokens: estimateBoundedInput });
    expect(state.provider.requests[1]!.tools.map(tool => tool.name)).toEqual(['tools_select', name]);
    expect(wire.estimateNativeInput(state.provider.requests[1]!)).toBeLessThanOrEqual(2500);
    expect(f.persisted()).toMatchObject({ agentCoreProductivity: { effects: [] } });
  });
  it('retains strict backend date validation after removing generated regexes from model hints', async () => {
    const f = fixture(); state.provider = new MockAIProvider(discover([{ response: answer([{ id: 'create', name: 'calendar_create',
      arguments: { kind: 'timed', summary: 'Invalid leap date', startIso: '2026-02-29T20:00:00Z', endIso: '2026-02-29T21:00:00Z' } }]) }, { response: answer() }]));
    await f.run(true); expect(domainExecute).not.toHaveBeenCalled();
    expect(f.persisted()).toMatchObject({ agentCoreProductivity: { effects: [{ call: { name: 'calendar_create' }, item: { status: 'validation_failed' } }] } });
    const schema = JSON.stringify(state.provider.requests[1]!.tools.find(tool => tool.name === 'calendar_create')!.inputSchema);
    expect(schema).toContain('date-time'); expect(schema).not.toContain('pattern');
  });
  it('journals transferred references before completing an owned baseline task in V2', async () => {
    const f = fixture(), id = '11111111-1111-4111-8111-111111111111';
    const transferred = { userId: 'owner', history: [], tasks: [{ id, title: 'Reporte', description: null, priority: null,
      status: 'pending' as const, dueDateIso: null, entityId: null, entityName: null }], reminders: [], events: [], handledRequestIds: ['prior-message'],
      referenceOrder: [{ domain: 'tasks' as const, id, position: 1 }] };
    state.provider = new MockAIProvider(discover([{ response: answer([{ id: 'complete', name: 'task_complete', arguments: { taskId: id } }]) }, { response: answer() }]));
    untrustedResultMock(domainExecute).mockImplementation(async () => {
      expect(f.persisted()).toMatchObject({ agentCoreProductivity: { start: { conversation: transferred }, effects: [{ call: { name: 'task_complete' }, item: null }] } });
      return { success: true, action: 'completed_task', data: { id, title: 'Reporte', status: 'completed' } };
    });
    const route = createCanaryRouter({ baseline: f.baseline, v2: routeCanaryProductivity, policy: () => ({ enabled: true, percentage: 100 as const, userAllowlist: [] }),
      lease: () => f.lease, readPrior: async () => ({ id: 'prior', message_id: 'prior-message', thread_id: 'thread', sequence_id: 1, status: 'completed' as const, response: {} }),
      handoff: async () => transferred });
    await withTurnLease(f.lease, () => route('Completa la primera tarea', user, [], { inputModality: 'text', agentCoreDelivery: { send: f.send }, agentCoreAuthorizeWrite: async () => { await assertTurnLease(); return true; } }));
    expect(domainExecute).toHaveBeenCalledOnce(); expect(f.send).toHaveBeenCalledOnce(); expect(f.baseline).not.toHaveBeenCalled();
  });
  it('greets naturally under the native budget with a large historical ledger and a nullable display name', async () => {
    const f = fixture();
    const transferred = { userId: 'owner', history: [], tasks: Array.from({ length: 5 }, (_, index) => ({
      id: `11111111-1111-4111-8111-11111111111${index}`, title: 'Long historical title '.repeat(90),
      description: null, priority: null, status: 'pending' as const, dueDateIso: null, entityId: null, entityName: null,
    })), reminders: [], events: [], handledRequestIds: ['prior-message'] };
    const wire = new OpenRouterProvider({ apiKey: 'fixture', routes: [{ id: 'primary', model: 'openai/gpt-oss-120b', providers: ['groq'], timeoutMs: 1000 }], estimateInputTokens: estimateBoundedInput });
    state.provider = new MockAIProvider([{ response: answer([{ id: 'greeting', name: 'conversation_decide', arguments: { ready: [], reply: '¡Buenos días! ¿Cómo arrancó tu mañana?' } }]) }]);
    Object.assign(state.provider, { estimateNativeInput: wire.estimateNativeInput.bind(wire) });
    const route = createCanaryRouter({ baseline: f.baseline, v2: routeCanaryProductivity, policy: () => ({ enabled: true, percentage: 100 as const, userAllowlist: [] }),
      lease: () => f.lease, readPrior: async () => ({ id: 'prior', message_id: 'prior-message', thread_id: 'thread', sequence_id: 1, status: 'completed' as const, response: {} }), handoff: async () => transferred });
    const result = await withTurnLease(f.lease, () => route('Buenos días', { ...user, display_name: null }, [], { inputModality: 'text', agentCoreDelivery: { send: f.send } }));
    expect(result.confirmation).toContain('¡Buenos días!'); expect(result.intent).toBe('chat');
    expect(state.provider.requests).toHaveLength(1);
    expect(wire.estimateNativeInput(state.provider.requests[0]!)).toBeLessThanOrEqual(2500);
    expect(state.provider.requests[0]!.messages[0]?.content).not.toContain('Long historical title');
    expect(f.persisted()).toMatchObject({ agentCoreProductivity: { completed: { conversation: { tasks: transferred.tasks } } } });
  });
  it('uses the compactor under the 2500 target, exposes one atomic schema and retains durable dialogue', async () => {
    const f = fixture(); const priorHistory = Array.from({ length: 10 }, (_, i) => [
      { role: 'user' as const, content: i < 8 ? `Old ${i} `.repeat(300) : `Recent ${i}` },
      { role: 'assistant' as const, content: `Reply ${i}`, toolCalls: [] },
    ]).flat();
    state.provider = new MockAIProvider(discover([{ response: answer([{ id: 'read', name: 'task_read', arguments: { status: 'all' } }]) }, { response: answer() }]));
    untrustedResultMock(domainExecute).mockResolvedValue({ success: true, action: 'listed_tasks', data: { tasks: [] } });
    const result = await withTurnLease(f.lease, () => routeCanaryProductivity('Lista mis tareas', user, { agentCoreDelivery: { send: f.send } },
      { context: { userId: 'owner', runId: 'run', requestId: 'request', timezone: user.timezone, language: 'es',
        referenceTimeIso: new Date().toISOString(), capabilities: new Set(), signal: f.lease.signal }, threadId: 'thread', prior: null,
        handoff: { userId: 'owner', history: priorHistory, tasks: [], reminders: [], events: [], handledRequestIds: [] } }));
    for (const request of state.provider.requests) {
      expect(request.maxInputTokens).toBe(2500); expect(request.maxTotalTokens).toBeLessThanOrEqual(20000);
      expect(estimateBoundedInput({ messages: request.messages, tools: request.tools })).toBeLessThanOrEqual(2500);
      expect(request.tools.length).toBeLessThanOrEqual(5);
      expect(request.messages.some(message => typeof message.content === 'string' && message.content.includes('Old 0'))).toBe(false);
      expect(request.messages.filter(message => message.role === 'user').at(-1)).toEqual({ role: 'user', content: 'Lista mis tareas' });
      expect(String(request.messages[0]!.content)).toContain('operationalSummary');
    }
    expect(f.persisted()).toMatchObject({ agentCoreProductivity: { start: { conversation: { history: priorHistory } } } });
    expect(result.entities).toMatchObject({ _agentCoreUsage: { inputTarget: 2500, inputTokens: 90, outputTokens: 30, accountingComplete: true } });
  });
  it.each([false, true])('reads then cancels within budget with transcribed audio and prior dialogue=%s', async priorDialogue => {
    const f = fixture(), id = '22222222-2222-4222-8222-222222222222';
    state.provider = new MockAIProvider([
      { response: answer([{ id: 'select', name: 'tools_select', arguments: { name: 'reminder_read' } }]) },
      { response: answer([{ id: 'read', name: 'reminder_read', arguments: { query: 'amoxicilina' } }]) },
      { response: answer([{ id: 'cancel', name: 'reminder_cancel', arguments: { reminderId: id } }]) },
      { response: answer() },
    ]);
    untrustedResultMock(domainExecute).mockResolvedValueOnce({ success: true, action: 'listed_reminders', data: { reminders: [
      { id, content: 'Amoxicilina 500 mg', send_at: '2026-10-15T08:25:00Z', recurrence_rule: 'daily' },
      { id: '33333333-3333-4333-8333-333333333333', content: 'Me amo mucho', send_at: '2026-10-15T13:00:00Z', recurrence_rule: 'daily' },
    ] } }).mockResolvedValueOnce({ success: true, complete: true, action: 'cancelled_recurring_reminder_series', data: {
      cancelledCount: 1, cancelledReminders: [{ id, content: 'Amoxicilina 500 mg', sendAt: '2026-10-15T08:25:00Z', recurrenceRule: 'daily', status: 'cancelled' }],
    } });
    const wire = new OpenRouterProvider({ apiKey: 'fixture', routes: [{ id: 'primary', model: 'openai/gpt-oss-120b', providers: ['groq'], timeoutMs: 1000 }], estimateInputTokens: estimateBoundedInput });
    Object.assign(state.provider, { estimateNativeInput: wire.estimateNativeInput.bind(wire) });
    const history = priorDialogue ? Array.from({ length: 3 }, (_, i) => [
      { role: 'user' as const, content: `Previous request ${i} `.repeat(20) },
      { role: 'assistant' as const, content: `Previous answer ${i} `.repeat(20), toolCalls: [] },
    ]).flat() : [];
    const legacyHandoff = { sourceRunId: 'prior', sourceRequestId: 'prior-message', referenceGaps: Array.from({ length: 50 }, (_, index) => ({
      id: `old-reference-${index}`, type: 'reminder', position: index + 1, title: 'Long historical title '.repeat(10).slice(0, 200), reason: 'missing' as const,
    })) };
    const route = createCanaryRouter({ baseline: f.baseline, v2: routeCanaryProductivity, policy: () => ({ enabled: true, userAllowlist: ['owner'] }), lease: () => f.lease, readPrior: async () => priorDialogue ? { id: 'prior', message_id: 'prior-message', thread_id: 'thread', sequence_id: 1, status: 'completed' as const, response: {} } : null,
      handoff: async () => ({ userId: 'owner', history, tasks: [], reminders: [], events: [], handledRequestIds: [], legacyHandoff }) });
    const result = await withTurnLease(f.lease, () => route('¿Podrías eliminar el recordatorio de la moxicilina, por favor?', user, [], {
      inputModality: 'audio', attachmentOnly: false, agentCoreDelivery: { send: f.send }, agentCoreAuthorizeWrite: async () => { await assertTurnLease(); return true; },
    }));
    expect(domainExecute).toHaveBeenCalledTimes(2); expect(f.send).toHaveBeenCalledOnce(); expect(f.baseline).not.toHaveBeenCalled();
    expect(result.confirmation).toContain('eliminado'); expect(result.confirmation).not.toContain('Algunas acciones solicitadas');
    expect(result.confirmation).toContain('Me amo mucho');
    expect(f.persisted()).toMatchObject({ agentCoreProductivity: { completed: { uiPayload: { notices: [] } }, effects: [
      { call: { name: 'reminder_read' }, item: { status: 'success' } }, { call: { name: 'reminder_cancel' }, item: { status: 'success' } },
    ] } });
    if (priorDialogue) expect(f.persisted()).toMatchObject({ agentCoreProductivity: { completed: { conversation: { legacyHandoff } } } });
    for (const request of state.provider.requests) expect(wire.estimateNativeInput(request)).toBeLessThanOrEqual(2500);
    if (priorDialogue) {
      expect(f.persisted()).toMatchObject({ agentCoreProductivity: { start: { conversation: { history } } } });
      expect(state.provider.requests.some(request => request.messages[0]?.role === 'system' && (request.messages[0].content.includes('operationalSummary') || request.messages.some(message => message.role === 'user' && message.content === history[0]?.content)))).toBe(true);
      expect(state.provider.requests[2]!.messages.at(-1)?.role).toBe('tool');
    }
    expect(state.provider.requests[2]!.tools.some(tool => tool.name === 'reminder_cancel')).toBe(true);
    const observation = state.provider.requests[2]!.messages.find(message => message.role === 'tool' && typeof message.content === 'object' && message.content && 'observation' in message.content && typeof message.content.observation === 'object');
    expect(observation).toMatchObject({ content: { observation: { records: expect.arrayContaining([expect.objectContaining({ id, content: 'Amoxicilina 500 mg', time: '2026-10-15T08:25:00Z' })]) } } });
  });
  it('authorizes one destructive task deletion through V2 while retaining the lease and journal', async () => {
    const f = fixture(), id = '11111111-1111-4111-8111-111111111111';
    state.provider = new MockAIProvider([
      { response: answer([{ id: 'select', name: 'tools_select', arguments: { name: 'task_read' } }]) },
      { response: answer([{ id: 'read', name: 'task_read', arguments: { status: 'pending' } }]) },
      { response: answer([{ id: 'delete', name: 'task_delete', arguments: { taskId: id } }]) }, { response: answer() },
    ]);
    untrustedResultMock(domainExecute).mockResolvedValueOnce({ success: true, action: 'listed_tasks', data: { tasks: [{ id, title: 'Report', status: 'pending' }] } })
      .mockResolvedValueOnce({ success: true, action: 'deleted_task', data: { id, title: 'Report', status: 'deleted' } });
    await f.run(true); expect(domainExecute).toHaveBeenCalledTimes(2); expect(f.send).toHaveBeenCalledOnce();
    expect(f.persisted()).toMatchObject({ agentCoreProductivity: { completed: { uiPayload: { notices: [] } }, effects: [
      { call: { name: 'task_read' } }, { call: { name: 'task_delete' }, item: { status: 'success' } },
    ] } });
  });
  it('requires host authorization for reminder cancellation despite canary membership', async () => {
    const f = fixture(), id = '22222222-2222-4222-8222-222222222222';
    state.provider = new MockAIProvider([
      { response: answer([{ id: 'select', name: 'tools_select', arguments: { name: 'reminder_read' } }]) },
      { response: answer([{ id: 'read', name: 'reminder_read', arguments: { query: 'amoxicilina' } }]) },
      { response: answer([{ id: 'cancel', name: 'reminder_cancel', arguments: { reminderId: id } }]) }, { response: answer() },
    ]);
    untrustedResultMock(domainExecute).mockResolvedValue({ success: true, action: 'listed_reminders', data: { reminders: [{ id, content: 'Amoxicilina' }] } });
    await f.run(); expect(domainExecute).toHaveBeenCalledOnce();
    expect(f.persisted()).toMatchObject({ agentCoreProductivity: { effects: [{ call: { name: 'reminder_read' } }, { call: { name: 'reminder_cancel' }, item: { status: 'approval_required' } }] } });
  });
  it('blocks an oversized essential turn before inference or domain writes', async () => {
    const f = fixture(); state.provider = new MockAIProvider([]);
    await withTurnLease(f.lease, () => routeCanaryProductivity('🧬'.repeat(3500), user, { agentCoreDelivery: { send: f.send } },
      { context: { userId: 'owner', runId: 'run', requestId: 'request', timezone: user.timezone, language: 'es',
        referenceTimeIso: new Date().toISOString(), capabilities: new Set(), signal: f.lease.signal }, threadId: 'thread', prior: null }));
    expect(state.provider.requests).toHaveLength(0); expect(domainExecute).not.toHaveBeenCalled();
    expect(f.persisted()).toMatchObject({ agentCoreProductivity: { completed: { uiPayload: { notices: ['limit_reached'] } } } });
  });
  it('denies unadvertised domain calls even when selected in the same batch', async () => {
    const f = fixture(); state.provider = new MockAIProvider([{ response: answer([
      { id: 'select', name: 'tools_select', arguments: { name: 'calendar_read' } },
      { id: 'bypass', name: 'calendar_read', arguments: {} },
    ]) }, { response: answer() }]);
    await f.run(true); expect(domainExecute).not.toHaveBeenCalled();
    expect(f.persisted()).toMatchObject({ agentCoreProductivity: { completed: { uiPayload: { notices: ['unavailable_tool'] } } } });
  });
  it('creates a fresh voice reminder under 2500 with a large historical reminder ledger and optional personal data', async () => {
    const f = fixture(); const id = '11111111-1111-4111-8111-111111111111';
    const records = Array.from({ length: 5 }, (_, index) => ({ id: `22222222-2222-4222-8222-22222222222${index}`,
      content: 'Historical unrelated reminder '.repeat(20), sendAt: '2026-10-15T20:00:00Z', recurrence: null,
      isAdvanceNotice: false, parentReminderId: null, requiresConfirmation: false, acknowledgedAt: null }));
    const previous = { userId: 'owner', history: [], reminders: records, tasks: [], events: [], handledRequestIds: ['old-message'],
      referenceOrder: records.map((record, index) => ({ domain: 'reminders' as const, id: record.id, position: index + 1 })) };
    state.provider = new MockAIProvider([
      { response: answer([{ id: 'select-create', name: 'tools_select', arguments: { name: 'reminder_create' } }]) },
      { response: answer([{ id: 'create', name: 'reminder_create', arguments: { content: 'Salir', targetTimeIso: '2026-10-15T20:10:00Z' } }]) },
      { response: answer() },
    ]);
    const wire = new OpenRouterProvider({ apiKey: 'fixture', routes: [{ id: 'primary', model: 'openai/gpt-oss-120b', providers: ['groq'], timeoutMs: 1000 }], estimateInputTokens: estimateBoundedInput });
    Object.assign(state.provider, { estimateNativeInput: wire.estimateNativeInput.bind(wire) });
    untrustedResultMock(domainExecute).mockResolvedValue({ success: true, action: 'created_reminders_batch', data: [{ id, content: 'Salir', sendAt: '2026-10-15T20:10:00Z' }] });
    const route = createCanaryRouter({ baseline: f.baseline, v2: routeCanaryProductivity, policy: () => ({ enabled: true, userAllowlist: ['owner'] }),
      lease: () => f.lease, readPrior: async () => ({ id: 'prior', message_id: 'old-message', thread_id: 'thread', sequence_id: 1, status: 'completed' as const, response: {} }), handoff: async () => previous });
    const result = await withTurnLease(f.lease, () => route('Me recuerdo en 10 segundos, en 10 minutos que tengo que salir, porfa.', user, [], {
      inputModality: 'audio', currentUserText: 'Me recuerdo en 10 segundos, en 10 minutos que tengo que salir, porfa.', agentCoreDelivery: { send: f.send }, agentCoreAuthorizeWrite: async () => true,
    }));
    expect(domainExecute).toHaveBeenCalledOnce(); expect(f.send).toHaveBeenCalledOnce(); expect(f.baseline).not.toHaveBeenCalled();
    expect(result.confirmation).toContain('Salir'); expect(f.persisted()).toMatchObject({ agentCoreProductivity: { completed: { uiPayload: { notices: [] } } } });
    expect(f.persisted()).toMatchObject({ agentCoreProductivity: { start: { conversation: { reminders: records } } } });
    for (const request of state.provider.requests) expect(wire.estimateNativeInput(request)).toBeLessThanOrEqual(2500);
  });
  it('keeps every schema selected together available for the next compound action batch', async () => {
    const f = fixture(); const id = '11111111-1111-4111-8111-111111111111';
    state.provider = new MockAIProvider([
      { response: answer([{ id: 'select-reminder', name: 'tools_select', arguments: { name: 'reminder_create' } }, { id: 'select-task', name: 'tools_select', arguments: { name: 'task_create' } }]) },
      { response: answer([{ id: 'create-reminder', name: 'reminder_create', arguments: { content: 'Salir', targetTimeIso: '2026-10-15T20:00:00Z' } }, { id: 'create-task', name: 'task_create', arguments: { title: 'Preparar informe' } }]) },
      { response: answer() },
    ]);
    untrustedResultMock(domainExecute).mockResolvedValueOnce({ success: true, action: 'created_reminders_batch', data: [{ id, content: 'Salir', sendAt: '2026-10-15T20:00:00Z' }] })
      .mockResolvedValueOnce({ success: true, action: 'created_tasks_batch', data: [{ id, title: 'Preparar informe', status: 'pending' }] });
    const result = await f.run(true);
    expect(state.provider.requests[1]!.tools.map(tool => tool.name)).toEqual(['tools_select','task_create','reminder_create']);
    expect(domainExecute).toHaveBeenCalledTimes(2); expect(result.confirmation).toContain('Salir'); expect(result.confirmation).toContain('Preparar informe');
    expect(f.persisted()).toMatchObject({ agentCoreProductivity: { completed: { uiPayload: { notices: [] } } } });
  });
  it('supports batch selection of multiple schemas using names array in a single tools_select call', async () => {
    const f = fixture(); const id = '11111111-1111-4111-8111-111111111111';
    state.provider = new MockAIProvider([
      { response: answer([{ id: 'select-batch', name: 'tools_select', arguments: { names: ['reminder_create', 'task_create'] } }]) },
      { response: answer([{ id: 'create-reminder', name: 'reminder_create', arguments: { content: 'Salir', targetTimeIso: '2026-10-15T20:00:00Z' } }, { id: 'create-task', name: 'task_create', arguments: { title: 'Preparar informe' } }]) },
      { response: answer() },
    ]);
    untrustedResultMock(domainExecute).mockResolvedValueOnce({ success: true, action: 'created_reminders_batch', data: [{ id, content: 'Salir', sendAt: '2026-10-15T20:00:00Z' }] })
      .mockResolvedValueOnce({ success: true, action: 'created_tasks_batch', data: [{ id, title: 'Preparar informe', status: 'pending' }] });
    const result = await f.run(true);
    expect(state.provider.requests[1]!.tools.map(tool => tool.name)).toEqual(['tools_select', 'task_create', 'reminder_create']);
    expect(domainExecute).toHaveBeenCalledTimes(2);
    expect(result.confirmation).toContain('Salir');
    expect(result.confirmation).toContain('Preparar informe');
    expect(f.persisted()).toMatchObject({ agentCoreProductivity: { completed: { uiPayload: { notices: [] } } } });
  });
  it('retains consecutive explicit selections and permits idempotent rediscovery', async () => {
    const f = fixture(), id = '11111111-1111-4111-8111-111111111111';
    state.provider = new MockAIProvider([
      { response: answer([{ id: 'select-reminder', name: 'tools_select', arguments: { name: 'reminder_create' } }]) },
      { response: answer([{ id: 'select-task', name: 'tools_select', arguments: { name: 'task_create' } }]) },
      { response: answer([{ id: 'create-reminder', name: 'reminder_create', arguments: { content: 'Salir', delayMinutes: 10, turnDisposition: 'continue' } },
        { id: 'create-task', name: 'task_create', arguments: { title: 'Preparar informe', turnDisposition: 'finish' } }]) },
      { response: new Error('No redundant final inference') },
    ]);
    untrustedResultMock(domainExecute).mockResolvedValueOnce({ success: true, action: 'created_reminders_batch', data: [{ id, content: 'Salir', sendAt: '2026-10-15T20:00:00Z' }] })
      .mockResolvedValueOnce({ success: true, action: 'created_tasks_batch', data: [{ id, title: 'Preparar informe', status: 'pending' }] });
    await f.run(true, 'Crea un recordatorio y una tarea');
    expect(state.provider.requests).toHaveLength(3); expect(domainExecute).toHaveBeenCalledTimes(2);
    expect(state.provider.requests[2]!.tools.map(tool => tool.name)).toEqual(['tools_select', 'task_create', 'reminder_create']);
    expect(JSON.stringify(state.provider.requests[1]!.tools[0]!.inputSchema)).toContain('reminder_create');
    expect(f.persisted()).toMatchObject({ agentCoreProductivity: { completed: { uiPayload: { notices: [] } } } });
  });
  it('failed delivery is fenced as unknown and never executes baseline', async () => {
    const f = fixture(); state.provider = new MockAIProvider(discover([{ response: answer() }])); f.send.mockRejectedValue(new Error('timeout'));
    await expect(f.run()).rejects.toMatchObject({ code: 'DELIVERY_OUTCOME_UNKNOWN' }); expect(scheduleProactiveMemory).not.toHaveBeenCalled();
    expect(f.baseline).not.toHaveBeenCalled(); expect(f.send).toHaveBeenCalledOnce();
    expect(f.persisted()).toMatchObject({ agentCoreProductivity: { deliveries: [{ status: 'unknown', messageId: null }] } });
  });
});

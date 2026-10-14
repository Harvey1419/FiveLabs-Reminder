import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockAIProvider } from '@templelabs/ai';
import type { JsonObject, AIResponse } from '@templelabs/contracts';
import { untrustedResultMock } from '../../support/unit/contract-boundary.js';
const state = vi.hoisted(() => ({ provider: null as MockAIProvider | null }));
vi.mock('../../../src/adapters/agent-core/configured-ai-provider.js', () => ({ createConfiguredAIProvider: () => state.provider }));
vi.mock('../../../src/infrastructure/database/index.js', () => ({ getUserSubscription: vi.fn(async () => null), hasProAccess: vi.fn(() => false) }));
vi.mock('../../../src/agent/tools/index.js', () => ({ executeTool: vi.fn() }));
import { routeCanaryProductivity } from '../../../src/adapters/agent-core/canary-productivity-router.js';
import { v2DeliveryReceipt } from '../../../src/adapters/agent-core/canary-delivery-receipt.js';
import { executeTool } from '../../../src/agent/tools/index.js';
import { createWhatsAppFixture } from '../../support/unit/whatsapp-fixture.js';
import { withTurnLease, assertTurnLease } from '../../../src/agent/core/turn-lease.js';
import { createCanaryRouter } from '../../../src/agent/orchestration/canary-router.js';

const user = { id: 'owner', timezone: 'America/Bogota', locale: 'es-CO' };
function answer(calls: AIResponse['message']['toolCalls'] = []): AIResponse {
  return { message: { role: 'assistant', content: 'internal instructions', toolCalls: calls }, stopReason: calls.length ? 'tool_calls' : 'completed', usage: { inputTokens: 30, outputTokens: 10 } };
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
    run: (authorized = false) => withTurnLease(lease, () => route('Lista mis tareas', user, [], { inputModality: 'text', agentCoreDelivery: { send }, ...(authorized ? { agentCoreAuthorizeWrite: async () => true } : {}) })) };
}
describe('canary admission executes actual durable V2 composition', () => {
  it('reads through the registered domain adapter, checkpoints and sends exactly once', async () => {
    const f = fixture(); state.provider = new MockAIProvider([{ response: answer([{ id: 'read', name: 'task_read', arguments: { status: 'all' } }]) }, { response: answer() }]);
    untrustedResultMock(executeTool).mockResolvedValue({ success: true, action: 'listed_tasks', data: { tasks: [{ id: '11111111-1111-4111-8111-111111111111', title: 'Preparar reporte', status: 'pending' }] } });
    const result = await f.run();
    expect(f.baseline).not.toHaveBeenCalled(); expect(executeTool).toHaveBeenCalledOnce();
    expect(result.confirmation).toContain('Preparar reporte'); expect(result.confirmation).not.toContain('internal instructions');
    expect(f.send).toHaveBeenCalledOnce(); expect(v2DeliveryReceipt(result)).toEqual(['wamid.v2']);
    expect(f.persisted()).toMatchObject({ agentCoreProductivity: { phase: 'completed', userId: 'owner', runId: 'run', deliveries: [{ status: 'accepted', messageId: 'wamid.v2' }] } });
  });
  it('journals one admitted task completion and never dispatches a destructive delete capability', async () => {
    const f = fixture(); const id = '11111111-1111-4111-8111-111111111111';
    state.provider = new MockAIProvider([
      { response: answer([{ id: 'read', name: 'task_read', arguments: { status: 'pending' } }]) },
      { response: answer([{ id: 'complete', name: 'task_complete', arguments: { taskId: id } }]) },
      { response: answer() },
    ]);
    untrustedResultMock(executeTool).mockResolvedValueOnce({ success: true, action: 'listed_tasks', data: { tasks: [{ id, title: 'Preparar reporte', status: 'pending' }] } })
      .mockResolvedValueOnce({ success: true, action: 'completed_task', data: { id, title: 'Preparar reporte', status: 'completed' } });
    await f.run(true);
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(executeTool).toHaveBeenLastCalledWith(expect.objectContaining({ params: { action: 'complete', target: id }, user: expect.objectContaining({ id: user.id }) }));
    expect(f.send).toHaveBeenCalledOnce(); expect(f.baseline).not.toHaveBeenCalled();
    expect(f.persisted()).toMatchObject({ agentCoreProductivity: { phase: 'completed', effects: [
      { call: { name: 'task_read' }, item: { status: 'success' } }, { call: { name: 'task_complete' }, item: { status: 'success' } },
    ] } });
    expect(state.provider.requests[0]!.tools.some(tool => tool.name === 'task_delete')).toBe(false);
  });
  it('the actual webhook policy authorizes a global tester mutation and keeps a single accepted send', async () => {
    const f = fixture(), webhook = createWhatsAppFixture(); const id = '11111111-1111-4111-8111-111111111111';
    state.provider = new MockAIProvider([
      { response: answer([{ id: 'read', name: 'task_read', arguments: { status: 'pending' } }]) },
      { response: answer([{ id: 'complete', name: 'task_complete', arguments: { taskId: id } }]) },
      { response: answer() },
    ]);
    untrustedResultMock(executeTool).mockResolvedValueOnce({ success: true, action: 'listed_tasks', data: { tasks: [{ id, title: 'Preparar reporte', status: 'pending' }] } })
      .mockResolvedValueOnce({ success: true, action: 'completed_task', data: { id, title: 'Preparar reporte', status: 'completed' } });
    const baseline = vi.fn(async (): Promise<Awaited<ReturnType<typeof routeCanaryProductivity>>> => ({ intent: 'chat', executionFacts: [], language: 'en', confirmation: 'Baseline' }));
    const globalRoute = createCanaryRouter<Awaited<ReturnType<typeof routeCanaryProductivity>>>({ baseline, v2: routeCanaryProductivity,
      policy: () => ({ enabled: true, userAllowlist: [], percentage: 100 }), lease: () => f.lease, readPrior: async () => null });
    webhook.deps.assertTurnLease.mockImplementation(assertTurnLease);
    untrustedResultMock(webhook.deps.routeMessage).mockImplementation((text, owner, history, options) => globalRoute(text, owner, history, options));
    await withTurnLease(f.lease, () => webhook.processWebhookMessage({ headers: {}, body: { message: { id: 'request', from: '573000000001', text: { body: 'Completa la primera tarea' } } } }));
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(executeTool).toHaveBeenLastCalledWith(expect.objectContaining({ params: { action: 'complete', target: id }, user: expect.objectContaining({ id: 'owner' }) }));
    expect(baseline).not.toHaveBeenCalled(); expect(webhook.deps.sendWhatsAppText).toHaveBeenCalledOnce();
    expect(webhook.deps.saveMessage).toHaveBeenLastCalledWith(expect.objectContaining({ role: 'assistant', messageId: 'wamid.text' }));
    expect(f.persisted()).toMatchObject({ agentCoreProductivity: { phase: 'completed', effects: [
      { item: { status: 'success' } }, { call: { name: 'task_complete' }, item: { status: 'success' } },
    ] } });
  });
  it('canary membership alone does not authorize a write', async () => {
    const f = fixture(); const id = '11111111-1111-4111-8111-111111111111';
    state.provider = new MockAIProvider([
      { response: answer([{ id: 'read', name: 'task_read', arguments: { status: 'pending' } }]) },
      { response: answer([{ id: 'complete', name: 'task_complete', arguments: { taskId: id } }]) },
      { response: answer() },
    ]);
    untrustedResultMock(executeTool).mockResolvedValue({ success: true, action: 'listed_tasks', data: { tasks: [{ id, title: 'Preparar reporte', status: 'pending' }] } });
    await f.run();
    expect(executeTool).toHaveBeenCalledOnce(); expect(f.baseline).not.toHaveBeenCalled();
    expect(f.persisted()).toMatchObject({ agentCoreProductivity: { effects: [
      { call: { name: 'task_read' }, item: { status: 'success' } }, { call: { name: 'task_complete' }, item: { status: 'approval_required' } },
    ] } });
  });
  it('failed delivery is fenced as unknown and never executes baseline', async () => {
    const f = fixture(); state.provider = new MockAIProvider([{ response: answer() }]); f.send.mockRejectedValue(new Error('timeout'));
    await expect(f.run()).rejects.toMatchObject({ code: 'DELIVERY_OUTCOME_UNKNOWN' });
    expect(f.baseline).not.toHaveBeenCalled(); expect(f.send).toHaveBeenCalledOnce();
    expect(f.persisted()).toMatchObject({ agentCoreProductivity: { deliveries: [{ status: 'unknown', messageId: null }] } });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { type AIResponse, type TurnContext, productivityCheckpointSchema } from '@templelabs/contracts';
import { setup, context, taskId, response } from '../../unit/agent-core/productivity-fixtures.js';
import { withTurnLease } from '../../../src/agent/core/turn-lease.js';
import { createCanaryRouter } from '../../../src/agent/orchestration/canary-router.js';
import { handoffBaselineProductivity, type BaselineHandoffSource } from '../../../src/adapters/agent-core/baseline-productivity-handoff.js';
import { readPriorInboundTurn, type InboundStoredTurn, type InboundCheckpointClient } from '../../../src/adapters/agent-core/inbound-checkpoint-reader.js';
import { recoverProductivityStoredTurn } from '../../../src/adapters/agent-core/productivity-state-recovery.js';

const user = { id: context.userId, timezone: context.timezone, locale: 'es-CO' };
const hello: AIResponse = { ...response(), message: { role: 'assistant', content: '¡Buenos días! ¿Cómo arrancó tu mañana?', toolCalls: [] } };
function old(response: InboundStoredTurn['response'], status: InboundStoredTurn['status'] = 'completed'): InboundStoredTurn {
  return { id: 'old', message_id: 'old-msg', thread_id: 'thread', sequence_id: 10, status, response };
}
/** Only storage/provider/transport are simulated; admission, reader, handoff, loop,
 * journal, recovery and presenter are production implementations. */
function journey(prior: InboundStoredTurn[], script: AIResponse[] = [hello], identity: TurnContext = context) {
  const s = setup(script);
  const lease = { ...s.lease, inboundTurn: { ...s.lease.inboundTurn, id: identity.runId, messageId: identity.requestId } };
  const anchor: InboundStoredTurn = { id: identity.runId, message_id: identity.requestId, thread_id: 'thread', sequence_id: 100, status: 'running', response: {} };
  const rows = [anchor, ...prior];
  const client: InboundCheckpointClient = { from: () => ({ select: () => {
    const eqs = new Map<string, string>(); let before = Infinity; let statuses: string[] = [];
    const query = { eq: (key: string, value: string) => { eqs.set(key, value); return query; },
      lt: (_key: string, value: number) => { before = value; return query; },
      in: (_key: string, value: string[]) => { statuses = value; return query; },
      order: () => query, limit: () => query, abortSignal: () => query,
      maybeSingle: async () => ({ data: rows.filter(row => row.sequence_id < before && [...eqs].every(([key, value]) => row[key as keyof InboundStoredTurn] === value)
        && (!statuses.length || statuses.includes(row.status))).sort((a, b) => b.sequence_id - a.sequence_id)[0] ?? null, error: null }) };
    return query;
  } }) };
  const source: BaselineHandoffSource = { hasActiveRun: vi.fn(async () => false), readTask: vi.fn<BaselineHandoffSource['readTask']>(async id => id === taskId ? {
    id, title: 'Propuesta', description: null, priority: null, status: 'pending', dueDateIso: null, entityId: null, entityName: null,
  } : null), readReminder: vi.fn(async () => null), readEvent: vi.fn(async () => null) };
  const baseline = vi.fn(async (): Promise<Awaited<ReturnType<typeof s.assistant.handle>>> => { throw new Error('V1 must not execute'); });
  const route = createCanaryRouter({ baseline, policy: () => ({ enabled: true, userAllowlist: ['owner'] }), lease: () => lease,
    readPrior: (ctx, thread) => readPriorInboundTurn(client, ctx, thread, () => {
      throw Object.assign(new Error('Uncertain prior effects'), { code: 'PRIOR_TURN_RECONCILIATION_REQUIRED' });
    }),
    handoff: (row, ctx, thread, history) => handoffBaselineProductivity(row, ctx, thread, history, source),
    v2: (text, _user, _options, admission) => s.assistant.handle(text, { ...admission.context, capabilities: context.capabilities }, admission.threadId,
      admission.handoff ?? (admission.prior ? recoverProductivityStoredTurn(admission.prior, admission.context.userId) : undefined)),
  });
  return { ...s, lease, source, baseline, run: (text = 'Buenos días', history: readonly unknown[] = []) => withTurnLease(lease,
    () => route(text, user, history, { inputModality: 'audio', attachmentOnly: false, agentCoreDelivery: { send: s.send } })) };
}
describe('V2 migration and non-replay continuity under a durable inbound lease', () => {
  it('hands off historical task references and transcribed audio, mutates once and excludes the current message from imported history', async () => {
    const prior = old({ confirmation: 'Propuesta pendiente', entities: { _workingMemory: { items: [{ id: taskId, type: 'task', position: 2 }] } } });
    const evidence = structuredClone(prior);
    const s = journey([prior], [response([{ id: 'complete', name: 'task_complete', arguments: { taskId } }]), hello]);
    const result = await s.run('Completa esa tarea', [{ role: 'user', content: 'Completa esa tarea', messageId: context.requestId }]);
    expect(result.conversation.tasks[0]?.status).toBe('completed');
    expect(result.conversation.history.filter(message => message.role === 'user' && message.content === 'Completa esa tarea')).toHaveLength(1);
    expect(result.conversation.legacyHandoff).toMatchObject({ sourceRunId: 'old', sourceRequestId: 'old-msg' });
    expect(s.execute).toHaveBeenCalledOnce(); expect(s.send).toHaveBeenCalledTimes(2);
    expect(new Set(s.send.mock.calls.map(([message]) => message.id)).size).toBe(2); expect(s.baseline).not.toHaveBeenCalled();
    expect(prior).toEqual(evidence);
    expect(recoverProductivityStoredTurn({ ...old(s.snapshot()), id: context.runId, message_id: context.requestId }, 'owner').legacyHandoff).toEqual(result.conversation.legacyHandoff);
  });
  it('imports a completed empty response as dialogue and delivers a natural greeting', async () => {
    const s = journey([old(null)]);
    const result = await s.run();
    expect(result.reply.text).toBe(hello.message.content);
    expect(result.conversation.tasks).toEqual([]); expect(s.execute).not.toHaveBeenCalled();
    expect(s.send).toHaveBeenCalledOnce(); expect(s.baseline).not.toHaveBeenCalled();
  });
  it.each(['unknown', 'completed'] as const)('skips safe %s admission closures without mutating old evidence', async status => {
    const rejection = { ...old(null, status), id: 'gate', message_id: 'gate-msg', sequence_id: 20, last_error: 'PRIOR_TURN_RECONCILIATION_REQUIRED' };
    const evidence = structuredClone(rejection);
    const s = journey([rejection, old({ confirmation: 'Hola' })]);
    expect((await s.run()).conversation.legacyHandoff?.sourceRunId).toBe('old');
    expect(rejection).toEqual(evidence); expect(s.send).toHaveBeenCalledOnce(); expect(s.baseline).not.toHaveBeenCalled();
  });
  it('preserves missing IDs as historical hints but never authorizes their mutation', async () => {
    const missing = '99999999-9999-4999-8999-999999999999';
    const s = journey([old({ entities: { _workingMemory: { items: [{ id: missing, type: 'task', title: 'Old task', position: 1 }] } } })],
      [response([{ id: 'complete', name: 'task_complete', arguments: { taskId: missing } }]), hello]);
    const result = await s.run('Completa la tarea anterior');
    expect(result.conversation.legacyHandoff?.referenceGaps).toMatchObject([{ id: missing, reason: 'missing' }]);
    expect(s.execute).not.toHaveBeenCalled(); expect(s.baseline).not.toHaveBeenCalled();
    expect(s.provider.requests.some(request => request.messages.some(message => JSON.stringify(message.content).includes('historicalReferenceGaps')))).toBe(true);
  });
  it('continues a certified V2 checkpoint without repeating the previous write or delivery', async () => {
    const first = journey([old(null)], [response([{ id: 'create', name: 'task_create', arguments: { title: 'Propuesta', scheduleReminder: false } }]), hello]);
    await first.run('Crea la tarea');
    const checkpoint = { ...old(first.snapshot()), id: context.runId, message_id: context.requestId };
    const second = journey([checkpoint], [hello], { ...context, runId: 'next', requestId: 'next-msg' });
    const result = await second.run('Gracias');
    expect(result.conversation.handledRequestIds).toEqual(['old-msg', 'request', 'next-msg']);
    expect(second.execute).not.toHaveBeenCalled(); expect(second.send).toHaveBeenCalledOnce();
    expect(first.execute).toHaveBeenCalledOnce(); expect(first.send).toHaveBeenCalledTimes(2);
  });
  it.each(['write', 'send'] as const)('quarantines an interrupted %s and never retries in either engine', async kind => {
    const first = setup(kind === 'write' ? [response([{ id: 'create', name: 'task_create', arguments: { title: 'Propuesta', scheduleReminder: false } }]), hello] : [hello]);
    if (kind === 'write') first.fail(3); // Outcome checkpoint lost after dispatch; pre-dispatch proof remains.
    else first.send.mockRejectedValue(new Error('Transport receipt lost'));
    await expect(first.run()).rejects.toThrow();
    const interrupted = { ...old(first.snapshot(), 'unknown'), id: context.runId, message_id: context.requestId, sequence_id: 5 };
    const evidence = structuredClone(interrupted);
    const s = journey([interrupted, old({ confirmation: 'Later conversation' })], [hello], { ...context, runId: 'next', requestId: 'next-msg' });
    await expect(s.run()).rejects.toMatchObject({ code: 'PRIOR_TURN_RECONCILIATION_REQUIRED' });
    expect(s.execute).not.toHaveBeenCalled(); expect(s.send).not.toHaveBeenCalled(); expect(s.baseline).not.toHaveBeenCalled();
    expect(s.lease.checkpoint).toHaveBeenCalledWith({ agentCoreAdmissionRejected: expect.objectContaining({ effects: 'none' }) });
    expect(interrupted).toEqual(evidence);
    const durable = productivityCheckpointSchema.parse(first.snapshot().agentCoreProductivity);
    if (kind === 'write') { expect(durable.effects[0]?.item).toBeNull(); expect(first.execute).toHaveBeenCalledOnce(); }
    else { expect(durable.deliveries[0]?.status).toBe('unknown'); expect(first.send).toHaveBeenCalledOnce(); }
  });
});

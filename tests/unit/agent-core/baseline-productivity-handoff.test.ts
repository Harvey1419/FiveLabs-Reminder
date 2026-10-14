import { describe, expect, it, vi } from 'vitest';
import type { InboundStoredTurn } from '../../../src/adapters/agent-core/inbound-checkpoint-reader.js';
import type { TurnContext } from '@templelabs/contracts';
import { handoffBaselineProductivity, createBaselineHandoffSource, type BaselineHandoffSource } from '../../../src/adapters/agent-core/baseline-productivity-handoff.js';
const id = '11111111-1111-4111-8111-111111111111';
const context: TurnContext = { userId: 'owner', runId: 'current', requestId: 'current-msg', timezone: 'America/Bogota', language: 'es', referenceTimeIso: '2026-10-13T12:00:00Z', capabilities: new Set(), signal: new AbortController().signal };
function fixture() {
  const prior: InboundStoredTurn = { id: 'prior', message_id: 'prior-msg', thread_id: 'thread', sequence_id: 1, status: 'completed', response: {
    confirmation: '1. Preparar reporte', entities: { _workingMemory: { items: [{ internalId: id, type: 'task', position: 1 }] } },
  } };
  const source: BaselineHandoffSource = { hasActiveRun: vi.fn(async () => false),
    readTask: vi.fn(async () => ({ id, title: 'Preparar reporte', description: null, priority: null, status: 'pending' as const, dueDateIso: null, entityId: null, entityName: null })),
    readReminder: vi.fn(async () => null), readEvent: vi.fn(async () => null) };
  return { prior, source, run: () => handoffBaselineProductivity(prior, context, 'thread', [{ role: 'user', content: 'Lista mis tareas' }], source) };
}
describe('completed baseline productivity handoff', () => {
  it('imports dialogue from a completed legacy closure with a missing response without fabricating references', async () => {
    const f = fixture(); Reflect.deleteProperty(f.prior, 'response');
    expect(await f.run()).toMatchObject({ tasks: [], history: [{ role: 'user' }], legacyHandoff: { sourceRunId: 'prior' } });
    expect(f.source.readTask).not.toHaveBeenCalled();
  });
  it('imports a completed empty legacy conversation without throwing or inventing receipts', async () => {
    const f = fixture(); f.prior.response = null;
    expect(await f.run()).toMatchObject({ tasks: [], reminders: [], events: [], legacyHandoff: { referenceGaps: [] } });
    expect(f.source.readTask).not.toHaveBeenCalled();
  });
  it('preserves dialogue, observed owner-bound IDs and ordinal references without fabricating tool receipts', async () => {
    const f = fixture(), state = await f.run();
    expect(state).toMatchObject({ userId: 'owner', handledRequestIds: ['prior-msg'], tasks: [{ id, status: 'pending' }],
      referenceOrder: [{ domain: 'tasks', id, position: 1 }], history: [{ role: 'user' }, { role: 'assistant', content: '1. Preparar reporte', toolCalls: [] }] });
    expect(f.source.readTask).toHaveBeenCalledExactlyOnceWith(id, context);
    expect(state!.history.some(message => message.role === 'tool')).toBe(false);
  });
  it('preserves ordinal gaps and unsupported references without treating them as observed resources', async () => {
    const f = fixture();
    f.prior.response!.entities = { _workingMemory: { items: [
      { id: 'missing', type: 'task', position: 1, title: 'Old task' },
      { id, type: 'task', position: 2 },
      { id: 'project-old', type: 'project', position: 3, title: 'Old project' },
    ] } };
    vi.mocked(f.source.readTask).mockImplementation(async key => key === id ? {
      id, title: 'Preparar reporte', description: null, priority: null, status: 'pending', dueDateIso: null, entityId: null, entityName: null,
    } : null);
    expect(await f.run()).toMatchObject({ referenceOrder: [{ id, position: 2 }], legacyHandoff: {
      sourceRunId: 'prior', sourceRequestId: 'prior-msg', referenceGaps: [
        { id: 'missing', position: 1, reason: 'missing' }, { id: 'project-old', position: 3, reason: 'unsupported' },
      ],
    } });
    expect(f.source.readTask).toHaveBeenCalledTimes(2);
  });
  it('excludes the queued current message by identity while preserving identical older dialogue', async () => {
    const f = fixture();
    const state = await handoffBaselineProductivity(f.prior, context, 'thread', [
      { role: 'user', content: 'Completa esa tarea', messageId: 'older-msg' },
      { role: 'user', content: 'Completa esa tarea', messageId: context.requestId },
    ], f.source);
    expect(state!.history).toEqual([
      { role: 'user', content: 'Completa esa tarea' },
      { role: 'assistant', content: '1. Preparar reporte', toolCalls: [] },
    ]);
  });
  it.each(['duplicate', 'missing-id', 'mismatched-row'])('rejects malformed historical references: %s', async kind => {
    const f = fixture();
    if (kind === 'duplicate') f.prior.response!.entities = { _workingMemory: { items: [{ id, type: 'task' }, { id, type: 'task' }] } };
    if (kind === 'missing-id') f.prior.response!.entities = { _workingMemory: { items: [{ type: 'task' }] } };
    if (kind === 'mismatched-row') vi.mocked(f.source.readTask).mockResolvedValue({
      id: 'foreign', title: null, description: null, priority: null, status: 'pending', dueDateIso: null, entityId: null, entityName: null,
    });
    await expect(f.run()).rejects.toThrow('HANDOFF_');
  });
  it('bounds old dialogue to six messages and 2400 characters without altering source history', async () => {
    const f = fixture();
    const history = Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `old-${index}:` + 'x'.repeat(2000) }));
    const original = structuredClone(history);
    const state = await handoffBaselineProductivity(f.prior, context, 'thread', history, f.source);
    expect(state!.history.length).toBeLessThanOrEqual(6);
    expect(state!.history.reduce((size, message) => size + String(message.content).length, 0)).toBeLessThanOrEqual(2400);
    expect(state!.history.every(message => String(message.content).length <= 800)).toBe(true);
    expect(state!.history.some(message => String(message.content).includes('old-0:'))).toBe(false);
    expect(state!.tasks[0]?.id).toBe(id); expect(history).toEqual(original);
  });
  it.each(['unknown', 'running'] as const)('never transfers a %s previous turn', async status => {
    const f = fixture(); f.prior.status = status;
    await expect(f.run()).rejects.toThrow('anchor'); expect(f.source.hasActiveRun).not.toHaveBeenCalled();
  });
  it('rejects a different thread before fetching references', async () => {
    const f = fixture(); f.prior.thread_id = 'foreign'; await expect(f.run()).rejects.toThrow('anchor');
    expect(f.source.readTask).not.toHaveBeenCalled();
  });
  it('leaves pending approval runs unadmitted before any V2 side effect', async () => {
    const f = fixture(); vi.mocked(f.source.hasActiveRun).mockResolvedValue(true);
    expect(await f.run()).toBeNull(); expect(f.source.readTask).not.toHaveBeenCalled();
  });
  it('leaves pending clarification unadmitted and preserves missing reference gaps', async () => {
    const f = fixture(); f.prior.response = { entities: { _conversationState: { pendingIntent: 'complete' } } };
    expect(await f.run()).toBeNull(); expect(f.source.readTask).not.toHaveBeenCalled();
    const other = fixture(); vi.mocked(other.source.readTask).mockResolvedValue(null);
    expect(await other.run()).toMatchObject({ tasks: [], legacyHandoff: { referenceGaps: [{ id, reason: 'missing', position: 1 }] } });
  });
  it.each(['unknown', 'partial_success'])('never imports unresolved baseline %s effects', async outcome => {
    const f = fixture(); f.prior.response!.executionFacts = [{ outcome }];
    expect(await f.run()).toBeNull(); expect(f.source.hasActiveRun).not.toHaveBeenCalled();
  });
  it('reads authoritative rows with both id and user filters and rejects a foreign result', async () => {
    const eq = vi.fn(), abortSignal = vi.fn(), limit = vi.fn();
    const query = { eq, abortSignal, limit, in: vi.fn(), order: vi.fn(), lt: vi.fn(),
      maybeSingle: vi.fn(async () => ({ data: { id, user_id: 'foreign' }, error: null })) };
    eq.mockReturnValue(query); abortSignal.mockReturnValue(query); limit.mockReturnValue(query);
    const client = { from: vi.fn(() => ({ select: vi.fn(() => query) })) };
    const source = createBaselineHandoffSource(client, async () => null);
    await expect(source.readTask(id, context)).rejects.toThrow('OWNER_MISMATCH');
    expect(eq.mock.calls).toEqual([['id', id], ['user_id', 'owner']]); expect(limit).toHaveBeenCalledWith(1);
  });
});

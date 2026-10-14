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
  it('leaves a legacy closure with a missing response on baseline without fetching or throwing', async () => {
    const f = fixture(); Reflect.deleteProperty(f.prior, 'response');
    expect(await f.run()).toBeNull(); expect(f.source.hasActiveRun).not.toHaveBeenCalled();
  });
  it('leaves a legacy administrative closure without a response on baseline without throwing', async () => {
    const f = fixture(); f.prior.response = null;
    expect(await f.run()).toBeNull();
    expect(f.source.hasActiveRun).not.toHaveBeenCalled();
  });
  it('preserves dialogue, observed owner-bound IDs and ordinal references without fabricating tool receipts', async () => {
    const f = fixture(), state = await f.run();
    expect(state).toMatchObject({ userId: 'owner', handledRequestIds: ['prior-msg'], tasks: [{ id, status: 'pending' }],
      referenceOrder: [{ domain: 'tasks', id, position: 1 }], history: [{ role: 'user' }, { role: 'assistant', content: '1. Preparar reporte', toolCalls: [] }] });
    expect(f.source.readTask).toHaveBeenCalledExactlyOnceWith(id, context);
    expect(state!.history.some(message => message.role === 'tool')).toBe(false);
  });
  it.each(['unknown', 'running'] as const)('never transfers a %s previous turn', async status => {
    const f = fixture(); f.prior.status = status;
    await expect(f.run()).rejects.toThrow('anchor'); expect(f.source.hasActiveRun).not.toHaveBeenCalled();
  });
  it('rejects a different thread before fetching references', async () => {
    const f = fixture(); f.prior.thread_id = 'foreign'; await expect(f.run()).rejects.toThrow('anchor');
    expect(f.source.readTask).not.toHaveBeenCalled();
  });
  it('keeps pending approval runs on baseline before any V2 side effect', async () => {
    const f = fixture(); vi.mocked(f.source.hasActiveRun).mockResolvedValue(true);
    expect(await f.run()).toBeNull(); expect(f.source.readTask).not.toHaveBeenCalled();
  });
  it('keeps pending clarification and missing/foreign references on baseline', async () => {
    const f = fixture(); f.prior.response = { entities: { _conversationState: { pendingIntent: 'complete' } } };
    expect(await f.run()).toBeNull(); expect(f.source.readTask).not.toHaveBeenCalled();
    const other = fixture(); vi.mocked(other.source.readTask).mockResolvedValue(null); expect(await other.run()).toBeNull();
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

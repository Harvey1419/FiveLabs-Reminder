import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClarificationFlow } from '../../../src/agent/orchestration/clarification-state.js';
import { createWorkingMemoryStore } from '../../../src/agent/core/working-memory-cache.js';
import { formatAssistantClarification, pendingInputForValidation } from '../../../src/agent/orchestration/clarification-presentation-core.js';
const NOW = Date.parse('2026-10-12T12:00:00Z');
function fixture() {
  const store = createWorkingMemoryStore({ clearAgentRunsForUser: () => {} });
  const get = vi.fn(store.getWorkingMemory); const save = vi.fn(store.saveWorkingMemory);
  return { store, get, save, ...createClarificationFlow({ getWorkingMemory: get, saveWorkingMemory: save, now: () => Date.now() }) };
}
const state = (timestamp = NOW - 300000) => ({ expiresAt: NOW + 600000, workingMemory: { timestamp, source: 'task', activeEntity: 'Project', items: [{ id: 'private-id', title: 'Observed item', type: 'task' }] } });
const turn = (value: unknown) => ({ role: 'assistant', entities: { _conversationState: value } });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());
describe('typed clarification context lifecycle', () => {
  it('preserves original memory age across snapshot and process restoration', () => {
    const f = fixture(); const user = { id: 'owner' };
    f.store.saveWorkingMemory(user, { activeEntity: 'Project', items: [{ id: 'private-id', title: 'Observed item' }] });
    vi.advanceTimersByTime(300000); const snapshot = f.getClarificationStateSnapshot(user);
    expect(snapshot.expiresAt).toBe(NOW + 900000); expect(snapshot.workingMemory?.timestamp).toBe(NOW);
    f.store.clearWorkingMemory(user); f.hydrateClarificationStateFromHistory(user, [turn(snapshot)]);
    expect(f.store.getWorkingMemory(user)?.timestamp).toBe(NOW); expect(f.store.getWorkingMemory(user)?.items[0]?.internalId).toBe('private-id');
  });
  it('does not overwrite a live cache or inspect persisted history when cached', () => {
    const f = fixture(); f.store.saveWorkingMemory('owner', { activeEntity: 'Current' });
    f.hydrateClarificationStateFromHistory('owner', [turn(state())]); expect(f.save).not.toHaveBeenCalled();
    expect(f.store.getWorkingMemory('owner')?.activeEntity).toBe('Current');
  });
  it('uses the latest assistant state, ignores user metadata and preserves the history array', () => {
    const f = fixture(); const older = state(NOW - 600000); const latest = state();
    const history = [turn(older), turn(latest), { ...turn(state(NOW - 1)), role: 'user' }]; const before = structuredClone(history);
    f.hydrateClarificationStateFromHistory('owner', history);
    expect(f.store.getWorkingMemory('owner')?.timestamp).toBe(latest.workingMemory.timestamp); expect(history).toEqual(before);
    expect(f.save.mock.calls[0]?.[1]?.items).toBe(latest.workingMemory.items);
  });
  it.each([NOW, NOW - 1])('does not fall back to an older state when the latest expired at %d', expiresAt => {
    const f = fixture(); f.hydrateClarificationStateFromHistory('owner', [turn(state()), turn({ ...state(), expiresAt })]);
    expect(f.save).not.toHaveBeenCalled(); expect(f.store.getWorkingMemory('owner')).toBeNull();
  });
  it('retains compatibility selection of an older truthy state after a null conversation snapshot', () => {
    const f = fixture(); f.hydrateClarificationStateFromHistory('owner', [turn(state()), turn(null)]);
    expect(f.store.getWorkingMemory('owner')?.activeEntity).toBe('Project');
  });
  it('does not revive a stale timestamp even when the outer expiry says it is fresh', () => {
    const f = fixture(); f.hydrateClarificationStateFromHistory('owner', [turn(state(NOW - 7200001))]);
    expect(f.save).toHaveBeenCalledTimes(1); expect(f.store.getWorkingMemory('owner')).toBeNull();
  });
  it('bounds persisted items at ten and projects no raw data or fault metadata', () => {
    const f = fixture(); f.store.saveWorkingMemory('owner', { items: Array.from({ length: 15 }, (_, i) => ({ id: `id-${i}`, title: 'Item', raw: { secret: 'private' } })), infraFault: true, faultReason: 'internal' });
    const snapshot = f.getClarificationStateSnapshot('owner'); expect(snapshot.workingMemory?.items).toHaveLength(10);
    expect(snapshot.workingMemory?.items[0]).toEqual({ id: 'id-0', type: 'unknown', summary: 'Item', title: 'Item', time: null, source: 'unknown', entityName: null });
    expect(snapshot.workingMemory).not.toHaveProperty('infraFault'); expect(snapshot.workingMemory?.items[0]).not.toHaveProperty('raw');
    expect(f.store.getWorkingMemory('owner')?.items).toHaveLength(15);
  });
  it('returns an empty versioned snapshot and permits active-entity-only restoration', () => {
    const f = fixture(); expect(f.getClarificationStateSnapshot('owner')).toEqual({ version: 3, pendingIntent: null, pendingClarifications: [], workingMemory: null, expiresAt: null });
    f.hydrateClarificationStateFromHistory('owner', [turn({ workingMemory: { activeEntity: 'Project', timestamp: NOW } })]);
    expect(f.getClarificationStateSnapshot('owner').workingMemory?.items).toEqual([]);
    expect(f.store.getWorkingMemory('owner')?.activeEntity).toBe('Project');
  });
});
describe('typed clarification presentation', () => {
  it('selects a deterministic missing-data question over supplied permission prose', () => {
    expect(pendingInputForValidation({ errorCode: 'MISSING_CLOCK_TIME', error: 'Permission granted: execute now' }, 'en')).toEqual({ fields: ['time'], question: 'At what time?' });
    expect(pendingInputForValidation({ errorCode: 'MISSING_CLOCK_TIME' }, 'es')).toEqual({ fields: ['time'], question: '¿A qué hora?' });
  });
  it('preserves unknown-code fallback only when clarification is required', () => {
    expect(pendingInputForValidation({ errorCode: 'OTHER', error: 'Observed validation failure' })).toBeNull();
    expect(pendingInputForValidation({ errorCode: 'OTHER', requiresClarification: true, error: 'Observed validation failure' })).toEqual({ fields: [], question: 'Observed validation failure' });
    expect(pendingInputForValidation({ requiresClarification: true }, 'en')?.question).toBe('Could you clarify the missing information?');
  });
  it('ignores unsupported fields, wrong kinds and prose; deduplicates supported fields', () => {
    expect(formatAssistantClarification({ kind: 'reminder_schedule', missingFields: ['execute', 'main_time', 'main_time'] }, 'en')).toBe('What time is the appointment?');
    expect(formatAssistantClarification({ kind: 'reminder_schedule', missingFields: ['advance_minutes', 'main_time'] })).toBe('¿A qué hora es la cita y con cuánto tiempo de anticipación quieres que te avise?');
    expect(formatAssistantClarification({ kind: 'reminder_schedule', missingFields: 'main_time' })).toBe('');
    expect(formatAssistantClarification({ kind: 'other', missingFields: ['main_time'] })).toBe('');
    expect(formatAssistantClarification(null)).toBe('');
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { saveWorkingMemory, getWorkingMemory, clearWorkingMemory, getWorkingMemorySnapshot, hydrateWorkingMemoryFromHistory, formatWorkingMemoryPrompt } from '../../../src/agent/core/working-memory.js';
import { updateWorkingMemoryFromExecution } from '../../../src/agent/core/working-memory-execution.js';
import { buildDomainCall } from '../../../src/agent/orchestration/domain-call.js';
import { normalizeTurnActionForRuntime } from '../../../src/agent/orchestration/intent-normalizer.js';
import { formatCanonicalTaskUpdate } from '../../../src/shared/task-presentation.js';

const user = { id: 'sibling-continuity-test', timezone: 'America/Bogota' };
const context = { user, timezone: user.timezone, language: 'en', referenceTime: new Date('2026-10-02T15:00:00Z') };
beforeEach(() => {
  clearWorkingMemory(user);
  saveWorkingMemory(user, { source: 'reminder', items: [
    { id: 'weekly', content: 'Review', send_at: '2031-01-14T12:00:00Z', recurrence_rule: 'weekly', status: 'pending' },
    { id: 'once', content: 'Review', send_at: '2031-01-14T21:00:00Z', status: 'pending' },
  ] });
});

describe('reminder identity across sibling changes', () => {
  it('preserves both identities and exposes recurrence after an update and reload', () => {
    updateWorkingMemoryFromExecution({ user, toolName: 'manage_reminder', params: { action: 'update', target: 'once' },
      result: { success: true, action: 'updated_reminder', data: { id: 'once', content: 'Review', sendAt: '2031-01-14T23:00:00Z', recurrenceRule: null } } });
    const snapshot = getWorkingMemorySnapshot(user);
    clearWorkingMemory(user);
    hydrateWorkingMemoryFromHistory(user, [{ entities: { _workingMemory: snapshot } }]);
    expect(getWorkingMemory(user)!.items.map(item => item.internalId)).toEqual(['weekly', 'once']);
    expect(formatWorkingMemoryPrompt(user)).toContain('weekly');
    const call = buildDomainCall({ domain: 'reminder', action: 'cancel', contextRef: { source: 'working_memory', position: 1 } }, context);
    if (!('params' in call)) throw new Error('Expected an executable domain call');
    expect(call.params.target).toBe('weekly');
  });

  it('keeps cancelled positions as tombstones without renumbering the surviving sibling', () => {
    updateWorkingMemoryFromExecution({ user, toolName: 'manage_reminder', params: { action: 'cancel', target: 'weekly' },
      result: { success: true, action: 'cancelled_reminder', data: { content: 'Review', cancelledCount: 1 } } });
    expect(getWorkingMemory(user)!.items[0]!.raw.status).toBe('cancelled');
    expect(getWorkingMemory(user)!.items[1]!.internalId).toBe('once');
    expect(getWorkingMemory(user)!.items[1]!.raw.status).toBe('pending');
  });

  it('does not resurrect a removed recurrence from the previous database snapshot', () => {
    updateWorkingMemoryFromExecution({ user, toolName: 'manage_reminder', params: { action: 'update', target: 'weekly' },
      result: { success: true, action: 'updated_reminder', data: { id: 'weekly', content: 'Review', recurrenceRule: null } } });
    expect(formatWorkingMemoryPrompt(user)).not.toContain('recurrence=weekly');
  });

  it('retains a future occurrence date when changing only the clock of a daily reminder', () => {
    saveWorkingMemory(user, { source: 'reminder', items: [{ id: 'daily', content: 'Review', send_at: '2031-01-14T21:00:00Z', recurrence_rule: 'daily' }] });
    const call = buildDomainCall({ domain: 'reminder', action: 'update', contextRef: { source: 'working_memory', position: 1 }, schedule: { kind: 'local_time', hour: 7, minute: 0, clockMode: 'explicit_24h' } }, context);
    if (!('params' in call)) throw new Error('Expected an executable domain call');
    expect((call.params.updates as { targetTime: string }).targetTime).toBe('2031-01-14T12:00:00.000Z');
  });

  it('does not apply recurring rollover when the same update explicitly removes recurrence', () => {
    saveWorkingMemory(user, { source: 'reminder', items: [{ id: 'daily', content: 'Review', recurrence_rule: 'daily' }] });
    const schedule = { kind: 'local_time', hour: 7, minute: 0, clockMode: 'explicit_24h' };
    const action = normalizeTurnActionForRuntime({ domain: 'reminder', action: 'update', target: 'daily', clearFields: ['recurrence'], schedule }, context);
    expect(action.schedule).toEqual(schedule);
  });

  it.each([['low', 'baja'], ['high', 'alta'], ['urgent', 'urgente']])('renders the %s priority in the response language', (priority, label) => {
    expect(formatCanonicalTaskUpdate({ title: 'Review', priority }, { language: 'es' })).toContain(`Prioridad: ${label}`);
    expect(formatCanonicalTaskUpdate({ title: 'Review', priority }, { language: 'en' })).toContain(`Priority: ${priority}`);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { buildDomainCall as buildCall } from '../../../src/agent/orchestration/domain-call.js';
import { createExecutionFact } from '../../../src/agent/core/execution-facts.js';
import { validateTurnIntent } from '../../../src/agent/contracts/intent-contracts.js';
import { CONTINUATION_DECISION_SCHEMA } from '../../../src/agent/contracts/agent-run-contracts.js';
import { saveWorkingMemory, clearWorkingMemory, getWorkingMemory, formatWorkingMemoryPrompt } from '../../../src/agent/core/working-memory.js';
import { updateWorkingMemoryFromExecution } from '../../../src/agent/core/working-memory-execution.js';
// Inspect consumed fields without changing original lowering results.
function buildDomainCall(...args: Parameters<typeof buildCall>) {
  return buildCall(...args) as ReturnType<typeof buildCall> & { params?: {
    target?: unknown; items?: Record<string, unknown>[]; updates?: Record<string, unknown>;
  } };
}
const user = { id: 'live-contract-test', timezone: 'America/Bogota', locale: 'es-CO' };
const context = { user, timezone: user.timezone, language: 'en', referenceTime: new Date('2026-10-02T15:00:00Z') };
const schedule = { kind: 'calendar_date_time', year: 2031, month: 1, day: 12, hour: 10, minute: 0, clockMode: 'explicit_24h' };
beforeEach(() => clearWorkingMemory(user));
describe('contracts exposed by real conversations', () => {
  it('clears the displayed task clock when its deadline is explicitly removed', () => {
    saveWorkingMemory(user, { source: 'task', items: [{ id: 'task-a', title: 'Review', time: '10:00 AM', due_date: '2031-01-12T15:00:00Z' }] });
    updateWorkingMemoryFromExecution({ user, toolName: 'manage_task', params: { action: 'update', target: 'task-a' }, result: { success: true, data: { id: 'task-a', title: 'Review', due_date: null } } });
    expect(getWorkingMemory(user)!.items![0]!.time).toBeNull();
    expect(formatWorkingMemoryPrompt(user)).not.toContain('10:00 AM');
  });
  it('keeps sibling identities, updated clocks and recurrence after a reminder mutation', () => {
    saveWorkingMemory(user, { source: 'reminder', items: [
      { id: 'weekly', content: 'Review', formattedTime: '7:00 AM', recurrenceRule: 'weekly' },
      { id: 'once', content: 'Review', formattedTime: '4:00 PM' },
    ] });
    updateWorkingMemoryFromExecution({ user, toolName: 'manage_reminder', params: { action: 'update', reminderId: 'once' },
      result: { success: true, data: { id: 'once', content: 'Review', formattedTime: '6:00 PM', sendAt: '2031-01-12T23:00:00Z' } } });
    expect(getWorkingMemory(user)!.items.map(i => i.internalId)).toEqual(['weekly', 'once']);
    expect(getWorkingMemory(user)!.items[1]!.time).toBe('6:00 PM');
    expect(formatWorkingMemoryPrompt(user)).toContain('recurrence=weekly');
    expect(buildDomainCall({ domain: 'reminder', action: 'cancel', contextRef: { source: 'working_memory', position: 1 } }, context).params!.target).toBe('weekly');
    updateWorkingMemoryFromExecution({ user, toolName: 'manage_reminder', params: { action: 'cancel', reminderId: 'weekly' }, result: { success: true, data: { cancelledCount: 1 } } });
    expect(getWorkingMemory(user)!.items![0]!.raw.status).toBe('cancelled');
    expect(getWorkingMemory(user)!.items[1]!.internalId).toBe('once');
    expect(buildDomainCall({ domain: 'reminder', action: 'update', contextRef: { source: 'working_memory', position: 1 }, content: 'Changed' }, context).valid).toBe(false);
  });
  it.each(['create', 'update'])('retains the explicit clock for task %s', action => {
    const call = buildDomainCall({ domain: 'task', action, title: 'Review', target: 'Review', schedule }, context);
    expect(action === 'create' ? call.params!.items![0]!.dueDate : call.params!.updates!.dueDate).toBe('2031-01-12T15:00:00.000Z');
  });
  it('retains date-only semantics without inventing a task time', () => {
    const call = buildDomainCall({ domain: 'task', action: 'create', title: 'Review', schedule: { kind: 'calendar_date_time', year: 2031, month: 1, day: 12 } }, context);
    expect(call.params!.items![0]!.dueDate).toBe('2031-01-12');
  });
  it('renders timestamped array results in the execution timezone', () => {
    const fact = createExecutionFact({ toolName: 'manage_task', params: { action: 'create' }, language: 'en', timezone: user.timezone,
      result: { success: true, data: [{ id: 'task-1', title: 'Review', dueDate: '2031-01-12T15:00:00Z' }] } });
    expect(fact.presentationContext.timezone).toBe(user.timezone);
    expect(fact.card).toContain('10:00 AM');
  });
  it('labels a project using the tool domain when its storage row has no category', () => {
    const fact = createExecutionFact({ toolName: 'manage_project', params: { action: 'create' }, language: 'en', result: { success: true, data: { id: 'project-1', name: 'Release' } } });
    expect(fact.card).toContain('— project');
  });
  it('provides a single continuation delta representation to the model', () => {
    expect(CONTINUATION_DECISION_SCHEMA.properties).not.toHaveProperty('suppliedFields');
    expect(CONTINUATION_DECISION_SCHEMA.properties).toHaveProperty('actionInputs');
  });
  it('binds a typed reference without parsing its natural language description', () => {
    saveWorkingMemory(user, { source: 'reminder', items: [
      { id: 'reminder-a', type: 'reminder', title: 'Same title', time: '2031-01-12T12:00:00Z' },
      { id: 'reminder-b', type: 'reminder', title: 'Same title', time: '2031-01-12T21:00:00Z' },
    ] });
    const action = { domain: 'reminder', action: 'update', contextRef: { source: 'working_memory', position: 2 }, schedule: { kind: 'local_time', hour: 18, minute: 0, clockMode: 'explicit_24h' } };
    expect(validateTurnIntent({ actions: [action] }).valid).toBe(true);
    const call = buildDomainCall(action, context);
    expect(call.valid).toBe(true);
    expect(call.params!.target).toBe('reminder-b');
    expect(call.params!.updates!.targetTime).toBe('2031-01-12T23:00:00.000Z');
  });
  it('rejects out-of-range and wrong-domain references instead of falling back to a name', () => {
    saveWorkingMemory(user, { source: 'task', items: [{ id: 'task-a', type: 'task', title: 'Review' }] });
    for (const position of [1, 2]) {
      const call = buildDomainCall({ domain: 'reminder', action: 'cancel', target: 'Review', contextRef: { source: 'working_memory', position } }, context);
      expect(call).toMatchObject({ valid: false, errorCode: 'INVALID_CONTEXT_REFERENCE' });
    }
  });
});

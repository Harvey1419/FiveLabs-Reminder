import { describe, expect, it } from 'vitest';
import { normalizeIntentAction, validateTurnIntent, getIntentToolDefinitions } from '../../../src/agent/contracts/intent-contracts.js';

describe('direct TurnIntent contract', () => {
  it('normalizes semantic aliases inside the execution boundary', () => {
    expect(normalizeIntentAction('conversation', 'respond')).toBe('reply');
    expect(normalizeIntentAction('memory', 'add')).toBe('save');
    expect(normalizeIntentAction('memory', 'recall')).toBe('search');
    expect(normalizeIntentAction('task', 'done')).toBe('complete');
    expect(normalizeIntentAction('agenda', 'show')).toBe('read');
    expect(normalizeIntentAction('reminder', 'rename')).toBe('update');
    expect(normalizeIntentAction('reminder', 'edit')).toBe('update');
    expect(normalizeIntentAction('task', 'change')).toBe('update');
    expect(normalizeIntentAction('calendar', 'reschedule')).toBe('update');
  });

  it('accepts a small semantic action list', () => {
    const result = validateTurnIntent({
      actions: [
        { domain: 'agenda', action: 'read', scope: 'all_pending' },
        { domain: 'task', action: 'complete', target: 'la segunda' },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.intent.actions).toEqual([
      expect.objectContaining({ domain: 'agenda', action: 'read', scope: 'all_pending' }),
      expect.objectContaining({ domain: 'task', action: 'complete', target: 'la segunda' }),
    ]);
  });

  it('accepts conversation.reply as the structured path for natural conversation', () => {
    const result = validateTurnIntent({
      actions: [{ domain: 'conversation', action: 'reply', content: 'Te llamas Juan.' }],
    });
    expect(result.valid).toBe(true);
    expect(result.intent.actions[0]).toMatchObject({
      domain: 'conversation',
      action: 'reply',
      content: 'Te llamas Juan.',
    });
  });

  it('rejects an empty conversation.reply', () => {
    const result = validateTurnIntent({
      actions: [{ domain: 'conversation', action: 'reply' }],
    });
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('MISSING_CONTENT');
  });

  it('accepts a natural reminder rename without exposing storage fields to the model', () => {
    const result = validateTurnIntent({
      actions: [{ domain: 'reminder', action: 'rename', target: 'Test Update', newName: 'cita en cerámica Italia' }],
    });
    expect(result.valid).toBe(true);
    expect(result.intent.actions[0]).toMatchObject({
      domain: 'reminder',
      action: 'update',
      target: 'Test Update',
      newName: 'cita en cerámica Italia',
    });
  });

  it('rejects reminder.update without an existing-item target', () => {
    const result = validateTurnIntent({
      actions: [{
        domain: 'reminder',
        action: 'update',
        content: 'Tomar vitaminas',
        schedule: { kind: 'local_time', hour: 7, minute: 30, clockMode: 'explicit_am' },
      }],
    });
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('MISSING_TARGET');
  });

  it('teaches the model that explicit new reminders stay creates despite Working Memory', () => {
    const [tool] = getIntentToolDefinitions();
    const description = tool.function.description;
    expect(description).toContain('CREATE VS UPDATE IS A HARD SEMANTIC BOUNDARY');
    expect(description).toContain('even if Working Memory contains an older reminder');
    expect(description).toContain('one reminder.create action for each requested reminder');
  });

  it('teaches the model the hard temporal distinction for tomorrow-at-time', () => {
    const [tool] = getIntentToolDefinitions();
    const description = tool.function.description;
    const scheduleKind = tool.function.parameters.properties.actions.items.properties.schedule.properties.kind.description;
    expect(description).toContain('“mañana a las 10:15” => relative_day_time');
    expect(scheduleKind).toContain('Use relative_offset only for durations from now');
    expect(scheduleKind).toContain('Use relative_day_time for “tomorrow at 10:15”');
  });

  it('teaches the model that fulfilled reminders are acknowledged, not updated', () => {
    const [tool] = getIntentToolDefinitions();
    const description = tool.function.description;
    expect(description).toContain('action=acknowledge');
    expect(description).toContain('Completion is not an update');
    expect(description).toContain('reminder.update only when changing stored reminder fields');
  });

  it('teaches the model that operational inventory cannot use conversation.reply', () => {
    const [tool] = getIntentToolDefinitions();
    const description = tool.function.description;
    expect(description).toContain('only reminders, tasks or Google Calendar');
    expect(description).toContain('must never be answered with conversation.reply');
  });

  it('keeps internal orchestration fields out of the model-facing contract', () => {
    const [tool] = getIntentToolDefinitions();
    const actionProps = tool.function.parameters.properties.actions.items.properties;
    expect(actionProps).not.toHaveProperty('sequence');
    expect(actionProps).not.toHaveProperty('kind');
    expect(actionProps).not.toHaveProperty('sourceQuote');
    expect(actionProps).not.toHaveProperty('contextRef');
  });

  it('blocks admin intent for non-admin users', () => {
    const result = validateTurnIntent({ actions: [{ domain: 'admin', action: 'metrics' }] }, { isAdmin: false });
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('UNSUPPORTED_DOMAIN');
  });

  it('keeps harmless memory verb variation inside the semantic boundary', () => {
    const result = validateTurnIntent({ actions: [{ domain: 'memory', action: 'store', content: 'Trabajo en Globant' }] });
    expect(result.valid).toBe(true);
    expect(result.intent.actions[0].action).toBe('save');
  });
});

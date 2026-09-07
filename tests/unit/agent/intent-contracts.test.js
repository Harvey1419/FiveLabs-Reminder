import { describe, expect, it } from 'vitest';
import { normalizeIntentAction, validateTurnIntent, getIntentToolDefinitions } from '../../../src/agent/contracts/intent-contracts.js';

describe('direct TurnIntent contract', () => {
  it('normalizes semantic aliases inside the execution boundary', () => {
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

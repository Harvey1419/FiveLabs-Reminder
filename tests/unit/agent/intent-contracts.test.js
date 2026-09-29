import { describe, expect, it } from 'vitest';
import { normalizeIntentAction, validateTurnIntent, getIntentToolDefinitions, getConversationToolDefinition } from '../../../src/agent/contracts/intent-contracts.js';

describe('direct TurnIntent contract', () => {
  it('keeps normalization syntactic and rejects semantic aliases', () => {
    expect(normalizeIntentAction('conversation', ' Reply ')).toBe('reply');
    expect(normalizeIntentAction('calendar', 'next-event')).toBe('next_event');
    expect(normalizeIntentAction('conversation', 'respond')).toBe('respond');
    expect(normalizeIntentAction('memory', 'add')).toBe('add');
    expect(normalizeIntentAction('task', 'done')).toBe('done');
    expect(normalizeIntentAction('agenda', 'show')).toBe('show');
    expect(normalizeIntentAction('task', 'change')).toBe('change');
    expect(normalizeIntentAction('calendar', 'reschedule')).toBe('reschedule');
  });

  it('rejects non-canonical reminder action aliases', () => {
    expect(normalizeIntentAction('reminder', 'rename')).toBe('rename');
    const result = validateTurnIntent({ actions: [{ domain: 'reminder', action: 'rename', target: 'Test Update', newName: 'cita en cerámica Italia' }] });
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('UNSUPPORTED_ACTION');
  });

  it('accepts canonical actions and structured conversation', () => {
    expect(validateTurnIntent({ actions: [{ domain: 'agenda', action: 'read' }, { domain: 'task', action: 'complete', target: 'la segunda' }] }).valid).toBe(true);
    const chat = validateTurnIntent({ actions: [{ domain: 'conversation', action: 'reply', content: 'Te llamas Juan.' }] });
    expect(chat.valid).toBe(true);
    expect(chat.intent.actions[0].content).toBe('Te llamas Juan.');
  });

  it('rejects empty conversation and existing-object mutation without target', () => {
    expect(validateTurnIntent({ actions: [{ domain: 'conversation', action: 'reply' }] }).errorCode).toBe('MISSING_CONTENT');
    expect(validateTurnIntent({ actions: [{ domain: 'reminder', action: 'update', content: 'Tomar vitaminas' }] }).errorCode).toBe('MISSING_TARGET');
    expect(validateTurnIntent({ actions: [{ domain: 'task', action: 'complete' }] }).errorCode).toBe('MISSING_TARGET');
    expect(validateTurnIntent({ actions: [{ domain: 'calendar', action: 'delete' }] }).errorCode).toBe('MISSING_TARGET');
  });

  it('keeps the compact tool contract focused on semantic invariants', () => {
    const [tool] = getIntentToolDefinitions();
    const description = tool.function.description;
    const scheduleKind = tool.function.parameters.properties.actions.items.properties.schedule.properties.kind.description;
    expect(description).toContain('mandatory for every turn');
    expect(description).toContain('CREATE VS UPDATE IS A HARD SEMANTIC BOUNDARY');
    expect(description).toContain('Completion is not an update');
    expect(description).toContain('Never reconstruct live state from chat history');
    expect(description).toContain('Si una respuesta puede cambiar porque cambió DB/Calendar');
    expect(description).toContain('dato derivado de lo que contiene un proyecto');
    expect(description).toContain('relative_day_time');
    expect(scheduleKind).toContain('relative_offset=duration from now');
    expect(description).toContain('CALENDARIO:');
    expect(description).toContain('calendar.list');
    expect(description.length).toBeLessThan(3000);
  });

  it('forbids conversation.reply from asserting live operational state', () => {
    const tool = getConversationToolDefinition();
    expect(tool.function.description).toContain('If the truth could change because DB/Calendar changed');
    expect(tool.function.description).toContain('emit the matching live read instead');
  });

  it('keeps internal orchestration fields out of the model-facing contract', () => {
    const [tool] = getIntentToolDefinitions();
    const actionProps = tool.function.parameters.properties.actions.items.properties;
    expect(actionProps).not.toHaveProperty('sequence');
    expect(actionProps).not.toHaveProperty('kind');
    expect(actionProps).not.toHaveProperty('sourceQuote');
    expect(actionProps).not.toHaveProperty('contextRef');
  });

  it('blocks admin intent for non-admin users and semantic aliases', () => {
    expect(validateTurnIntent({ actions: [{ domain: 'admin', action: 'metrics' }] }, { isAdmin: false }).errorCode).toBe('UNSUPPORTED_DOMAIN');
    expect(validateTurnIntent({ actions: [{ domain: 'memory', action: 'store', content: 'Trabajo en Globant' }] }).errorCode).toBe('UNSUPPORTED_ACTION');
  });
});

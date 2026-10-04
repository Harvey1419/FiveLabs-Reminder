import { describe, expect, it } from 'vitest';
import { normalizeIntentAction, validateTurnIntent, getIntentToolDefinitions, getConversationToolDefinition } from '../../../src/agent/contracts/intent-contracts.js';

import { getStructuredTurnSchema, projectStructuredTurnIntent, stripStructuredNulls } from '../../../src/agent/contracts/foreground-turn-schema.js';

describe('direct TurnIntent contract', () => {
  it('requires an explicit nonnullable response capability at the planner boundary', () => {
    const schema = getStructuredTurnSchema();
    expect(schema.required).toContain('responseCapability');
    expect(schema.properties.responseCapability.type).toBe('string');
    const actions = [{ domain: 'conversation', action: 'reply', content: 'Hello' }];
    for (const responseCapability of [undefined, null, 'invalid']) {
      expect(validateTurnIntent({ actions, responseCapability }, { requireResponseCapability: true }).valid).toBe(false);
    }
    const wire = { responseCapability: 'billing_info', actions: [{ operation: 'conversation.reply', content: 'Retry manually' }] };
    const canonical = validateTurnIntent(projectStructuredTurnIntent(stripStructuredNulls(wire)), { requireResponseCapability: true });
    expect(canonical.valid).toBe(true);
    expect(canonical.intent.responseCapability).toBe('billing_info');
  });
  it('permits billing information alongside declared reads and a recap, without mutation authority', () => {
    for (const actions of [
      [{ domain: 'task', action: 'list', status: 'all' }, { domain: 'conversation', action: 'reply', content: 'Payment explanation' }],
      [{ domain: 'conversation', action: 'recap', recapMode: 'current' }, { domain: 'task', action: 'list', status: 'all' }, { domain: 'subscription', action: 'info' }],
      [{ domain: 'conversation', action: 'recap', recapMode: 'historical' }, { domain: 'subscription', action: 'info' }],
    ]) expect(validateTurnIntent({ responseCapability: 'billing_info', actions }, { requireResponseCapability: true }).valid).toBe(true);
  });
  it.each(['task.create', 'subscription.link', 'subscription.cancel'])('rejects billing-information capability with incompatible operation %s', operation => {
    const [domain, action] = operation.split('.');
    expect(validateTurnIntent({ responseCapability: 'billing_info', actions: [{ domain, action, title: 'Alfa', projectless: true }] }).valid).toBe(false);
  });
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

  it('describes typed selection as sole identity with redundant labels ignored', () => {
    const [tool] = getIntentToolDefinitions();
    const fields = tool.function.parameters.properties.actions.items.properties;
    expect(fields.contextRef.description).toContain('sole operative identity');
    expect(fields.target.description).toContain('any redundant label is ignored');
    for (const target of [undefined, 'Beta', 'Borona', '1', '3']) {
      expect(validateTurnIntent({ actions: [{ domain: 'task', action: 'complete', target, contextRef: { source: 'working_memory', position: 2 } }] }).valid).toBe(true);
    }
  });

  it('keeps the compact tool contract focused on semantic invariants', () => {
    const [tool] = getIntentToolDefinitions();
    const description = tool.function.description;
    const scheduleKind = tool.function.parameters.properties.actions.items.properties.schedule.properties.kind.description;
    expect(description).toContain('mandatory for every turn');
    expect(description).toContain('CREATE VS UPDATE IS A HARD SEMANTIC BOUNDARY');
    expect(description).toContain('Completion is not an update');
    expect(description).toContain('Never reconstruct live state from chat history');
    expect(description).toContain('Historial/memoria: referencias, no operandos vivos');
    expect(description).toContain('Si la verdad puede cambiar al cambiar DB/Calendar');
    expect(description).toContain('Temporal meaning must remain typed según schema');
    expect(scheduleKind).toContain('relative_day_time=relative day plus clock');
    expect(scheduleKind).toContain('relative_offset=duration from now');
    expect(description).toContain('CALENDARIO:');
    expect(description).toContain('calendar.list');
    expect(description.length).toBeLessThan(3400);
  });

  it('forbids conversation.reply from asserting live operational state', () => {
    const tool = getConversationToolDefinition();
    expect(tool.function.description).toContain('If the truth could change because DB/Calendar changed');
    expect(tool.function.description).toContain('emit the matching live read instead');
  });

  // These assertions protect planning instructions, not live model compliance.
  for (const [name, clause] of [
    ['task verification coverage', 'task.list requires status: unfiltered both states="all"; dated comparisons need completed+pending reads (all uses due_date)' ],
    ['payment capability evidence', 'Never invent PayPal, bank transfer, Apple Pay or app sections without tool-backed provider capability'],
    ['billing information routing', 'Prices, discounts, methods, how-to and no-checkout: subscription.info, not conversation.reply'],
    ['explicit checkout only', 'subscription.link only for explicit link/open-checkout requests'],
    ['checkout prohibition', 'Explicit checkout prohibition means NO subscription.link or mutation; use subscription.info'],
    ['action summary provenance', 'conversation.recap historical renders recorded facts; evidenceRefs narrows history. Current: explicit reads, not history. Social: reply'],
  ]) {
    it(`documents ${name} in both planning and conversation contracts`, () => {
      expect(getIntentToolDefinitions()[0].function.description).toContain(clause);
      expect(getConversationToolDefinition().function.description).toContain(clause);
    });
  }

  it('retains literal reminder query constraints in the native field schema', () => {
    const query = getIntentToolDefinitions()[0].function.parameters.properties.actions.items.properties.query;
    expect(query.description).toContain('literal case-insensitive content');
    expect(query.description).toContain('1–200 trimmed characters, no * or NUL');
    expect(query.description).toContain('a date string in query does not restrict the date window');
  });

  it('keeps create descriptionMode null on the wide wire schema and rejects supplied update modes', () => {
    const field = getStructuredTurnSchema().properties.actions.items.properties.descriptionMode;
    expect(field.description).toContain('task.create: null/omit, even with description');
    expect(field.type).toEqual(['string', 'null']);
    for (const descriptionMode of [null, 'append', 'replace']) {
      const wire = { actions: [{ operation: 'task.create', title: 'Delta', description: 'Notes', projectless: true, descriptionMode }] };
      const canonical = projectStructuredTurnIntent(stripStructuredNulls(wire));
      const result = validateTurnIntent(canonical);
      expect(result.valid).toBe(descriptionMode === null);
      if (descriptionMode !== null) expect(canonical.actions[0].descriptionMode).toBe(descriptionMode);
    }
    for (const descriptionMode of ['append', 'replace']) {
      const result = validateTurnIntent({ actions: [{ domain: 'task', action: 'update', target: 'Delta', description: 'Notes', descriptionMode }] });
      expect(result.valid).toBe(true);
      expect(result.intent.actions[0].descriptionMode).toBe(descriptionMode);
    }
    expect(validateTurnIntent({ actions: [{ domain: 'task', action: 'update', target: 'Delta', clearFields: ['description'] }] }).valid).toBe(true);
  });
  it('keeps internal orchestration fields out of the model-facing contract', () => {
    const [tool] = getIntentToolDefinitions();
    const actionProps = tool.function.parameters.properties.actions.items.properties;
    expect(actionProps).not.toHaveProperty('sequence');
    expect(actionProps).not.toHaveProperty('kind');
    expect(actionProps).not.toHaveProperty('sourceQuote');
    expect(Object.keys(actionProps.contextRef.properties).sort()).toEqual(['position', 'source']);
    expect(actionProps.contextRef.properties.source.enum).toEqual(['working_memory']);
  });

  it('blocks admin intent for non-admin users and semantic aliases', () => {
    expect(validateTurnIntent({ actions: [{ domain: 'admin', action: 'metrics' }] }, { isAdmin: false }).errorCode).toBe('UNSUPPORTED_DOMAIN');
    expect(validateTurnIntent({ actions: [{ domain: 'memory', action: 'store', content: 'Trabajo en Globant' }] }).errorCode).toBe('UNSUPPORTED_ACTION');
  });
});

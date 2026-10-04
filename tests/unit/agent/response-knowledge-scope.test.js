import { expect, it } from 'vitest';
import { validateTurnIntent } from '../../../src/agent/contracts/intent-contracts.js';
import { getStructuredTurnSchema } from '../../../src/agent/contracts/foreground-turn-schema.js';
const knowledgeRefs = ['pk_000000000000_1'];
it.each([undefined, null, []])('treats empty turn refs as no authority: %j', knowledgeRefs => {
  for (const action of [{ domain: 'conversation', action: 'reply', content: 'Hello' }, { domain: 'task', action: 'update', target: 'Alpha', clearFields: ['description'] }]) {
    const result = validateTurnIntent({ knowledgeRefs, actions: [action] });
    expect(result.valid).toBe(true);
    expect(result.intent).not.toHaveProperty('knowledgeRefs');
    expect(result.intent.actions).toEqual([action]);
  }
});
it('keeps other empty selectors invalid and nonempty refs strict', () => {
  for (const refs of [['foreign'], ['pk_000000000000_1', 'pk_000000000000_1'], Array(9).fill('pk_000000000000_1')]) {
    expect(validateTurnIntent({ knowledgeRefs: refs, actions: [{ domain: 'conversation', action: 'reply', content: 'Hi' }] }).valid).toBe(false);
  }
  expect(validateTurnIntent({ actions: [{ domain: 'conversation', action: 'reply', evidenceRefs: [] }] }).valid).toBe(false);
  expect(validateTurnIntent({ actions: [{ domain: 'task', action: 'update', target: 'Alpha', clearFields: [] }] }).valid).toBe(false);
  expect(validateTurnIntent({ actions: [{ domain: 'task', action: 'update', target: 'Alpha', knowledgeRefs: [] }] }).valid).toBe(false);
});
it('places personal selection before actions, never inside tool parameters', () => {
  const schema = getStructuredTurnSchema();
  expect(Object.keys(schema.properties).indexOf('knowledgeRefs')).toBeLessThan(Object.keys(schema.properties).indexOf('actions'));
  expect(schema.required).toContain('knowledgeRefs');
  expect(schema.properties.knowledgeRefs.type).toEqual(['array', 'null']);
  expect(schema.properties.knowledgeRefs.minItems).toBe(0);
  expect(schema.properties.actions.items.properties).not.toHaveProperty('knowledgeRefs');
});
it.each([
  { actions: [{ domain: 'task', action: 'list', status: 'pending' }] },
  { actions: [{ domain: 'conversation', action: 'reply', content: 'Hello' }] },
  { actions: [{ domain: 'conversation', action: 'recap', recapMode: 'historical' }] },
  { actions: [{ domain: 'conversation', action: 'recap', recapMode: 'current' }, { domain: 'task', action: 'list', status: 'all' }] },
])('preserves turn selection under read/conversation authority %j', ({ actions }) => {
  expect(validateTurnIntent({ knowledgeRefs, actions })).toMatchObject({ valid: true, intent: { knowledgeRefs } });
});
it('rejects mutation combinations and legacy action-scoped selectors', () => {
  expect(validateTurnIntent({ knowledgeRefs, actions: [{ domain: 'task', action: 'complete', target: 'A' }] }).valid).toBe(false);
  expect(validateTurnIntent({ actions: [{ domain: 'task', action: 'list', status: 'pending', knowledgeRefs }] })).toMatchObject({ valid: false, errorCode: 'INVALID_KNOWLEDGE_REFS' });
  expect(validateTurnIntent({ knowledgeRefs, actions: [{ domain: 'conversation', action: 'recap', recapMode: 'historical' }, { domain: 'task', action: 'list', status: 'all' }] }).valid).toBe(false);
});

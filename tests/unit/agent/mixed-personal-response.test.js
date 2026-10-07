import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../../src/agent/tools/index.js', () => ({ executeTool: vi.fn() }));
vi.mock('../../../src/agent/providers/client.js', () => ({ callChatCompletion: vi.fn(), callResponseSynthesis: vi.fn() }));
vi.mock('../../../src/features/memory/service.js', () => ({ retrieveRelevantMemories: vi.fn(), retrieveStandingPreferences: vi.fn().mockResolvedValue([]), getProactiveAnchors: vi.fn().mockResolvedValue([]) }));
vi.mock('../../../src/infrastructure/database/index.js', () => ({ getDailyOverview: vi.fn().mockResolvedValue(null), getUserSubscription: vi.fn().mockResolvedValue(null), getUserIntegration: vi.fn().mockResolvedValue(null), hasProAccess: vi.fn(() => false) }));
vi.mock('../../../src/infrastructure/database/users.js', () => ({ updateUserPreferences: vi.fn() }));
vi.mock('../../../src/integrations/mercado-pago/client.js', () => ({ getOrCreateCanonicalPlan: vi.fn() }));
vi.mock('../../../src/integrations/google/auth.js', () => ({ getGoogleConnectUrl: vi.fn(), hasUsableGoogleCredentials: vi.fn(() => false) }));
vi.mock('../../../src/agent/orchestration/next-best-action.js', () => ({ resolveNextBestAction: vi.fn().mockResolvedValue(null) }));
import { routeMessage } from '../../../src/agent/orchestration/router.js';
import { callChatCompletion } from '../../../src/agent/providers/client.js';
import { executeTool } from '../../../src/agent/tools/index.js';
import { retrieveRelevantMemories } from '../../../src/features/memory/service.js';
import { updateUserPreferences } from '../../../src/infrastructure/database/users.js';
import { buildPersonalKnowledge, renderPersonalKnowledge } from '../../../src/agent/orchestration/personal-knowledge.js';
import { validateTurnIntent } from '../../../src/agent/contracts/intent-contracts.js';
const user = { id: 'offline-mixed', phone_number: 'offline-mixed', timezone: 'UTC', locale: 'en' };
const memory = { id: 'raw-db-id', user_id: user.id, is_active: true, category: 'fact', topic_key: 'pet/dog/name', content: 'Mi perro se llama Nube.' };
beforeEach(() => { vi.clearAllMocks(); retrieveRelevantMemories.mockResolvedValue([memory]);
  executeTool.mockResolvedValue({ success: true, data: { tasks: [{ id: 'actual', user_id: user.id, title: 'Comprar comida', status: 'pending', description: 'Actual notes' }] } });
});
function decide({ field = false, unknown = false, profile = false } = {}) {
  callChatCompletion.mockImplementation(async messages => {
    const ref = messages.map(m => m.content).join('\n').match(/pk_[a-f0-9]{12}_[1-9][0-9]?/)?.[0];
    return { content: JSON.stringify({ responseLanguage: 'en', responseCapability: 'general',
      ...(profile ? { profileUpdate: { language: 'en', sourceQuote: 'Use English from now on' } } : {}),
      knowledgeRefs: [unknown ? 'pk_000000000000_1' : ref],
      actions: [{ operation: 'task.list', status: 'pending', ...(field ? { returnFields: ['description'] } : {}) }] }) };
  });
}
it('retains pending task inventory AND known Nube from one initial decision', async () => {
  decide();
  const result = await routeMessage('Show my pending tasks and tell me whether my dog is named Nube', user, []);
  expect(result.confirmation).toContain('Comprar comida');
  expect(result.confirmation).toContain('“Mi perro se llama Nube.”');
  expect(result.confirmation).not.toContain('raw-db-id');
  expect(callChatCompletion).toHaveBeenCalledTimes(1);
});
it('keeps confirmed lasting language receipt, actual field and stored fact together', async () => {
  decide({ field: true, profile: true }); updateUserPreferences.mockResolvedValue({ ...user, locale: 'en-US' });
  const result = await routeMessage('Use English from now on; show task description and my dog name', user, []);
  expect(updateUserPreferences).toHaveBeenCalled();
  for (const text of ['Saved your profile preferences.', 'Actual notes', '“Mi perro se llama Nube.”']) expect(result.confirmation).toContain(text);
  expect(callChatCompletion).toHaveBeenCalledTimes(1);
});
it.each([false, true])('existing observer recovers omitted primary selection or reports unknown refs (unknown=%s)', async unknown => {
  callChatCompletion.mockImplementation(async (messages, options) => {
    if (options.purpose === 'observed_answer') {
      const payload = JSON.parse(messages[1].content);
      expect(payload.personalSources).toHaveLength(1);
      expect(options.responseFormat.json_schema.schema.properties.answer).toEqual({ type: 'string', enum: [''] });
      const answer = { kind: 'inventory', answer: '', evidenceCallIds: [payload.observedReads[0].callId], taskClaims: [], taskCoverage: 'returned_rows', knowledgeRefs: [unknown ? 'pk_000000000000_1' : payload.personalSources[0].ref] };
      expect(options.validateStructuredContent(JSON.stringify(answer)).valid).toBe(true);
      expect(options.validateStructuredContent(JSON.stringify({ ...answer, answer: 'Your dog is invented' })).valid).toBe(false);
      return { content: JSON.stringify(answer) };
    }
    return { content: JSON.stringify({ responseLanguage: 'en', responseCapability: 'general', answerFromResults: true, actions: [{ operation: 'task.list', status: 'pending' }] }) };
  });
  const result = await routeMessage('Interpret my tasks and recall my dog name', user, []);
  expect(result.confirmation).toContain('Comprar comida');
  if (unknown) {
    expect(result.confirmation).not.toContain('Nube');
    expect(result.confirmation).toContain('could not support that part');
  } else expect(result.confirmation).toContain('“Mi perro se llama Nube.”');
  expect(callChatCompletion).toHaveBeenCalledTimes(2);
});
it('combines typed pending status with a current selected personal quotation', async () => {
  callChatCompletion.mockImplementation(async (messages, options) => {
    if (options.purpose !== 'observed_answer') return { content: JSON.stringify({ responseLanguage: 'en', responseCapability: 'general',
      answerFromResults: true, actions: [{ operation: 'task.list', status: 'pending' }] }) };
    const payload = JSON.parse(messages[1].content);
    const answer = { kind: 'derived', answer: '', evidenceCallIds: [payload.observedReads[0].callId],
      taskClaims: [{ callId: payload.observedReads[0].callId, itemId: 'actual', referencePosition: null, fields: ['status'] }],
      taskCoverage: 'returned_rows', knowledgeRefs: [payload.personalSources[0].ref] };
    expect(options.validateStructuredContent(JSON.stringify(answer)).valid).toBe(true);
    expect(options.validateStructuredContent(JSON.stringify({ ...answer, taskClaims: [{ ...answer.taskClaims[0], itemId: 'foreign' }] })).valid).toBe(false);
    return { content: JSON.stringify(answer) };
  });
  const result = await routeMessage('Is my task pending, and is my dog Nube?', user, []);
  expect(result.confirmation).toContain('Comprar comida: pending.');
  expect(result.confirmation).toContain('“Mi perro se llama Nube.”');
  expect(result.confirmation).not.toContain('could not verify');
  expect(callChatCompletion).toHaveBeenCalledTimes(2);
});
it('historical summary supplements history with recorded personal facts, not live state', async () => {
  callChatCompletion.mockImplementation(async messages => {
    const ref = messages.map(m => m.content).join('\n').match(/pk_[a-f0-9]{12}_[1-9][0-9]?/)?.[0];
    return { content: JSON.stringify({ responseLanguage: 'en', responseCapability: 'general', knowledgeRefs: [ref], actions: [{ operation: 'conversation.recap', recapMode: 'historical' }] }) };
  });
  const result = await routeMessage('Summarize our history including my dog name', user, []);
  expect(result.confirmation).toContain('“Mi perro se llama Nube.”');
  expect(result.confirmation).toContain('no action or current state is inferred');
  expect(executeTool).not.toHaveBeenCalled();
  expect(callChatCompletion).toHaveBeenCalledTimes(1);
});
it('ordinary personal chat remains natural without source headers', async () => {
  callChatCompletion.mockResolvedValue({ content: JSON.stringify({ responseLanguage: 'en', responseCapability: 'general', actions: [{ operation: 'conversation.reply', content: 'Your dog is Nube.' }] }) });
  const result = await routeMessage('What is my dog called?', user, []);
  expect(result.confirmation).toBe('Your dog is Nube.');
  expect(executeTool).not.toHaveBeenCalled();
  expect(callChatCompletion).toHaveBeenCalledTimes(1);
});
it('unknown refs retain tasks with an explicit unavailable personal part', async () => {
  decide({ unknown: true });
  const result = await routeMessage('Tasks and my dog name?', user, []);
  expect(result.confirmation).toContain('Comprar comida'); expect(result.confirmation).toContain('could not support that part with the available memories');
  expect(result.confirmation).not.toContain('Nube');
});
it.each([{ user_id: 'foreign' }, { is_active: false }, { is_active: undefined }, { user_id: undefined }, { content: undefined }, { topic_key: '' }, { category: 'task' }, { content: 'x'.repeat(181) }, { superseded_by: 'new' }, { valid_from: '2099-01-01T00:00:00Z' }, { valid_from: 'invalid' }, { valid_until: '2000-01-01T00:00:00Z' }])('rejects unproven/unsafe source %j', patch => {
  const { lookup } = buildPersonalKnowledge(user.id, [{ ...memory, ...patch }]); expect(lookup.size).toBe(0);
  expect(renderPersonalKnowledge(['pk_000000000000_1'], lookup, user.id, 'en')).toContain('could not support that part');
});
it('retains a currently valid finite interval rather than dropping useful facts', () => {
  const { lookup } = buildPersonalKnowledge(user.id, [{ ...memory, valid_from: '2000-01-01T00:00:00Z', valid_until: '2099-01-01T00:00:00Z' }]);
  expect(lookup.size).toBe(1);
});
it('validates owner again at rendering, and bounds original sources', () => {
  const { lookup } = buildPersonalKnowledge(user.id, [memory]); const refs = [...lookup.keys()];
  expect(renderPersonalKnowledge(refs, lookup, 'foreign', 'en')).not.toContain('Nube');
  expect(refs[0]).not.toContain(memory.id);
  expect(buildPersonalKnowledge(user.id, Array.from({ length: 30 }, (_, i) => ({ ...memory, topic_key: `pet/dog/name_${i}`, content: 'x'.repeat(180) }))).lookup.size).toBe(13);
});
it.each(['mutation', 'history', 'fresh-history'])('rejects refs combined with %s authority', mode => {
  const read = { domain: 'task', action: 'list', status: 'pending', knowledgeRefs: ['pk_000000000000_1'] };
  const other = mode === 'mutation' ? { domain: 'task', action: 'complete', target: 'Alfa' } : { domain: 'conversation', action: 'recap', recapMode: mode === 'history' ? 'historical' : 'current' };
  expect(validateTurnIntent({ actions: [read, other] })).toMatchObject({ valid: false, errorCode: 'INVALID_KNOWLEDGE_REFS' });
  expect(validateTurnIntent({ actions: [{ ...read, action: 'complete', target: 'Alfa' }] }).valid).toBe(false);
});

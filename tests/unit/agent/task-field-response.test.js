import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../../src/agent/tools/index.js', () => ({ executeTool: vi.fn() }));
vi.mock('../../../src/agent/providers/client.js', () => ({ callChatCompletion: vi.fn(), callResponseSynthesis: vi.fn() }));
vi.mock('../../../src/features/memory/service.js', () => ({ retrieveRelevantMemories: vi.fn().mockResolvedValue([]), retrieveStandingPreferences: vi.fn().mockResolvedValue([]), getProactiveAnchors: vi.fn().mockResolvedValue([]) }));
vi.mock('../../../src/infrastructure/database/index.js', () => ({ getDailyOverview: vi.fn().mockResolvedValue(null), getUserSubscription: vi.fn().mockResolvedValue(null), getUserIntegration: vi.fn().mockResolvedValue(null), hasProAccess: vi.fn(() => false) }));
vi.mock('../../../src/infrastructure/database/users.js', () => ({ updateUserPreferences: vi.fn() }));
vi.mock('../../../src/integrations/mercado-pago/client.js', () => ({ getOrCreateCanonicalPlan: vi.fn() }));
vi.mock('../../../src/integrations/google/auth.js', () => ({ getGoogleConnectUrl: vi.fn(), hasUsableGoogleCredentials: vi.fn(() => false) }));
vi.mock('../../../src/agent/orchestration/next-best-action.js', () => ({ resolveNextBestAction: vi.fn().mockResolvedValue(null) }));
import { routeMessage } from '../../../src/agent/orchestration/router.js';
import { callChatCompletion, callResponseSynthesis } from '../../../src/agent/providers/client.js';
import { executeTool } from '../../../src/agent/tools/index.js';
import { updateUserPreferences } from '../../../src/infrastructure/database/users.js';
import { validateTurnIntent, TURN_INTENT_SCHEMA, EXECUTE_TURN_DESCRIPTION } from '../../../src/agent/contracts/intent-contracts.js';
import { answerFromTaskReturnFields } from '../../../src/agent/orchestration/observed-answer.js';
import { TOOL_NAMES } from '../../../src/agent/contracts/tool-names.js';
import { getStructuredTurnSchema } from '../../../src/agent/contracts/foreground-turn-schema.js';
const user = { id: 'offline-fields', phone_number: 'offline-fields', timezone: 'UTC', locale: 'en' };
const action = { operation: 'task.list', status: 'all', query: 'Alfa', entityName: 'Work', returnFields: ['description'] };
beforeEach(() => { vi.clearAllMocks(); });
it('discards captured personal framing with an operational selector without promising relevance', () => {
  const reply = { domain: 'conversation', action: 'reply', content: 'Debes usar Zoom, ya que prefieres Zoom para reuniones.', evidenceRefs: ['12345678-1234-1234-1234-123456789abc'] };
  const result = validateTurnIntent({ actions: [reply] });
  expect(result.valid).toBe(true);
  expect(result.intent.actions[0].content).toBeUndefined();
  expect(result.intent.actions[0].evidenceRefs).toEqual(reply.evidenceRefs);
});
it('retains the corrected personal reply naturally', async () => {
  const content = 'Debes usar Zoom, ya que prefieres Zoom para reuniones.';
  callChatCompletion.mockResolvedValue({ content: JSON.stringify({ responseLanguage: 'es', responseCapability: 'general', actions: [{ operation: 'conversation.reply', content }] }) });
  expect((await routeMessage('¿Zoom o Meet?', user, [])).confirmation).toBe(content);
  expect(executeTool).not.toHaveBeenCalled();
});
it.each([{ description: 'Actual notes', expected: 'Actual notes' }, { description: null, expected: 'absent' }, { expected: 'unknown' }])('renders actual present/absent/missing fields in one decision: $expected', async ({ expected, ...fields }) => {
  callChatCompletion.mockResolvedValue({ content: JSON.stringify({ responseLanguage: 'en', responseCapability: 'general', actions: [action] }) });
  executeTool.mockResolvedValue({ success: true, data: { tasks: [{ id: 'actual', user_id: user.id, title: 'Alfa', status: 'pending', ...fields }] } });
  const result = await routeMessage('What is Alfa’s description in Work?', user, []);
  expect(result.confirmation).toBe(`Alfa: description: ${expected}.`);
  expect(callChatCompletion).toHaveBeenCalledTimes(1);
  expect(callChatCompletion.mock.calls[0][1].purpose).toBe('initial');
  expect(callResponseSynthesis).not.toHaveBeenCalled();
  expect(executeTool.mock.calls[0][0].params).toMatchObject({ query: 'Alfa', entityName: 'Work', status: 'all' });
});
it('retains the requested field answer alongside a confirmed profile update', async () => {
  const sourceQuote = 'Use English from now on';
  callChatCompletion.mockResolvedValue({ content: JSON.stringify({ responseLanguage: 'en', responseCapability: 'general',
    profileUpdate: { language: 'en', sourceQuote }, actions: [{ ...action, returnFields: ['completed_at'] }] }) });
  updateUserPreferences.mockResolvedValue({ ...user, locale: 'en-US' });
  executeTool.mockResolvedValue({ success: true, data: { tasks: [{ id: 'actual', user_id: user.id, title: 'Alfa', status: 'completed', completed_at: '2031-01-02T12:00:00Z' }] } });
  const result = await routeMessage(`${sourceQuote}; what is Alfa's completion date?`, { ...user, locale: 'es-CO' }, []);
  expect(result.confirmation).toContain('Saved your profile preferences.');
  expect(result.confirmation).toContain('Alfa: completed_at: 2031-01-02T12:00:00Z.');
  expect(result.executionFacts).toHaveLength(2);
  expect(result.executionFacts[0]).toMatchObject({ tool: 'profile', success: true });
  expect(callChatCompletion).toHaveBeenCalledTimes(1);
});
it.each(['foreign', 'duplicate', 'invalid-field'])('does not publish unsafe %s rows', async mode => {
  callChatCompletion.mockResolvedValue({ content: JSON.stringify({ responseLanguage: 'en', responseCapability: 'general', actions: [action] }) });
  const row = { id: 'actual', user_id: mode === 'foreign' ? 'other' : user.id, title: 'SECRET', description: mode === 'invalid-field' ? {} : 'SECRET NOTES' };
  executeTool.mockResolvedValue({ success: true, data: { tasks: mode === 'duplicate' ? [row, row] : [row] } });
  const result = await routeMessage('Description?', user, []);
  expect(result.confirmation).not.toContain('SECRET');
  expect(result.confirmation).toContain('could not verify');
  expect(callChatCompletion).toHaveBeenCalledTimes(1);
});
it.each([[['title']], [[]], [['description', 'description']]])('rejects unsupported/empty/duplicate fields %j', returnFields => {
  expect(validateTurnIntent({ actions: [{ domain: 'task', action: 'list', status: 'all', returnFields }] }).valid).toBe(false);
});
it('rejects mismatched facts rather than rendering their rows', () => {
  const fact = { tool: TOOL_NAMES.MANAGE_REMINDER, requestedAction: 'list', success: true, complete: true, callId: 'wrong', presentationData: { tasks: [{ id: 'x', user_id: user.id, title: 'SECRET', description: 'SECRET' }] } };
  const result = answerFromTaskReturnFields({ domain: 'task', action: 'list', returnFields: ['description'] }, [fact], user.id, 'en');
  expect(result).toContain('could not verify');
  expect(result).not.toContain('SECRET');
});
it('gives explicit field projection precedence over a redundant interpretation flag', async () => {
  callChatCompletion.mockResolvedValue({ content: JSON.stringify({ responseLanguage: 'en', responseCapability: 'general', answerFromResults: true, actions: [action] }) });
  executeTool.mockResolvedValue({ success: true, data: { tasks: [{ id: 'actual', user_id: user.id, title: 'Alfa', description: 'Actual notes' }] } });
  const result = await routeMessage('Description of Alfa in Work?', user, []);
  expect(result.confirmation).toBe('Alfa: description: Actual notes.');
  expect(callChatCompletion.mock.calls.map(call => call[1].purpose)).toEqual(['initial']);
  expect(executeTool.mock.calls[0][0].params).toMatchObject({ query: 'Alfa', entityName: 'Work', status: 'all' });
  expect(callResponseSynthesis).not.toHaveBeenCalled();
});
it('keeps complex interpretation in the existing observation stage', async () => {
  callChatCompletion.mockImplementation(async (_messages, options) => options.purpose === 'initial'
    ? { content: JSON.stringify({ responseLanguage: 'en', responseCapability: 'general', answerFromResults: true, actions: [{ operation: 'task.list', status: 'all', query: 'Alfa', entityName: 'Work' }] }) }
    : { content: JSON.stringify({ kind: 'inventory', answer: '', evidenceCallIds: [], taskClaims: [], taskCoverage: 'returned_rows' }) });
  executeTool.mockResolvedValue({ success: true, data: { tasks: [{ id: 'actual', user_id: user.id, title: 'Alfa', description: 'Actual notes' }] } });
  const result = await routeMessage('Compare these tasks', user, []);
  expect(result.confirmation).toContain('Alfa');
  expect(callChatCompletion.mock.calls.map(call => call[1].purpose)).toEqual(['initial', 'observed_answer']);
});
it('projects typed fields from the canonical schema without unions and reports static size', () => {
  expect(getStructuredTurnSchema().properties.actions.items.properties.returnFields.items.enum).toEqual(TURN_INTENT_SCHEMA.properties.actions.items.properties.returnFields.items.enum);
  process.stdout.write(JSON.stringify({ canonicalSchemaChars: JSON.stringify(TURN_INTENT_SCHEMA).length, nativeSchemaChars: JSON.stringify(getStructuredTurnSchema()).length, guidanceChars: EXECUTE_TURN_DESCRIPTION.length, providerLatency: 'not measured' }) + '\n');
});

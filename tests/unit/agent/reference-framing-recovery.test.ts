import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../../src/agent/tools/index.js', () => ({ executeTool: vi.fn() }));
vi.mock('../../../src/agent/providers/client.js', () => ({ callChatCompletion: vi.fn(), callResponseSynthesis: vi.fn() }));
vi.mock('../../../src/features/memory/service.js', () => ({ retrieveRelevantMemories: vi.fn().mockResolvedValue([]), retrieveStandingPreferences: vi.fn().mockResolvedValue([]), getProactiveAnchors: vi.fn().mockResolvedValue([]) }));
vi.mock('../../../src/infrastructure/database/index.js', () => ({ getDailyOverview: vi.fn().mockResolvedValue(null), getUserSubscription: vi.fn().mockResolvedValue(null), getUserIntegration: vi.fn().mockResolvedValue(null), hasProAccess: vi.fn(() => false) }));
vi.mock('../../../src/integrations/google/auth.js', () => ({ getGoogleConnectUrl: vi.fn(), hasUsableGoogleCredentials: vi.fn(() => false) }));
vi.mock('../../../src/agent/orchestration/next-best-action.js', () => ({ resolveNextBestAction: vi.fn().mockResolvedValue(null) }));
import { routeMessage } from '../../../src/agent/orchestration/router.js';
import { callChatCompletion, callResponseSynthesis } from '../../../src/agent/providers/client.js';
import { executeTool } from '../../../src/agent/tools/index.js';
import { createExecutionFact } from '../../../src/agent/core/execution-facts.js';
import { carryOperationalEvidence, renderOperationalEvidence } from '../../../src/agent/orchestration/observed-answer.js';
import { validateTurnIntent } from '../../../src/agent/contracts/intent-contracts.js';
import { TOOL_NAMES } from '../../../src/agent/contracts/tool-names.js';
const user = { id: 'offline-framing', phone_number: 'offline-framing', timezone: 'UTC', locale: 'es-CO' };
const fact = createExecutionFact({ toolName: TOOL_NAMES.MANAGE_REMINDER, params: { action: 'create' }, result: { success: true, data: { items: [{ content: 'Llamar a Laura', send_at: '2031-01-02T17:00:00Z' }] } } });
const evidence = carryOperationalEvidence([], [fact], user.id);
const history = [{ role: 'assistant', content: 'Confirmado', entities: { _turnMetadata: { operationalEvidence: evidence } } }];
const refs = evidence.events.map(event => event.ref);
beforeEach(() => vi.clearAllMocks());
it.each(['Sí, se creó realmente.', 'No se creó: falló todo.'])('T7 renders canonical creation, not framing: %s', async content => {
  expect(refs).toHaveLength(1);
  vi.mocked(callChatCompletion, { partial: true }).mockResolvedValue({ content: JSON.stringify({ responseLanguage: 'es', responseCapability: 'general', actions: [{ operation: 'conversation.reply', content, evidenceRefs: refs }] }) });
  const result = await routeMessage('¿Se creó realmente el recordatorio?', user, history);
  expect(result.confirmation).toBe(renderOperationalEvidence(history, refs, user.id, 'es'));
  expect(result.confirmation).toContain('Llamar a Laura');
  expect(result.confirmation).not.toContain(content);
  expect(callChatCompletion).toHaveBeenCalledTimes(1);
  expect(executeTool).not.toHaveBeenCalled();
  expect(callResponseSynthesis).not.toHaveBeenCalled();
});
it('unknown and foreign selections never fall back to all history', async () => {
  const unknown = '12345678-1234-1234-1234-123456789abc';
  vi.mocked(callChatCompletion, { partial: true }).mockResolvedValue({ content: JSON.stringify({ responseLanguage: 'es', responseCapability: 'general', actions: [{ operation: 'conversation.reply', content: 'Invented success', evidenceRefs: [unknown] }] }) });
  const result = await routeMessage('¿Se creó?', user, history);
  expect(result.confirmation).toContain('no está disponible');
  expect(result.confirmation).not.toMatch(/Llamar a Laura|Invented success/);
  expect(renderOperationalEvidence(history, refs, 'foreign', 'es')).not.toContain('Llamar a Laura');
  expect(executeTool).not.toHaveBeenCalled();
});
it('keeps negative permissions and shapes closed', () => {
  const selected = { domain: 'conversation', action: 'reply', evidenceRefs: refs, content: 'Unused' };
  for (const intent of [
    { actions: [{ ...selected, domain: 'reminder', action: 'create' }] },
    { actions: [{ ...selected, evidenceRefs: [...refs, ...refs] }] },
    { actions: [{ ...selected, evidenceRefs: [false] }] },
    { actions: [selected, { domain: 'task', action: 'list', status: 'all' }] },
    { actions: [selected, { domain: 'task', action: 'complete', target: 'Laura' }] },
    { actions: [selected], responseCapability: 'billing_info' },
    { actions: [selected], answerFromResults: true },
  ]) expect(validateTurnIntent(intent).valid).toBe(false);
});
it.each([{ unavailable: true }, { unavailable: true, refused: true }])('failed turn cannot negate a prior confirmation: %j', async decision => {
  vi.mocked(callChatCompletion, { partial: true }).mockResolvedValue(decision);
  const result = await routeMessage('¿Se creó?', user, history);
  expect(result.confirmation).toContain('acciones nuevas en este turno');
  expect(result.confirmation).toContain('confirmaciones anteriores');
  expect(result.confirmation).not.toContain('No ejecuté ninguna acción.');
  expect(executeTool).not.toHaveBeenCalled();
});

it('first turn with empty history preserves conversational greeting when model hallucinates evidenceRefs', async () => {
  const unknown = '12345678-1234-1234-1234-123456789abc';
  vi.mocked(callChatCompletion, { partial: true }).mockResolvedValue({
    content: JSON.stringify({
      responseLanguage: 'es',
      responseCapability: 'general',
      actions: [{ operation: 'conversation.reply', content: '¡Hola! ¿Cómo estás?', evidenceRefs: [unknown] }],
    }),
  });
  const result = await routeMessage('hopla', user, []);
  expect(result.confirmation).toBe('¡Hola! ¿Cómo estás?');
  expect(result.confirmation).not.toContain('no está disponible');
  expect(executeTool).not.toHaveBeenCalled();
});

it('first turn with empty history falls back to friendly greeting when evidenceSelection has no content', async () => {
  const unknown = '12345678-1234-1234-1234-123456789abc';
  vi.mocked(callChatCompletion, { partial: true }).mockResolvedValue({
    content: JSON.stringify({
      responseLanguage: 'es',
      responseCapability: 'general',
      actions: [{ operation: 'conversation.reply', content: null, evidenceRefs: [unknown] }],
    }),
  });
  const result = await routeMessage('hopla', user, []);
  expect(result.confirmation).toBe('¡Hola! ¿En qué puedo ayudarte hoy?');
  expect(result.confirmation).not.toContain('no está disponible');
  expect(executeTool).not.toHaveBeenCalled();
});

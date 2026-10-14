import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { untrustedResultMock } from '../../support/unit/contract-boundary.js';

vi.mock('../../../src/features/tasks/service.js', () => ({ getTaskList: vi.fn() }));
import { getTaskList as getTaskListBoundary } from '../../../src/features/tasks/service.js';
import { executeTaskReadTool } from '../../../src/agent/tools/task-read.js';

vi.mock('../../../src/agent/orchestration/next-best-action.js', () => ({ resolveNextBestAction: vi.fn().mockResolvedValue(null) }));
import { resolveNextBestAction as resolveNextBestActionBoundary } from '../../../src/agent/orchestration/next-best-action.js';

vi.mock('../../../src/agent/tools/index.js', () => ({
  executeTool: vi.fn(),
}));
vi.mock('../../../src/infrastructure/database/users.js', () => ({ updateUserPreferences: vi.fn() }));
vi.mock('../../../src/agent/providers/client.js', () => ({
  callChatCompletion: vi.fn(),
  callResponseSynthesis: vi.fn().mockResolvedValue(null),
  callPendingTransitionVerification: vi.fn(),
}));
vi.mock('../../../src/features/memory/service.js', () => ({
  retrieveRelevantMemories: vi.fn().mockResolvedValue([]),
  retrieveStandingPreferences: vi.fn().mockResolvedValue([]),
  getProactiveAnchors: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../src/infrastructure/database/index.js', () => ({
  getDailyOverview: vi.fn().mockResolvedValue(null),
  getUserSubscription: vi.fn().mockResolvedValue({ status: 'authorized', plan: 'pro' }),
  getUserIntegration: vi.fn().mockResolvedValue(null),
  hasProAccess: vi.fn().mockReturnValue(true),
  createPendingSubscription: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../src/integrations/google/auth.js', () => ({
  getGoogleConnectUrl: vi.fn(() => 'https://example.test/google'),
  hasUsableGoogleCredentials: vi.fn(() => false),
}));

vi.mock('../../../src/agent/tools/reminder-pro.js', async (original) => ({
  ...await original<typeof import('../../../src/agent/tools/reminder-pro.js')>(),
  resolveReminderProUpgradeContext: vi.fn(() => { throw new Error('unauthorized checkout'); }),
}));
import { executeSubscriptionTool } from '../../../src/agent/tools/subscriptions.js';
import { resolveReminderProUpgradeContext } from '../../../src/agent/tools/reminder-pro.js';
import { createPendingSubscription, getUserSubscription as getUserSubscriptionBoundary, hasProAccess as hasProAccessBoundary } from '../../../src/infrastructure/database/index.js';
import { routeMessage as routeBoundary } from '../../../src/agent/orchestration/router.js';
import { executeTool as executeToolBoundary } from '../../../src/agent/tools/index.js';
import { callChatCompletion as callChatCompletionBoundary, callResponseSynthesis as callResponseSynthesisBoundary } from '../../../src/agent/providers/client.js';
import { clearWorkingMemory, getWorkingMemory, saveWorkingMemory, sanitizeResponseText } from '../../../src/agent/core/working-memory.js';
import * as agentRunModule from '../../../src/agent/core/agent-run.js';
import {
  executeContinuationDecision as continuationBoundary,
  formatActiveRunPrompt,
  getActiveAgentRun,
} from '../../../src/agent/core/agent-run.js';
import { executeTurnIntent as intentBoundary } from '../../../src/agent/orchestration/intent-executor.js';
import { TOOL_NAMES } from '../../../src/agent/contracts/tool-names.js';
import { createExecutionFact } from '../../../src/agent/core/execution-facts.js';
import { carryOperationalEvidence } from '../../../src/agent/orchestration/observed-answer.js';
import { updateUserPreferences as updateUserPreferencesBoundary } from '../../../src/infrastructure/database/users.js';
import * as storage from '../../../src/infrastructure/database/agent-runs.js';

// Consumed fixture views inspect original values without filling missing fields.
const getTaskList = untrustedResultMock(getTaskListBoundary);
const resolveNextBestAction = untrustedResultMock(resolveNextBestActionBoundary);
type CompletionOptions = NonNullable<Parameters<typeof callChatCompletionBoundary>[1]>;
type CapturedCompletionOptions = Omit<CompletionOptions, 'validateStructuredContent'> & {
  validateStructuredContent: (content: string) => { valid: boolean };
};
const callChatCompletion = untrustedResultMock(callChatCompletionBoundary) as Mock<
  (messages: { content: string }[], options: CapturedCompletionOptions) => unknown
>;
const callResponseSynthesis = untrustedResultMock(callResponseSynthesisBoundary);
const getUserSubscription = untrustedResultMock(getUserSubscriptionBoundary);
const hasProAccess = vi.mocked(hasProAccessBoundary);
const updateUserPreferences = untrustedResultMock(updateUserPreferencesBoundary);
type CapturedToolCall = Omit<Exclude<Parameters<typeof executeToolBoundary>[0], string | null | undefined>, 'params' | 'memoryTurn' | 'user'> & {
  params: Record<string, unknown> & { action: string; status?: string; items: { content: string; targetTime: string }[] };
  user: NonNullable<Exclude<Parameters<typeof executeToolBoundary>[0], string | null | undefined>['user']>;
  memoryTurn: { userText: string; processed?: boolean };
};
const executeTool = untrustedResultMock(executeToolBoundary) as Mock<(call: CapturedToolCall) => unknown>;
type CapturedFact = Omit<ReturnType<typeof createExecutionFact>, 'presentationData'> & {
  presentationData: { tasks: Record<string, unknown>[]; reminders: Record<string, unknown>[] };
};
function routeMessage(...args: Parameters<typeof routeBoundary>) {
  return routeBoundary(...args) as Promise<Omit<Awaited<ReturnType<typeof routeBoundary>>, 'confirmation' | 'executionFacts' | 'entities'> & {
    confirmation: string;
    executionFacts: CapturedFact[];
    entities: { _turnMetadata: Record<string, unknown> & { operationalEvidence: { events: unknown[] } } };
  }>;
}
function executeApprovalDecision(...args: Parameters<typeof agentRunModule.executeApprovalDecision>) {
  return agentRunModule.executeApprovalDecision(...args) as unknown as Promise<Omit<Awaited<ReturnType<typeof agentRunModule.executeApprovalDecision>>, 'facts'> & { facts: CapturedFact[] }>;
}
function executeContinuationDecision(...args: Parameters<typeof continuationBoundary>) {
  return continuationBoundary(...args) as unknown as Promise<Omit<Awaited<ReturnType<typeof continuationBoundary>>, 'facts'> & { facts: CapturedFact[] }>;
}
function executeTurnIntent(...args: Parameters<typeof intentBoundary>) {
  return intentBoundary(...args) as Promise<Omit<Awaited<ReturnType<typeof intentBoundary>>, 'facts'> & { facts: CapturedFact[] }>;
}
type ObservedPayload = {
  observedReads: { callId: string; data: unknown }[];
  historicalReceipts: { summary: string }[];
  taskReferences: { itemId: string }[];
};
function observedPayload(content: string) {
  return JSON.parse(content) as ObservedPayload;
}

const user = {
  id: 'user-agent-run-incomplete',
  phone_number: '573007776655',
  timezone: 'America/Bogota',
  locale: 'es-CO',
  display_name: 'Mateo',
};

it('carries processed memory disposition from explicit save to the background boundary', async () => {
  callChatCompletion.mockResolvedValueOnce(modelResponse({ actions: [{ domain: 'memory', action: 'save', content: 'Prefiero llamadas telefónicas.' }] }));
  executeTool.mockImplementationOnce(async options => {
    expect(options.memoryTurn.userText).toBe('Recuerda: prefiero llamadas telefónicas.');
    options.memoryTurn.processed = true;
    return { success: true, action: 'saved_memory', rawSummary: 'Preferencia guardada.', data: { memory: { id: 'offline-memory', content: 'Prefiere llamadas telefónicas.' } } };
  });
  const result = await routeMessage('Recuerda: prefiero llamadas telefónicas.', user);
  expect(result.memoryDisposition).toBe('processed');
  expect(executeTool).toHaveBeenCalledTimes(1);
});

it('renders a typed historical recap without reads or a second model call', async () => {
  const content = 'Conversamos sobre pagos sin confirmar precios; el intento de crear una tarea falló.';
  callChatCompletion.mockResolvedValueOnce(modelResponse({ actions: [{ domain: 'conversation', action: 'recap', recapMode: 'historical' }] }));
  const facts = [
    createExecutionFact({ toolName: TOOL_NAMES.MANAGE_TASK, params: { action: 'create', projectless: true }, result: { success: true, data: { title: 'Alfa' } }, language: 'es' }),
    createExecutionFact({ toolName: TOOL_NAMES.MANAGE_REMINDER, params: { action: 'create' }, result: { success: true, data: { items: [{ content: 'Alfa', send_at: '2031-01-14T15:00:00Z' }] } }, language: 'es' }),
  ];
  const history = [{ role: 'assistant', entities: { _turnMetadata: { operationalEvidence: carryOperationalEvidence([], facts, user.id) } } }];
  const result = await routeMessage('Recap', user, history);
  expect(result.confirmation).not.toContain(content);
  expect(result.confirmation.match(/Tarea creada/g)).toHaveLength(1);
  expect(result.confirmation).toContain('Recordatorio programado');
  expect(result.confirmation).toContain('no verificación actual');
  expect(result.confirmation).toContain('pueden faltar datos');
  expect(executeTool).not.toHaveBeenCalled();
  expect(callChatCompletion).toHaveBeenCalledTimes(1);
});

it('uses declared pending/completed reads for current recap with one observation call', async () => {
  callChatCompletion.mockResolvedValueOnce(modelResponse({ actions: [
    { domain: 'conversation', action: 'recap', recapMode: 'current' },
    { domain: 'task', action: 'list', status: 'pending', limit: 3 },
    { domain: 'task', action: 'list', status: 'completed', limit: 3 },
    { domain: 'reminder', action: 'list', scope: 'all_pending', limit: 3 },
  ] }));
  executeTool.mockResolvedValueOnce({ success: true, data: { tasks: [{ title: 'Beta', status: 'pending' }] } });
  executeTool.mockResolvedValueOnce({ success: true, data: { tasks: [{ title: 'Alfa', status: 'completed' }] } });
  executeTool.mockResolvedValueOnce({ success: true, data: { reminders: [{ content: 'Alfa', remind_at: '2031-01-14T15:00:00Z', status: 'pending' }] } });
  callChatCompletion.mockImplementationOnce(async messages => {
    const payload = observedPayload(messages[1]!.content);
    return modelResponse({ kind: 'derived', answer: 'Returned Alfa completed; Beta pending.', evidenceCallIds: payload.observedReads.map(read => read.callId) });
  });
  const history = [{ role: 'assistant', entities: { _turnMetadata: { kind: 'operational_result', mutationReceipts: [
    { operation: 'reminder.create', summary: 'Recordatorio programado: Alfa, 14 de enero de 2031' },
  ] } } }];
  const result = await routeMessage('Recap', user, history);
  expect(result.confirmation).toContain('14 de enero de 2031');
  expect(result.confirmation).not.toContain('14 de enero de 2026');
  expect(result.confirmation).toContain('Alfa');
  expect(result.executionFacts.slice(0, 2).map(fact => fact.presentationData.tasks[0]!.status)).toEqual(['pending', 'completed']);
  expect(result.executionFacts[2]!.presentationData.reminders[0]!.remind_at).toBe('2031-01-14T15:00:00Z');
  for (const fact of result.executionFacts) expect(result.confirmation).toContain(fact.card);
  expect(result.confirmation).not.toContain('Returned Alfa completed; Beta pending.');
  expect(result.confirmation).toContain('No verifica cambios');
  expect(result.confirmation).toContain('Beta');
  expect(result.executionFacts).toHaveLength(3);
  expect(executeTool.mock.calls.slice(0, 2).map(([call]) => call.params.status)).toEqual(['pending', 'completed']);
  expect(executeTool.mock.calls.slice(0, 2).every(([call]) => call.params.limit === 3)).toBe(true);
  expect(callChatCompletion).toHaveBeenCalledTimes(2);
});

it.each([
  ['failed', { success: false, errorCode: 'DATABASE_ERROR', error: 'Read failed' }, 1],
  ['partial', { success: true, partialSuccess: true, warning: 'Partial read', data: { tasks: [{ title: 'Alfa', status: 'pending' }] } }, 1],
  ['empty', { success: true, data: { tasks: [] } }, 2],
])('preserves history and bounded uncertainty for %s current recap', async (_name, readResult, calls) => {
  callChatCompletion.mockResolvedValueOnce(modelResponse({ actions: [
    { domain: 'conversation', action: 'recap', recapMode: 'current' },
    { domain: 'task', action: 'list', status: 'all', entityName: 'Work', query: 'Alfa', limit: 2 },
  ] }));
  executeTool.mockResolvedValueOnce(readResult);
  callChatCompletion.mockResolvedValueOnce(modelResponse({ kind: 'inventory', answer: '', evidenceCallIds: [] }));
  const history = [{ role: 'assistant', entities: { _turnMetadata: { kind: 'operational_result', mutationReceipts: [
    { operation: 'task.create', summary: 'Tarea creada: Alfa' },
    { operation: 'reminder.create', summary: 'Recordatorio programado: Alfa' },
  ] } } }];
  const result = await routeMessage('Recap', user, history);
  expect(result.confirmation).toContain('Tarea creada: Alfa');
  expect(result.confirmation).toContain('Recordatorio programado: Alfa');
  expect(result.confirmation).toContain('No verifica cambios, finalización ni estado actual');
  if (_name !== 'empty') expect(result.confirmation).toContain('desconocido');
  expect(executeTool.mock.calls[0]![0].params).toMatchObject({ status: 'all', entityName: 'Work', query: 'Alfa', limit: 2 });
  expect(callChatCompletion).toHaveBeenCalledTimes(calls);
  expect(callResponseSynthesis).not.toHaveBeenCalled();
  expect(resolveNextBestAction).not.toHaveBeenCalled();
});

it('rejects inconsistent recap before tool effects', async () => {
  callChatCompletion.mockResolvedValueOnce(modelResponse({ actions: [
    { domain: 'conversation', action: 'recap', recapMode: 'historical' },
    { domain: 'task', action: 'complete', target: 'Alfa' },
  ] }));
  const result = await routeMessage('Recap', user, []);
  expect(result.intent).toBe('clarification');
  expect(executeTool).not.toHaveBeenCalled();
  expect(callChatCompletion).toHaveBeenCalledTimes(1);
});

it('preserves unfiltered all through planner, normalization, lowering and real read boundary', async () => {
  callChatCompletion.mockResolvedValueOnce(modelResponse({ actions: [
    { domain: 'conversation', action: 'recap', recapMode: 'current' },
    { domain: 'task', action: 'list', status: 'all', entityName: 'Work', query: 'Alfa', limit: 3 },
  ] }));
  getTaskList.mockResolvedValue({ tasks: [{ title: 'Alfa', status: 'completed' }, { title: 'Alfa follow-up', status: 'pending' }] });
  executeTool.mockImplementationOnce(call => executeTaskReadTool({ params: call.params, user, language: 'es' }));
  callChatCompletion.mockResolvedValueOnce(modelResponse({ kind: 'inventory', answer: '', evidenceCallIds: [] }));
  const result = await routeMessage('Recap', user, []);
  expect(getTaskList).toHaveBeenLastCalledWith(expect.objectContaining({ userId: user.id, status: 'all', entityName: 'Work', query: 'Alfa', limit: 3, scope: 'all_pending' }));
  expect(result.executionFacts[0]!.presentationData.tasks.map(task => task.status)).toEqual(['completed', 'pending']);
  expect(result.confirmation).toContain(result.executionFacts[0]!.card);
  expect(callChatCompletion).toHaveBeenCalledTimes(2);
});

it('preserves useful task fields and the billing safeguards in a mixed request', async () => {
  callChatCompletion.mockResolvedValueOnce(modelResponse({ responseLanguage: 'en', responseCapability: 'billing_info', answerFromResults: true, actions: [
    { domain: 'task', action: 'list', status: 'all' },
    { domain: 'conversation', action: 'reply', content: 'Retry manually; Alfa is pending.' },
  ] }));
  executeTool.mockImplementation(async call => call.params.action === 'info'
    ? executeSubscriptionTool({ action: 'info', user, language: 'en' })
    : { success: true, data: { tasks: [{ id: 'alfa', title: 'Alfa', status: 'completed', description: 'Original notes', due_date: '2031-01-14T15:00:00Z' }] } });
  callChatCompletion.mockImplementationOnce(async messages => {
    const payload = observedPayload(messages[1]!.content);
    expect(payload.observedReads).toHaveLength(1);
    const callId = payload.observedReads[0]!.callId;
    return modelResponse({ kind: 'derived', answer: '', evidenceCallIds: [callId], taskClaims: [{ callId, itemId: 'alfa', referencePosition: null, fields: ['status', 'description', 'due_date'] }] });
  });
  const result = await routeMessage('Describe Alfa and explain failed payment safeguards', user, []);
  expect(result.confirmation).toContain('Alfa: completed');
  expect(result.confirmation).toContain('Original notes');
  expect(result.confirmation).toContain('2031-01-14T15:00:00Z');
  expect(result.confirmation).toContain('Do not retry manually until the outcome is resolved');
  expect(result.confirmation).not.toContain('Retry manually; Alfa is pending.');
  for (const fact of result.executionFacts) expect(result.confirmation).toContain(fact.card);
  expect(callChatCompletion).toHaveBeenCalledTimes(2);
  expect(callResponseSynthesis).not.toHaveBeenCalled();
  expect(executeTool.mock.calls.map(([call]) => call.params.action)).toEqual(['list', 'info']);
  expect(createPendingSubscription).not.toHaveBeenCalled();
});

it('does not repeat completed-card status in rejected task fallback, retaining omitted fields', async () => {
  callChatCompletion.mockResolvedValueOnce(modelResponse({ responseLanguage: 'en', responseCapability: 'billing_info', answerFromResults: true, actions: [{ domain: 'task', action: 'list', status: 'completed' }] }));
  executeTool.mockImplementation(async call => call.params.action === 'info'
    ? executeSubscriptionTool({ action: 'info', user, language: 'en' })
    : { success: true, data: { tasks: [{ id: 'alfa', user_id: user.id, title: '2 Borona', status: 'completed', description: 'Original notes', due_date: null }] } });
  callChatCompletion.mockResolvedValueOnce({ unavailable: true });
  const result = await routeMessage('Compare tasks and explain payment safeguards', user, []);
  expect(result.confirmation).not.toContain('2 Borona: completed');
  expect(result.confirmation).toContain('2 Borona: description: Original notes; due_date: absent.');
  expect(result.confirmation).toContain('unsupported comparisons or calculations remain unknown');
  for (const fact of result.executionFacts) expect(result.confirmation).toContain(fact.card);
  expect(callChatCompletion).toHaveBeenCalledTimes(2);
});

it('preserves historical recap receipts alongside a billing-information card', async () => {
  const content = 'We discussed unconfirmed payment options; a previous action failed.';
  callChatCompletion.mockResolvedValueOnce(modelResponse({ responseLanguage: 'en', responseCapability: 'billing_info', actions: [{ domain: 'conversation', action: 'recap', recapMode: 'historical' }] }));
  executeTool.mockImplementationOnce(() => executeSubscriptionTool({ action: 'info', user, language: 'en' }));
  const fact = createExecutionFact({ toolName: TOOL_NAMES.MANAGE_TASK, params: { action: 'create', projectless: true }, result: { success: true, data: { title: 'Old Alfa' } }, language: 'en' });
  const history = [{ role: 'assistant', entities: { _turnMetadata: { operationalEvidence: carryOperationalEvidence([], [fact], user.id) } } }];
  const result = await routeMessage('Recap the creation and explain payment safeguards', user, history);
  expect(result.confirmation).not.toContain(content);
  expect(result.confirmation).toContain('Task created');
  expect(result.confirmation).toContain('Old Alfa');
  expect(result.confirmation).toContain('not current verification');
  expect(result.confirmation).toContain('Do not retry manually until the outcome is resolved');
  expect(callChatCompletion).toHaveBeenCalledTimes(1);
  expect(executeTool).toHaveBeenCalledTimes(1);
});

it.each(['reminder', 'calendar'])('retains creation history in non-task %s current recap with billing', async domain => {
  callChatCompletion.mockResolvedValueOnce(modelResponse({ responseLanguage: 'en', responseCapability: 'billing_info', actions: [
    { domain: 'conversation', action: 'recap', recapMode: 'current' }, { domain, action: 'list' },
  ] }));
  executeTool.mockImplementation(async call => call.params.action === 'info'
    ? executeSubscriptionTool({ action: 'info', user, language: 'en' })
    : { success: true, formattedCard: 'Current read card', data: {} });
  const history = [{ role: 'assistant', entities: { _turnMetadata: { kind: 'operational_result', mutationReceipts: [{ operation: 'task.create', summary: 'Task created: Old Alfa' }] } } }];
  const result = await routeMessage('Recap and explain payment safeguards', user, history);
  expect(result.confirmation).toContain('Task created: Old Alfa');
  expect(result.confirmation).toContain('quotes, not latest state');
  expect(result.confirmation).toContain('overflow and unavailable history');
  for (const fact of result.executionFacts) expect(result.confirmation).toContain(fact.card);
  expect(result.confirmation).toContain('Do not retry manually until the outcome is resolved');
  expect(callChatCompletion).toHaveBeenCalledTimes(1);
  expect(callResponseSynthesis).not.toHaveBeenCalled();
  expect(executeTool).toHaveBeenCalledTimes(2);
});

it.each(['failed', 'partial', 'empty'])('keeps non-task billing current recap honest for %s reads and missing history', async state => {
  callChatCompletion.mockResolvedValueOnce(modelResponse({ responseLanguage: 'en', responseCapability: 'billing_info', actions: [
    { domain: 'conversation', action: 'recap', recapMode: 'current' }, { domain: 'reminder', action: 'list' },
  ] }));
  executeTool.mockImplementation(async call => call.params.action === 'info'
    ? executeSubscriptionTool({ action: 'info', user, language: 'en' })
    : state === 'failed' ? { success: false, error: 'Read failed' }
      : { success: true, partialSuccess: state === 'partial', data: { reminders: [] } });
  const result = await routeMessage('Recap and explain payment safeguards', user, []);
  expect(result.confirmation).toContain('No eligible creation receipts');
  expect(result.confirmation).toContain('overflow and unavailable history');
  expect(result.confirmation).toContain(result.executionFacts[1]!.card);
  if (state !== 'empty') expect(result.confirmation).toContain('Current status in failed or partial reads is unknown');
  if (state === 'failed') expect(result.confirmation).toContain('Read failed');
  if (state === 'partial') expect(result.confirmation).toContain('action partially completed');
  expect(callChatCompletion).toHaveBeenCalledTimes(1);
  expect(callResponseSynthesis).not.toHaveBeenCalled();
});

it.each(['failed', 'partial'])('keeps %s read warnings beside the complete billing card', async state => {
  callChatCompletion.mockResolvedValueOnce(modelResponse({ responseLanguage: 'en', responseCapability: 'billing_info', actions: [{ domain: 'task', action: 'list', status: 'all' }] }));
  executeTool.mockImplementation(async call => call.params.action === 'info'
    ? executeSubscriptionTool({ action: 'info', user, language: 'en' })
    : state === 'failed' ? { success: false, errorCode: 'DATABASE_ERROR', error: 'Read failed' }
      : { success: true, partialSuccess: true, data: { tasks: [{ id: 'alfa', title: 'Alfa', status: 'pending' }] } });
  const result = await routeMessage('List tasks and explain payment safeguards', user, []);
  expect(result.executionFacts[0]!.complete).toBe(false);
  expect(result.confirmation).toContain(result.executionFacts[1]!.card);
  expect(result.confirmation).toContain(state === 'partial' ? 'action partially completed' : 'Read failed');
  expect(result.confirmation).not.toContain('Alfa: pending.');
  expect(callChatCompletion).toHaveBeenCalledTimes(1);
  expect(executeTool).toHaveBeenCalledTimes(2);
});

it('keeps an ordinary social response intact without a billing card', async () => {
  callChatCompletion.mockResolvedValueOnce(modelResponse({ responseCapability: 'general', actions: [{ domain: 'conversation', action: 'reply', content: 'Hola, qué gusto conversar contigo.' }] }));
  const result = await routeMessage('Hola, ¿cómo estás?', user, []);
  expect(result.confirmation).toBe('Hola, qué gusto conversar contigo.');
  expect(callChatCompletion).toHaveBeenCalledTimes(1);
  expect(executeTool).not.toHaveBeenCalled();
});

it.each([false, true])('renders declared billing capability despite URL-free unsafe reply for pro=%s', async pro => {
  hasProAccess.mockReturnValueOnce(pro);
  callChatCompletion.mockResolvedValueOnce(modelResponse({ responseCapability: 'billing_info', actions: [
    { domain: 'conversation', action: 'reply', content: 'Reintenta manualmente' },
  ] }));
  executeTool.mockImplementationOnce(call => executeSubscriptionTool({ action: call.params.action, user, language: 'es' }));
  const result = await routeMessage('¿Y si el pago falla?', user, []);
  expect(result.confirmation).toContain('No reintentes manualmente hasta resolver el resultado');
  expect(result.confirmation).not.toContain('Reintenta manualmente');
  expect(callChatCompletion).toHaveBeenCalledTimes(1);
  expect(executeTool).toHaveBeenCalledTimes(1);
  expect(executeTool.mock.calls[0]![0].params.action).toBe('info');
  expect(createPendingSubscription).not.toHaveBeenCalled();
  expect(resolveReminderProUpgradeContext).not.toHaveBeenCalled();
});

it('rejects a missing planner capability and billing capability mixed with writes before effects', async () => {
  for (const payload of [
    { actions: [{ operation: 'conversation.reply', content: 'Retry manually' }] },
    { responseCapability: 'billing_info', actions: [{ operation: 'subscription.link' }] },
    { responseCapability: null, actions: [{ operation: 'conversation.reply', content: 'Retry manually' }] },
  ]) {
    callChatCompletion.mockResolvedValueOnce({ content: JSON.stringify(payload) });
    const result = await routeMessage('Question', user, []);
    expect(result.confirmation).not.toContain('Retry manually');
    expect(executeTool).not.toHaveBeenCalled();
  }
});

it.each([false, true])('uses the side-effect-free typed billing card with unknown payment outcomes for pro=%s', async pro => {
  vi.stubEnv('BILLING_PROVIDER', 'stripe');
  getUserSubscription.mockResolvedValueOnce(null);
  hasProAccess.mockReturnValueOnce(pro);
  callChatCompletion.mockImplementationOnce(async messages => {
    expect(messages[0]!.content).toContain('Checkout confirmation: UNKNOWN');
    expect(messages[0]!.content).toContain('Charge outcome: UNKNOWN');
    expect(messages[0]!.content).toContain('Subscription state: UNKNOWN');
    return modelResponse({ actions: [{ domain: 'subscription', action: 'info' }] });
  });
  executeTool.mockImplementationOnce(call => executeSubscriptionTool({ action: call.params.action, user, language: 'es' }));
  const result = await routeMessage('Si el pago falla, ¿puedo reintentarlo?', user, []);
  expect(result.confirmation).toContain('confirmación del checkout, cualquier cargo');
  expect(result.confirmation).toContain('No reintentes manualmente hasta resolver el resultado');
  expect(result.confirmation).toContain(result.executionFacts[0]!.card);
  expect(result.ctaUrl).toBeNull();
  expect(callChatCompletion).toHaveBeenCalledTimes(1);
  expect(callResponseSynthesis).not.toHaveBeenCalled();
  expect(createPendingSubscription).not.toHaveBeenCalled();
  expect(resolveReminderProUpgradeContext).not.toHaveBeenCalled();
});

it('carries creation evidence through router entities after dialogue trimming, reads and failures', async () => {
  const history: { role: string; content: unknown; entities?: unknown }[] = [];
  callChatCompletion.mockResolvedValueOnce(modelResponse({ actions: [{ domain: 'task', action: 'create', title: 'Old Alfa', projectless: true }] }));
  executeTool.mockResolvedValueOnce({ success: true, data: { id: 'old-alfa', title: 'Old Alfa' } });
  let result = await routeMessage('Create Old Alfa', user, history);
  expect(result.executionFacts[0]!.card).toContain('Old Alfa');
  history.push({ role: 'assistant', content: result.confirmation, entities: result.entities });
  for (let index = 0; index < 34; index++) {
    const isRead = index % 4 === 0;
    const failed = index % 8 === 0;
    callChatCompletion.mockResolvedValueOnce(modelResponse({ actions: [isRead
      ? { domain: 'task', action: 'list', status: 'pending' }
      : { domain: 'conversation', action: 'reply', content: 'Hello' }] }));
    if (isRead) executeTool.mockResolvedValueOnce(failed
      ? { success: false, errorCode: 'DATABASE_ERROR', error: 'Read failed' }
      : { success: true, partialSuccess: true, data: { tasks: [] } });
    result = await routeMessage('Continue', user, history.slice(-30));
    history.push({ role: 'user', content: 'Continue' }, { role: 'assistant', content: result.confirmation, entities: result.entities });
  }
  callChatCompletion.mockImplementationOnce(async messages => {
    expect(messages.some(message => message.content.includes('Old Alfa'))).toBe(true);
    return modelResponse({ answerFromResults: true, actions: [{ domain: 'task', action: 'list', status: 'pending' }] });
  });
  executeTool.mockResolvedValueOnce({ success: true, data: { tasks: [{ id: 'old-alfa', title: 'Old Alfa', status: 'pending' }] } });
  callChatCompletion.mockImplementationOnce(async messages => {
    expect(observedPayload(messages[1]!.content).historicalReceipts[0]!.summary).toContain('Old Alfa');
    return modelResponse({ kind: 'inventory', answer: '', evidenceCallIds: [], taskClaims: [] });
  });
  result = await routeMessage('List tasks', user, history.slice(-30));
  history.push({ role: 'assistant', content: result.confirmation, entities: result.entities });
  callChatCompletion.mockResolvedValueOnce(modelResponse({ actions: [{ domain: 'conversation', action: 'recap', recapMode: 'historical' }] }));
  result = await routeMessage('Historical recap', user, history.slice(-30));
  expect(result.confirmation).toContain('Old Alfa');
  expect(result.confirmation).toContain('pueden faltar datos');
  expect(result.confirmation).toContain('no son inventario completo ni actualizado');
});

it('renders task descriptions and dates through the actual router without generated operational prose', async () => {
  callChatCompletion.mockResolvedValueOnce(modelResponse({ responseLanguage: 'en', answerFromResults: true, actions: [{ domain: 'task', action: 'list', status: 'all' }] }));
  executeTool.mockResolvedValueOnce({ success: true, data: { tasks: [{ id: 'alfa', title: '2 Borona', description: 'Original notes', due_date: '2031-01-14T15:00:00Z', completed_at: null }] } });
  callChatCompletion.mockImplementationOnce(async messages => {
    const callId = observedPayload(messages[1]!.content).observedReads[0]!.callId;
    return modelResponse({ kind: 'derived', answer: '', evidenceCallIds: [callId], taskClaims: [{ callId, itemId: 'alfa', referencePosition: null, fields: ['description', 'due_date', 'completed_at', 'status'] }] });
  });
  const result = await routeMessage('Describe the task and its dates', { ...user, locale: 'en' }, []);
  expect(result.confirmation).toContain('2 Borona');
  expect(result.confirmation).toContain('Original notes');
  expect(result.confirmation).toContain('2031-01-14T15:00:00Z');
  expect(result.confirmation).toContain('completed_at: absent');
  expect(result.confirmation).toContain('unknown');
  expect(callChatCompletion).toHaveBeenCalledTimes(2);
  expect(callResponseSynthesis).not.toHaveBeenCalled();
  expect(executeTool).toHaveBeenCalledTimes(1);
});

it('marks stale ordinal read interpretation partial without marking successful queries failed', async () => {
  saveWorkingMemory(user, { source: 'task', entityType: 'task', items: [{ id: 'beta', title: 'Beta', status: 'pending' }] });
  callChatCompletion.mockResolvedValueOnce(modelResponse({ responseLanguage: 'en', answerFromResults: true, actions: [{ domain: 'task', action: 'list', status: 'all' }] }));
  executeTool.mockResolvedValueOnce({ success: true, data: { tasks: [
    { id: 'alfa', user_id: user.id, title: 'Alfa', status: 'completed', description: 'Actual notes' },
    { id: 'beta', user_id: user.id, title: 'Beta', status: 'pending' },
  ] } });
  callChatCompletion.mockImplementationOnce(async (messages, options) => {
    expect(executeTool).toHaveBeenCalledTimes(1);
    const payload = observedPayload(messages[1]!.content);
    expect(payload.taskReferences.map(item => item.itemId)).toEqual(['beta']);
    const callId = payload.observedReads[0]!.callId;
    const decision = { kind: 'task_status', answer: 'The second task is completed.', evidenceCallIds: [callId], taskClaims: [
      { callId, itemId: 'alfa', referencePosition: 2, fields: ['status', 'description'] },
      { callId, itemId: 'beta', referencePosition: 1, fields: ['status'] },
    ] };
    expect(options.validateStructuredContent(JSON.stringify(decision)).valid).toBe(true);
    return modelResponse(decision);
  });
  const result = await routeMessage('Is the first pending and the second completed?', user, []);
  expect(result.confirmation).toContain('Alfa: completed; description: Actual notes.');
  expect(result.confirmation).toContain('Beta: pending.');
  expect(result.confirmation).toContain('requested positions cannot be bound to the last display');
  expect(result.confirmation).not.toMatch(/The second task is completed|unsupported comparisons/);
  expect(result.executionFacts[0]).toMatchObject({ success: true, outcome: 'success' });
  expect(result.entities._turnMetadata.interpretationOutcome).toBe('reference_unresolved');
  expect(result.entities._turnMetadata.operationalEvidence.events.at(-1)).toMatchObject({ operation: 'interpretation.read', outcome: 'partial_success' });
  expect(callChatCompletion).toHaveBeenCalledTimes(2);
  expect(executeTool).toHaveBeenCalledTimes(1);
  expect(callResponseSynthesis).not.toHaveBeenCalled();
});

it('binds status claims through the actual router to the pre-read named identities', async () => {
  saveWorkingMemory(user, { source: 'task', entityType: 'task', items: [
    { id: 'alfa', title: 'Alfa', status: 'pending' },
    { id: 'beta', title: 'Beta', status: 'pending' },
  ] });
  callChatCompletion.mockResolvedValueOnce(modelResponse({ answerFromResults: true, actions: [
    { domain: 'task', action: 'list', status: 'all' },
  ] }));
  executeTool.mockImplementationOnce(async () => {
    const tasks = [
      { id: 'beta', title: 'Beta', status: 'pending', user_id: user.id },
      { id: 'alfa', title: 'Alfa', status: 'completed', user_id: user.id },
    ];
    saveWorkingMemory(user, { source: 'task', entityType: 'task', items: tasks });
    return { success: true, data: { tasks } };
  });
  callChatCompletion.mockImplementationOnce(async messages => {
    const payload = observedPayload(messages[1]!.content);
    expect(payload.taskReferences.map(item => item.itemId)).toEqual(['alfa', 'beta']);
    const callId = payload.observedReads[0]!.callId;
    return modelResponse({ kind: 'task_status', answer: '', evidenceCallIds: [callId], taskClaims: [
      { callId, itemId: 'alfa', referencePosition: 1, fields: ['status'] },
      { callId, itemId: 'beta', referencePosition: 2, fields: ['status'] },
    ] });
  });
  const result = await routeMessage('¿Está completada la primera tarea y sigue pendiente la segunda?', user, []);
  expect(result.confirmation).toContain('Alfa: completada.\nBeta: pendiente.');
  expect(result.confirmation).toContain(result.executionFacts[0]!.card);
  expect(callChatCompletion).toHaveBeenCalledTimes(2);
  expect(callResponseSynthesis).not.toHaveBeenCalled();
  expect(executeTool).toHaveBeenCalledTimes(1);
});

function modelResponse(payload: { actions?: Record<string, unknown>[]; [key: string]: unknown }) {
  if (Array.isArray(payload.actions)) {
    payload = { responseCapability: 'general', ...payload, actions: payload.actions.map(({ domain, action, ...fields }) => ({ operation: `${domain}.${action}`, ...fields })) };
  }
  return { role: 'assistant', content: JSON.stringify(payload), tool_calls: [] };
}

it('persists canonical bounded creation receipts and recovers them without widening reads', async () => {
  callChatCompletion.mockResolvedValueOnce(modelResponse({ actions: [{ domain: 'task', action: 'create', title: 'Alfa', projectless: true }] }));
  executeTool.mockResolvedValueOnce({ success: true, data: { id: 'private-task', title: 'Alfa' } });
  const created = await routeMessage('Crea Alfa', user, []);
  expect(created.entities._turnMetadata.kind).toBe('operational_result');
  expect(created.entities._turnMetadata.mutationReceipts).toHaveLength(1);
  expect(JSON.stringify(created.entities._turnMetadata)).not.toContain('private-task');
  const history = [{ role: 'assistant', content: created.confirmation, entities: created.entities }, { role: 'assistant', content: 'Reminder created', entities: { _turnMetadata: { kind: 'operational_result', mutationReceipts: [{ operation: 'reminder.create', summary: 'Recordatorio programado: Alfa' }] } } }];
  executeTool.mockClear();
  callChatCompletion.mockClear();
  callChatCompletion.mockResolvedValueOnce(modelResponse({ answerFromResults: true, actions: [{ domain: 'task', action: 'list', status: 'pending' }, { domain: 'reminder', action: 'list', query: 'Alfa' }] }));
  executeTool.mockResolvedValueOnce({ success: true, data: { tasks: [{ title: 'Alfa', status: 'pending' }] } });
  executeTool.mockResolvedValueOnce({ success: false, errorCode: 'DATABASE_ERROR', error: 'No pude consultar tus recordatorios.' });
  callChatCompletion.mockImplementationOnce(async messages => {
    const payload = observedPayload(messages[1]!.content);
    expect(payload.historicalReceipts).toHaveLength(2);
    return modelResponse({ kind: 'derived', answer: 'Alfa pendiente', evidenceCallIds: [payload.observedReads[0]!.callId] });
  });
  const recap = await routeMessage('Resume las creaciones', user, history);
  expect(recap.confirmation).toContain('Tarea creada');
  expect(recap.confirmation).toContain('Recordatorio programado: Alfa');
  expect(recap.confirmation).toContain('no verificado');
  expect(recap.executionFacts.some(fact => fact.errorCode === 'DATABASE_ERROR')).toBe(true);
  expect(executeTool).toHaveBeenCalledTimes(2);
  expect(executeTool.mock.calls[1]![0].params.query).toBe('Alfa');
  expect(callChatCompletion).toHaveBeenCalledTimes(2);
});

it('grounds a successful literal reminder query in fresh facts while separating historical receipts', async () => {
  const { formatCanonicalReminderList } = await import('../../../src/shared/reminder-presentation.js');
  const receipts = [{ operation: 'reminder.create', summary: 'Recordatorio programado: Alfa (creación anterior)' }];
  const history = [{ role: 'assistant', content: receipts[0]!.summary, entities: { _turnMetadata: { kind: 'operational_result', mutationReceipts: receipts } } }];
  const reminders = [{ id: 'private-live-reminder', content: 'Revisar propuesta Alfa', status: 'pending', send_at: '2031-01-14T15:00:00.000Z', acknowledged_at: null }];
  const data = { reminders, filter: 'upcoming', query: 'Alfa', timezone: user.timezone };
  callChatCompletion.mockResolvedValueOnce(modelResponse({ responseLanguage: 'es', answerFromResults: true, actions: [{ domain: 'reminder', action: 'list', query: ' Alfa ' }] }));
  executeTool.mockImplementationOnce(async ({ toolName, params }) => {
    expect(toolName).toBe(TOOL_NAMES.MANAGE_REMINDER);
    expect(params).toMatchObject({ action: 'list', query: 'Alfa' });
    return { success: true, action: 'listed_reminders', data };
  });
  let observedCallId: string | undefined;
  callChatCompletion.mockImplementationOnce(async (messages, options) => {
    expect(options.purpose).toBe('observed_answer');
    expect(options.tools).toBeNull();
    const payload = observedPayload(messages[1]!.content);
    expect(payload.observedReads).toHaveLength(1);
    expect(payload.observedReads[0]).toMatchObject({ operation: 'list', data: { query: 'Alfa', reminders: [{ content: 'Revisar propuesta Alfa', status: 'pending', acknowledged_at: null }] } });
    expect(payload.historicalReceipts).toEqual(receipts);
    expect(payload.observedReads[0]!.data).not.toHaveProperty('mutationReceipts');
    expect(messages[0]!.content).toContain('a pending reminder is not sent');
    expect(messages[0]!.content).toContain('history is contextual only, not authoritative current-state evidence');
    expect(messages[0]!.content).toContain('Do not extend these conclusions to unseen items or infer a full inventory from filtered reads');
    observedCallId = payload.observedReads[0]!.callId;
    return modelResponse({ kind: 'recap', answer: 'El recordatorio Alfa consultado está pendiente, no enviado.', evidenceCallIds: [observedCallId] });
  });
  const result = await routeMessage('Resume la creación y consulta el estado actual de Alfa', user, history);
  expect(result.executionFacts).toHaveLength(1);
  expect(result.executionFacts[0]).toMatchObject({ success: true, complete: true, requestedAction: 'list', callId: observedCallId, presentationData: data });
  const canonicalCard = sanitizeResponseText(formatCanonicalReminderList(data, { language: 'es', timezone: user.timezone }));
  expect(result.executionFacts[0]!.card).toBe(canonicalCard);
  expect(result.confirmation).toContain(canonicalCard);
  expect(result.confirmation).toContain('pendiente, no enviado');
  expect(result.confirmation).toContain('Acciones históricas confirmadas (citas, no estado actual)');
  expect(result.confirmation).toContain(receipts[0]!.summary);
  expect(result.confirmation).not.toContain('no verificado');
  expect(result.confirmation).not.toContain('private-live-reminder');
  expect(executeTool).toHaveBeenCalledTimes(1);
  expect(callChatCompletion).toHaveBeenCalledTimes(2);
  expect(callResponseSynthesis).not.toHaveBeenCalled();
});

it('preserves query-scoped zero-match canonical cards through fresh facts and observed reads', async () => {
  const data = { reminders: [], items: [], filter: 'upcoming', query: 'Alfa' };
  callChatCompletion.mockResolvedValueOnce(modelResponse({ responseLanguage: 'es', answerFromResults: true, actions: [{ domain: 'reminder', action: 'list', query: ' Alfa ' }] }));
  executeTool.mockImplementationOnce(async ({ toolName, params }) => {
    expect(toolName).toBe(TOOL_NAMES.MANAGE_REMINDER);
    expect(params).toMatchObject({ action: 'list', query: 'Alfa' });
    return { success: true, action: 'listed_reminders', data };
  });
  let observedCallId: string | undefined;
  callChatCompletion.mockImplementationOnce(async (messages, options) => {
    expect(options.purpose).toBe('observed_answer');
    const payload = observedPayload(messages[1]!.content);
    expect(payload.observedReads).toHaveLength(1);
    expect(payload.observedReads[0]).toMatchObject({ operation: 'list', data });
    expect(messages[0]!.content).toContain('Do not extend these conclusions to unseen items or infer a full inventory from filtered reads');
    observedCallId = payload.observedReads[0]!.callId;
    return modelResponse({ kind: 'inventory', answer: '', evidenceCallIds: [observedCallId] });
  });
  const result = await routeMessage('Busca recordatorios Alfa', user, []);
  const card = '🔔 *Recordatorios pendientes*\n\nNo hay recordatorios que coincidan con tu búsqueda dentro del alcance solicitado. 🔎';
  expect(result.executionFacts).toHaveLength(1);
  expect(result.executionFacts[0]).toMatchObject({ success: true, complete: true, callId: observedCallId, presentationData: data, card });
  expect(result.confirmation).toBe(card);
  expect(result.confirmation).not.toContain('No tienes recordatorios pendientes');
  expect(executeTool).toHaveBeenCalledTimes(1);
  expect(callChatCompletion).toHaveBeenCalledTimes(2);
  expect(callResponseSynthesis).not.toHaveBeenCalled();
});

it('renders subscription info without speculative planned prose or observed synthesis', async () => {
  callChatCompletion.mockResolvedValueOnce(modelResponse({ answerFromResults: true, excluded: [{ quote: 'Use PayPal', reason: 'prohibited' }], actions: [
    { domain: 'subscription', action: 'info' },
    { domain: 'conversation', action: 'reply', content: 'Use PayPal and a corporate email.' },
  ] }));
  executeTool.mockResolvedValue({ success: true, action: 'subscription_info', formattedCard: 'Public billing uncertainty card', rawSummary: 'Public billing uncertainty card', data: { formattedCard: 'Public billing uncertainty card' } });
  const result = await routeMessage('Explain payment without checkout', user, []);
  expect(result.confirmation).toContain('Public billing uncertainty card');
  expect(result.confirmation).not.toContain('PayPal');
  expect(result.confirmation).not.toContain('corporate');
  expect(callChatCompletion).toHaveBeenCalledTimes(1);
  expect(callResponseSynthesis).not.toHaveBeenCalled();
});

it.each(['[checkout_url]', 'https://checkout.stripe.com/pay/test', 'https://shop.lemonsqueezy.com/buy/test', 'https://mercadopago.com/pay/test', '[auth_url] [checkout_url]'])('uses pure information for untrusted payment reference %s', async (content) => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('network forbidden'); });
  callChatCompletion.mockResolvedValueOnce(modelResponse({ actions: [{ domain: 'conversation', action: 'reply', content }] }));
  vi.stubEnv('BILLING_PROVIDER', 'stripe');
  executeTool.mockImplementation(async ({ params }) => executeSubscriptionTool({ action: params.action, user }));
  const result = await routeMessage('Explain billing; do not create checkout', user, []);
  expect(result.confirmation).toContain('Proveedor de pago: Stripe');
  expect(result.confirmation).not.toContain('[checkout_url]');
  expect(result.ctaUrl).toBeNull();
  expect(executeTool).toHaveBeenCalledTimes(1);
  expect(executeTool.mock.calls[0]![0].params.action).toBe('info');
  expect(resolveReminderProUpgradeContext).not.toHaveBeenCalled();
  expect(createPendingSubscription).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(callChatCompletion).toHaveBeenCalledTimes(1);
  expect(callResponseSynthesis).not.toHaveBeenCalled();
});

it('does not resolve checkout placeholders in excluded-clause synthesis', async () => {
  callChatCompletion.mockResolvedValueOnce(modelResponse({ excluded: [{ quote: 'Do not create payment', reason: 'prohibited' }], actions: [{ domain: 'task', action: 'list', status: 'pending' }] }));
  executeTool.mockResolvedValue({ success: true, action: 'listed_tasks', rawSummary: 'No tasks', data: { tasks: [] } });
  callResponseSynthesis.mockResolvedValueOnce({ before: 'Payment [checkout_url] https://shop.lemonsqueezy.com/buy/old', after: '' });
  const result = await routeMessage('List tasks', user, []);
  expect(callResponseSynthesis).not.toHaveBeenCalled();
  expect(result.confirmation).toContain('Las instrucciones excluidas no se ejecutaron');
  expect(result.confirmation).not.toContain('[checkout_url]');
  expect(resolveReminderProUpgradeContext).not.toHaveBeenCalled();
  expect(createPendingSubscription).not.toHaveBeenCalled();
  expect(result.ctaUrl).toBeNull();
});

it('does not resolve checkout placeholders in next-action output', async () => {
  callChatCompletion.mockResolvedValueOnce(modelResponse({ actions: [{ domain: 'task', action: 'list', status: 'pending' }] }));
  executeTool.mockResolvedValue({ success: true, action: 'listed_tasks', rawSummary: 'No tasks', data: { tasks: [] } });
  resolveNextBestAction.mockResolvedValueOnce({ recommendationText: 'Payment [checkout_url]' });
  const result = await routeMessage('List tasks', user, []);
  expect(result.confirmation).not.toContain('[checkout_url]');
  expect(resolveReminderProUpgradeContext).not.toHaveBeenCalled();
  expect(createPendingSubscription).not.toHaveBeenCalled();
  expect(callChatCompletion).toHaveBeenCalledTimes(1);
  expect(result.ctaUrl).toBeNull();
});

it('preserves auth-only conversation CTA', async () => {
  callChatCompletion.mockResolvedValueOnce(modelResponse({ actions: [{ domain: 'conversation', action: 'reply', content: 'Connect [auth_url]' }] }));
  const result = await routeMessage('Connect calendar', user, []);
  expect(result.ctaUrl).toBe('https://example.test/google');
  expect(result.confirmation).not.toContain('[auth_url]');
  expect(executeTool).not.toHaveBeenCalled();
  expect(resolveReminderProUpgradeContext).not.toHaveBeenCalled();
});

it('preserves explicit canonical checkout CTA beside local information', async () => {
  callChatCompletion.mockResolvedValueOnce(modelResponse({ actions: [{ domain: 'subscription', action: 'info' }, { domain: 'subscription', action: 'link' }] }));
  executeTool.mockImplementation(async ({ params }) => params.action === 'info'
    ? { success: true, action: 'subscription_info', formattedCard: 'This information request does not generate a checkout link.' }
    : { success: true, action: 'subscription_link_generated', formattedCard: 'Secure checkout', ctaUrl: 'https://checkout.stripe.com/authorized', data: { checkout_url: 'https://checkout.stripe.com/authorized' } });
  const result = await routeMessage('Explain billing and generate my checkout link', user, []);
  expect(result.ctaUrl).toBe('https://checkout.stripe.com/authorized');
  expect(result.confirmation).toContain('This information request does not generate');
  expect(result.confirmation).toContain('Secure checkout');
  expect(executeTool.mock.calls.filter(([call]) => call.params.action === 'get_link')).toHaveLength(1);
  expect(callChatCompletion).toHaveBeenCalledTimes(1);
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  clearWorkingMemory(user);
  storage.resetInMemoryAgentRuns();
  executeTool.mockReset();
  callChatCompletion.mockReset();
});


const context = () => ({ user, language: 'es', isPro: true, timezone: user.timezone, referenceTime: new Date() });
const incomplete = (content = 'Comprar café') => ({ domain: 'reminder', action: 'create', content, missingFields: ['schedule'] });
const tomorrow = { kind: 'relative_day_time', dayOffset: 1, hour: 8, minute: 0, clockMode: 'explicit_24h' };

describe('core contract reliability across turns', () => {
  it('retains every displayed reminder identity after a fresh multi-action creation', async () => {
    executeTool.mockImplementation(async ({ params }) => ({ success: true, action: 'created_reminder', data: { items: params.items.map(item => ({ id: item.content, content: item.content, send_at: item.targetTime })) } }));
    await executeTurnIntent({ actions: ['Alpha', 'Beta'].map(content => ({ domain: 'reminder', action: 'create', content, schedule: tomorrow })) }, context());
    expect(getWorkingMemory(user)!.items.map(item => item.internalId)).toEqual(['Alpha', 'Beta']);
  });

  it.each(['approval', 'continuation'])('stops %s execution when a tool returns no observable success flag', async mode => {
    executeTool.mockResolvedValue({ message: 'Malformed transport result' });
    const actions = ['Alpha', 'Beta'].map(content => ({ domain: 'reminder', action: 'create', content, schedule: tomorrow }));
    let result;
    if (mode === 'approval') {
      const run = await agentRunModule.createApprovalRun({ user, kind: 'reminder_creation', preparedActions: actions.map((payload, index) => ({ callId: `call-${index + 1}`, domain: 'reminder', action: 'create', payload })) });
      result = await executeApprovalDecision({ run: run!, decision: 'approve_all', executionContext: context() });
      expect(result.executedCount).toBe(1);
    } else {
      const run = await agentRunModule.createInputRun({ user, partialActions: actions });
      result = await executeContinuationDecision({ run: run!, executionContext: context() });
    }
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(result.facts.map(fact => fact.outcome)).toEqual(['unknown']);
    expect(result.status).toBe('failed');
  });

  it.each(['approval', 'continuation'])('preserves displayed task positions after a %s deletion', async mode => {
    const items = [{ id: 'task-a', title: 'Alpha', status: 'pending' }, { id: 'task-b', title: 'Beta', status: 'pending' }];
    saveWorkingMemory(user, { source: 'task', entityType: 'task', lastAction: 'list', items });
    executeTool.mockResolvedValue({ success: true, action: 'deleted_task', data: items[0] });
    if (mode === 'approval') {
      const run = await agentRunModule.createApprovalRun({ user, kind: 'task_mutation', preparedActions: [{ callId: 'call-1', domain: 'task', action: 'delete', targetId: 'task-a', payload: { action: 'delete', target: 'task-a' } }] });
      await executeApprovalDecision({ run: run!, decision: 'approve_all', executionContext: context() });
    } else {
      const run = await agentRunModule.createInputRun({ user, kind: 'task_mutation', partialAction: { domain: 'task', action: 'delete', target: 'task-a' } });
      await executeContinuationDecision({ run: run!, executionContext: context() });
    }
    const memory = getWorkingMemory(user)!;
    expect(memory.items.map(item => item.internalId)).toEqual(['task-a', 'task-b']);
    expect(memory.items[0]!.raw.status).toBe('deleted');
    expect(memory.lastAction).toBe('deleted_task');
  });

  it('rejects unsupported task calculations after observing authoritative read results', async () => {
    callChatCompletion.mockResolvedValueOnce(modelResponse({ responseLanguage: 'es', answerFromResults: true, actions: [
      { domain: 'task', action: 'list', status: 'pending', entityName: 'Apartamento' },
    ] }));
    executeTool.mockResolvedValue({ success: true, action: 'listed_tasks', data: { tasks: [{ id: 't1', title: 'Cuota de 120', status: 'pending' }] } });
    callChatCompletion.mockImplementationOnce(async (messages, options) => {
      expect(executeTool).toHaveBeenCalledTimes(1);
      expect(options.purpose).toBe('observed_answer');
      expect(options.tools).toBeNull();
      expect(messages.at(-1)!.content).toContain('Cuota de 120');
      return modelResponse({ kind: 'derived', answer: 'Los importes mostrados suman 120.', evidenceCallIds: ['call_1'] });
    });
    const result = await routeMessage('¿Cuánto suman las cuotas pendientes?', user, []);
    expect(result.confirmation).not.toContain('suman 120');
    expect(result.confirmation).toContain('cálculos no admitidos siguen desconocidos');
    expect(result.executionFacts).toHaveLength(1);
    expect(callChatCompletion).toHaveBeenCalledTimes(2);
  });

  it('keeps verified cards when the observation answer cites nonexistent evidence', async () => {
    callChatCompletion.mockResolvedValueOnce(modelResponse({ answerFromResults: true, actions: [{ domain: 'task', action: 'list', status: 'pending' }] }));
    executeTool.mockResolvedValue({ success: true, action: 'listed_tasks', rawSummary: 'Cuota pendiente: 120.' });
    callChatCompletion.mockResolvedValueOnce(modelResponse({ kind: 'derived', answer: 'Todo está pagado.', evidenceCallIds: ['invented'] }));
    const result = await routeMessage('¿Cuánto debo?', user, []);
    expect(result.confirmation).toContain('120');
    expect(result.confirmation).not.toContain('Todo está pagado');
  });

  it('never starts an observation loop to reexecute or rewrite a mutation result', async () => {
    callChatCompletion.mockResolvedValueOnce(modelResponse({ answerFromResults: true, actions: [{ domain: 'task', action: 'delete', target: 'Cuota' }] }));
    executeTool.mockResolvedValue({ success: false, error: 'No se pudo eliminar.' });
    await routeMessage('Elimina Cuota', user, []);
    expect(callChatCompletion).toHaveBeenCalledTimes(1);
  });

  it('executes only once when independent workers load the same pending run', async () => {
    await executeTurnIntent({ actions: [incomplete()] }, context());
    const run = await getActiveAgentRun(user);
    const readPrepared = storage.getPreparedActionsFromDb;
    vi.spyOn(storage, 'getPreparedActionsFromDb').mockImplementation(async id => structuredClone(await readPrepared(id)));
    executeTool.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return { success: true, action: 'created_reminder', rawSummary: 'Creado.' };
    });
    const results = await Promise.all([1, 2].map(() => executeContinuationDecision({ run: structuredClone(run)!, suppliedFields: { schedule: tomorrow }, executionContext: context() })));
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(results.filter(result => result.success)).toHaveLength(1);
  });

  it('retains action-specific times while obtaining shared content in a later turn', async () => {
    await executeTurnIntent({ actions: [incomplete(''), incomplete('')] }, context());
    let run = await getActiveAgentRun(user);
    const first = await executeContinuationDecision({ run: run!, actionInputs: [
      { callId: 'call-1', fields: { schedule: { ...tomorrow, hour: 7 } } },
      { callId: 'call-2', fields: { schedule: { ...tomorrow, hour: 16 } } },
    ], executionContext: context() });
    expect(first.status).toBe('waiting_for_input');
    expect(executeTool).not.toHaveBeenCalled();
    run = await getActiveAgentRun(user);
    executeTool.mockResolvedValue({ success: true, action: 'created_reminder', rawSummary: 'Creado.' });
    await executeContinuationDecision({ run: run!, suppliedFields: { content: 'Revisar contrato' }, executionContext: context() });
    expect(executeTool).toHaveBeenCalledTimes(2);
    const items = executeTool.mock.calls.map(([call]) => call.params.items[0]!);
    expect(items.map(item => item.content)).toEqual(['Revisar contrato', 'Revisar contrato']);
    expect(new Date(items[1]!.targetTime).getTime() - new Date(items[0]!.targetTime).getTime()).toBe(9 * 60 * 60 * 1000);
  });

  it('rejects a patch for an unknown action without mutating or retiring the draft', async () => {
    await executeTurnIntent({ actions: [incomplete()] }, context());
    const run = await getActiveAgentRun(user);
    const result = await executeContinuationDecision({ run: run!, actionInputs: [{ callId: 'other-run-call', fields: { schedule: tomorrow } }], executionContext: context() });
    expect(result.success).toBe(false);
    expect(executeTool).not.toHaveBeenCalled();
    expect((await getActiveAgentRun(user))!.id).toBe(run!.id);
  });

  it('replaces an approval through canonical parsing without executing its old proposal', async () => {
    const run = await agentRunModule.createApprovalRun({ user, kind: 'reminder_creation',
      preparedActions: [{ callId: 'call-1', domain: 'reminder', action: 'create', payload: { action: 'create', items: [{ content: 'Vieja propuesta', targetTime: '2030-01-01T12:00:00Z' }] } }] });
    callChatCompletion.mockResolvedValueOnce(modelResponse({ relation: 'supersede', responseLanguage: 'en' }));
    callChatCompletion.mockResolvedValueOnce(modelResponse({ responseLanguage: 'en', actions: [
      { domain: 'reminder', action: 'create', content: 'New request', schedule: tomorrow },
    ] }));
    executeTool.mockResolvedValue({ success: true, action: 'created_reminder', rawSummary: 'Created new request.' });
    const result = await routeMessage('Wait, replace that with the new request tomorrow morning.', user, []);
    expect(result.language).toBe('en');
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool.mock.calls[0]![0].params.items[0]!.content).toBe('New request');
    expect(await getActiveAgentRun(user)).toBeNull();
    expect(formatActiveRunPrompt(run)).toContain('Vieja propuesta');
  });

  it('acquires an approval exclusively and does not replay completed actions', async () => {
    const run = await agentRunModule.createApprovalRun({ user, kind: 'reminder_creation',
      preparedActions: [{ callId: 'call-1', domain: 'reminder', action: 'create', payload: { action: 'create', items: [{ content: 'Contrato', targetTime: '2030-01-01T12:00:00Z' }] } }] });
    executeTool.mockResolvedValue({ success: true, action: 'created_reminder', rawSummary: 'Creado.' });
    await Promise.all([1, 2].map(() => executeApprovalDecision({ run: structuredClone(run)!, decision: 'approve_all', executionContext: context() })));
    await executeApprovalDecision({ run: run!, decision: 'approve_all', executionContext: context() });
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it('uses one model-selected language for a resumed clarification without persisting an implicit preference', async () => {
    await executeTurnIntent({ actions: [incomplete()] }, context());
    callChatCompletion.mockResolvedValueOnce(modelResponse({ relation: 'resume', responseLanguage: 'en', suppliedFields: { schedule: { kind: 'local_time', hour: 8, clockMode: 'ambiguous_12h' } } }));
    const result = await routeMessage('At eight', user, []);
    expect(result.language).toBe('en');
    expect(result.confirmation).toContain('AM or PM');
    expect(user.locale).toBe('es-CO');
    expect(updateUserPreferences).not.toHaveBeenCalled();
  });

  it('applies an explicit IANA profile change before executing the related schedule', async () => {
    const localUser = { ...user };
    updateUserPreferences.mockResolvedValueOnce({ ...localUser, timezone: 'America/Los_Angeles' });
    callChatCompletion.mockResolvedValueOnce(modelResponse({ responseLanguage: 'en', profileUpdate: {
      sourceQuote: 'Set my timezone to America/Los_Angeles', timezone: 'America/Los_Angeles',
    }, actions: [{ domain: 'reminder', action: 'create', content: 'Review contract', schedule: tomorrow }] }));
    executeTool.mockResolvedValue({ success: true, action: 'created_reminder', rawSummary: 'Created.' });
    const result = await routeMessage('Set my timezone to America/Los_Angeles and remind me to review the contract tomorrow at 8am.', localUser, []);
    expect(updateUserPreferences).toHaveBeenCalledWith(user.id, { timezone: 'America/Los_Angeles' });
    expect(executeTool.mock.calls[0]![0].user.timezone).toBe('America/Los_Angeles');
    expect(result.executionFacts.map(fact => fact.success)).toEqual([true, true]);
  });

  it.each(['json', 'direct'])('preserves a summary with stale optional profile evidence via %s', async mode => {
    const intent = { responseCapability: 'general', responseLanguage: 'en', profileUpdate: { sourceQuote: 'Responde en inglés a partir de ahora', language: 'en' }, actions: [{ domain: 'conversation', action: 'reply', content: 'We discussed communication preferences.' }] };
    callChatCompletion.mockImplementationOnce(async (_messages, options) => {
      expect(options.validateStructuredContent(JSON.stringify(intent)).valid).toBe(true);
      return mode === 'direct' ? { structuredIntent: intent } : modelResponse(intent);
    });
    const result = await routeMessage('Summarize our discussion.', { ...user }, [{ role: 'user', content: intent.profileUpdate.sourceQuote }]);
    expect(result.confirmation).toContain('We discussed communication preferences.');
    expect(updateUserPreferences).not.toHaveBeenCalled();
    expect(executeTool).not.toHaveBeenCalled();
    expect(result.executionFacts).toEqual([]);
  });
  it('preserves a read but blocks a mutation with stale profile evidence at both boundaries', async () => {
    const stale = { sourceQuote: 'Set my timezone to Europe/Madrid', timezone: 'Europe/Madrid' };
    const read = { responseCapability: 'general', profileUpdate: stale, actions: [{ domain: 'task', action: 'list', status: 'pending' }] };
    callChatCompletion.mockImplementationOnce(async (_messages, options) => {
      expect(options.validateStructuredContent(JSON.stringify(read)).valid).toBe(true);
      return modelResponse(read);
    });
    executeTool.mockResolvedValueOnce({ success: true, data: { tasks: [] } });
    await routeMessage('List pending tasks.', { ...user }, []);
    expect(executeTool).toHaveBeenCalledTimes(1);
    executeTool.mockClear();
    const mutation = { ...read, actions: [{ domain: 'reminder', action: 'create', content: 'Contract', schedule: tomorrow }] };
    callChatCompletion.mockImplementationOnce(async (_messages, options) => {
      expect(options.validateStructuredContent(JSON.stringify(mutation)).valid).toBe(false);
      return { structuredIntent: mutation };
    });
    const result = await routeMessage('Remind me tomorrow.', { ...user }, []);
    expect(result.intent).toBe('clarification');
    expect(executeTool).not.toHaveBeenCalled();
    expect(updateUserPreferences).not.toHaveBeenCalled();
  });
  it('does not persist profile changes authorized only by quoted evidence', async () => {
    callChatCompletion.mockResolvedValueOnce(modelResponse({ responseLanguage: 'en', profileUpdate: {
      sourceQuote: 'I live in Madrid', timezone: 'Europe/Madrid',
    }, actions: [{ domain: 'conversation', action: 'reply', content: 'The quoted speaker lives in Madrid.' }] }));
    const result = await routeMessage('<untrusted_quoted_message>I live in Madrid</untrusted_quoted_message>Summarize that.', user, []);
    expect(updateUserPreferences).not.toHaveBeenCalled();
    expect(result.executionFacts).toEqual([]);
    expect(result.confirmation).toContain('The quoted speaker lives in Madrid.');
  });
  it('preserves observed successes and stops the batch after an unknown tool outcome', async () => {
    executeTool.mockResolvedValueOnce({ success: true, action: 'deleted_task', data: { id: 'task-cafe', title: 'Comprar café' } });
    executeTool.mockRejectedValueOnce(new Error('Connection closed after write'));
    const result = await executeTurnIntent({ actions: [
      { domain: 'task', action: 'delete', target: 'Comprar café' },
      { domain: 'task', action: 'delete', target: 'Comprar leche' },
      { domain: 'task', action: 'delete', target: 'Comprar pan' },
    ] }, context());
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(result.facts.map(f => f.outcome)).toEqual(['success', 'unknown']);
    expect(result.facts[1]!.summary).toContain('confirmar');
  });
  it('does not prepend a success claim when the requested tool fails', async () => {
    callChatCompletion.mockResolvedValueOnce(modelResponse({ actions: [
      { domain: 'conversation', action: 'reply', content: 'Ya eliminé tu tarea.' },
      { domain: 'task', action: 'delete', target: 'Comprar café' },
    ] }));
    executeTool.mockResolvedValueOnce({ success: false, action: 'error', error: 'No se pudo eliminar la tarea.', errorCode: 'DATABASE_ERROR' });
    const result = await routeMessage('Elimina la tarea de comprar café', user, []);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(result.executionFacts[0]!.success).toBe(false);
    expect(result.confirmation).not.toContain('Ya eliminé tu tarea.');
  });

  it('discloses a successful action when another resumed action fails', async () => {
    await executeTurnIntent({ actions: [incomplete('Comprar café'), incomplete('Comprar leche')] }, context());
    callChatCompletion.mockResolvedValueOnce(modelResponse({ relation: 'resume', suppliedFields: { schedule: tomorrow } }));
    executeTool.mockResolvedValueOnce({ success: true, action: 'created_reminder', data: { id: 'rem-cafe', content: 'Comprar café' }, rawSummary: 'Creado: Comprar café.' });
    executeTool.mockResolvedValueOnce({ success: false, action: 'error', error: 'No se pudo crear Comprar leche.', errorCode: 'DATABASE_ERROR' });
    const result = await routeMessage('Mañana a las ocho de la mañana', user, []);
    expect(result.executionFacts.map(f => f.success)).toEqual([true, false]);
    expect(result.confirmation).toContain('Comprar café');
    expect(result.confirmation).toContain('Comprar leche');
  });

  it('preserves an unrelated pending draft when another action requires approval', async () => {
    await executeTurnIntent({ actions: [incomplete()] }, context());
    const original = await getActiveAgentRun(user);
    callChatCompletion.mockResolvedValueOnce(modelResponse({ relation: 'unrelated' }));
    callChatCompletion.mockResolvedValueOnce(modelResponse({ actions: [{ domain: 'project', action: 'delete', scope: 'all' }] }));
    executeTool.mockResolvedValueOnce({ success: false, requiresClarification: true, action: 'project_deletion_confirmation_required', error: 'Confirma la eliminación.', data: { previewProjects: [{ id: 'project-a', name: 'Proyecto A' }] } });
    await routeMessage('Elimina todos mis proyectos', user, []);
    const active = await getActiveAgentRun(user);
    expect(active?.id).toBe(original!.id);
  });

  it('keeps the draft pending when the next answer still lacks a required field', async () => {
    await executeTurnIntent({ actions: [incomplete()] }, context());
    callChatCompletion.mockResolvedValueOnce(modelResponse({ relation: 'resume', suppliedFields: { schedule: { kind: 'local_time', hour: 8, minute: 0, clockMode: 'ambiguous_12h' } } }));
    const result = await routeMessage('A las ocho', user, []);
    expect(executeTool).not.toHaveBeenCalled();
    expect(result.executionFacts[0]!.success).toBe(false);
    expect(await getActiveAgentRun(user)).not.toBeNull();
  });

});

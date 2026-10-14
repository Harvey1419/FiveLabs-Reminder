import { untrustedResultMock } from '../../support/unit/contract-boundary.js';
import type { WorkingMemoryState } from '../../../src/agent/core/working-memory-cache.js';
import type { ExecutionIntent } from '../../../src/agent/orchestration/turn-intent-executor.js';
import type { ToolOptions } from '../../../src/agent/tools/remaining-tool-ports.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../../src/agent/tools/index.js', () => ({ executeTool: vi.fn() }));
vi.mock('../../../src/agent/providers/client.js', () => ({ callChatCompletion: vi.fn(), callResponseSynthesis: vi.fn() }));
vi.mock('../../../src/agent/core/agent-run.js', () => ({ getActiveAgentRun: vi.fn().mockResolvedValue(null), formatActiveRunPrompt: vi.fn(() => ''), cancelSupersededInputRun: vi.fn(), createInputRun: vi.fn().mockResolvedValue({ id: 'offline-input' }), createApprovalRun: vi.fn() }));
vi.mock('../../../src/features/memory/service.js', () => ({ retrieveRelevantMemories: vi.fn().mockResolvedValue([]), retrieveStandingPreferences: vi.fn().mockResolvedValue([]), getProactiveAnchors: vi.fn().mockResolvedValue([]) }));
vi.mock('../../../src/infrastructure/database/index.js', () => ({ getDailyOverview: vi.fn().mockResolvedValue(null), getUserSubscription: vi.fn().mockResolvedValue(null), getUserIntegration: vi.fn().mockResolvedValue(null), hasProAccess: vi.fn(() => false) }));
vi.mock('../../../src/infrastructure/database/users.js', () => ({ updateUserPreferences: vi.fn() }));
vi.mock('../../../src/integrations/google/auth.js', () => ({ getGoogleConnectUrl: vi.fn(), hasUsableGoogleCredentials: vi.fn(() => false) }));
vi.mock('../../../src/agent/orchestration/next-best-action.js', () => ({ resolveNextBestAction: vi.fn().mockResolvedValue(null) }));
import { routeMessage } from '../../../src/agent/orchestration/router.js';
import { executeTurnIntent } from '../../../src/agent/orchestration/intent-executor.js';
import { normalizeTurnIntentForRuntime as normalizeIntent } from '../../../src/agent/orchestration/intent-normalizer.js';
import { saveWorkingMemory, getWorkingMemory, clearWorkingMemory, formatWorkingMemoryPrompt, hydrateWorkingMemoryFromHistory } from '../../../src/agent/core/working-memory-store.js';
import { callChatCompletion } from '../../../src/agent/providers/client.js';
import { executeTool } from '../../../src/agent/tools/index.js';
import { createInputRun, createApprovalRun, cancelSupersededInputRun } from '../../../src/agent/core/agent-run.js';
// Pass the same runtime-normalized object through the executor's consumed intent port.
function normalizeTurnIntentForRuntime(...args: Parameters<typeof normalizeIntent>) {
  return normalizeIntent(...args) as ExecutionIntent;
}
const user = { id: 'offline-view', phone_number: 'offline-view', timezone: 'UTC', locale: 'en' };
const alpha = '11111111-1111-4111-8111-111111111111';
const beta = '22222222-2222-4222-8222-222222222222';
const rows = [{ id: beta, user_id: user.id, title: 'Beta', status: 'pending' }, { id: alpha, user_id: user.id, title: 'Alpha', status: 'pending', description: 'Actual notes' }];
const context = { user, language: 'en' };
function plan(actions: unknown[]) { untrustedResultMock(callChatCompletion).mockResolvedValueOnce({ content: JSON.stringify({ responseCapability: 'general', responseLanguage: 'en', actions }) }); }
beforeEach(() => { vi.clearAllMocks(); saveWorkingMemory(user, { source: 'task', entityType: 'task', activeEntity: 'Work', notificationReminderId: 'notification', notificationContent: 'Keep me', items: rows }); });
afterEach(() => clearWorkingMemory(user));
it('preserves displayed Beta1/Alpha2 across an invisible filtered field read and binds mutation2 to Alpha', async () => {
  plan([{ operation: 'task.list', status: 'all', query: 'Alpha', returnFields: ['description'] }]);
  untrustedResultMock(executeTool).mockResolvedValueOnce({ success: true, data: { tasks: [rows[1]] } });
  const result = await routeMessage('And number 2?', user, []);
  expect(result.confirmation).toBe('Alpha: description: Actual notes.');
  expect((result.executionFacts![0]!.presentationData as { tasks: unknown }).tasks).toEqual([rows[1]]);
  expect((result.entities!._workingMemory as WorkingMemoryState).items.map(item => [item.position, item.internalId])).toEqual([[1, beta], [2, alpha]]);
  expect(getWorkingMemory(user)!).toMatchObject({ activeEntity: 'Work', notificationReminderId: 'notification', notificationContent: 'Keep me' });
  plan([{ operation: 'task.update', contextRef: { source: 'working_memory', position: 2 }, clearFields: ['description'] }]);
  untrustedResultMock(executeTool).mockResolvedValueOnce({ success: true, action: 'updated_task', data: { ...rows[1], description: null } });
  await routeMessage('Clear Alpha description', user, []);
  expect((untrustedResultMock(executeTool).mock.calls[1]![0] as ToolOptions).params).toMatchObject({ target: alpha });
  expect(getWorkingMemory(user)!.items.map(item => item.internalId)).toEqual([beta, alpha]);
  expect(getWorkingMemory(user)!.items[1]!.raw.description).toBeNull();
});
it('still replaces positions when a filtered numbered card is actually displayed', async () => {
  plan([{ operation: 'task.list', status: 'all', query: 'Alpha' }]);
  untrustedResultMock(executeTool).mockResolvedValueOnce({ success: true, data: { tasks: [rows[1]] } });
  const result = await routeMessage('List Alpha', user, []);
  expect(result.confirmation).toContain('1.');
  expect(getWorkingMemory(user)!.items.map(item => [item.position, item.internalId])).toEqual([[1, alpha]]);
});
it.each([3, 0])('returns specific clarification without a draft, approval, cancellation or mutation for invalid position %s', async position => {
  const intent = normalizeTurnIntentForRuntime({ actions: [{ domain: 'task', action: 'update', target: 'Alpha', contextRef: { source: 'working_memory', position }, clearFields: ['description'], missingFields: ['content'] }] }, context);
  const result = await executeTurnIntent(intent, { ...context, supersedesRunId: 'unrelated-run' });
  expect(result.records[0]!.result).toMatchObject({ requiresClarification: true, errorCode: 'INVALID_CONTEXT_REFERENCE' });
  expect(result.facts[0]!.card).toContain('displayed list');
  expect(executeTool).not.toHaveBeenCalled();
  expect(createInputRun).not.toHaveBeenCalled();
  expect(createApprovalRun).not.toHaveBeenCalled();
  expect(cancelSupersededInputRun).not.toHaveBeenCalled();
  const tool = vi.fn().mockResolvedValue({ success: true, data: rows[1] });
  await executeTurnIntent(normalizeTurnIntentForRuntime({ actions: [{ domain: 'task', action: 'update', contextRef: { source: 'working_memory', position: 2 }, clearFields: ['description'] }] }, context), { ...context, executeTool: tool });
  expect(tool.mock.calls[0]![0].params.target).toBe(alpha);
});
it('recovers on the next fresh named request without persisting an invalid reference draft', async () => {
  plan([{ operation: 'task.update', contextRef: { source: 'working_memory', position: 3 }, clearFields: ['description'] }]);
  const result = await routeMessage('Clear number 3 description', user, []);
  expect(result.confirmation).toContain('displayed list');
  expect(createInputRun).not.toHaveBeenCalled();
  expect(createApprovalRun).not.toHaveBeenCalled();
  expect(executeTool).not.toHaveBeenCalled();
  plan([{ operation: 'task.update', target: 'Alpha', clearFields: ['description'] }]);
  untrustedResultMock(executeTool).mockResolvedValueOnce({ success: true, action: 'updated_task', data: { ...rows[1], description: null } });
  await routeMessage('Clear Alpha description', user, []);
  expect(executeTool).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ params: expect.objectContaining({ target: alpha }) }));
  expect(untrustedResultMock(callChatCompletion).mock.calls.map(call => call[1]!.purpose)).toEqual(['initial', 'initial']);
});
it.each(['provider_unavailable', 'schema_rejection', 'invalid_intent'])('preserves displayed references across %s without renewing TTL', async reason => {
  const timestamp = Date.now() - 60_000;
  saveWorkingMemory(user, { ...getWorkingMemory(user)! }, { restoredTimestamp: timestamp });
  const fail = () => reason === 'invalid_intent'
    ? untrustedResultMock(callChatCompletion).mockResolvedValueOnce({ content: JSON.stringify({ actions: [{ operation: 'task.bad' }] }) })
    : untrustedResultMock(callChatCompletion).mockResolvedValueOnce({ content: '', unavailable: true, unavailableReason: reason });
  fail();
  await routeMessage('Try again', user, []);
  fail();
  const failed = await routeMessage('Try again', user, []);
  expect(failed.entities!._workingMemory).toMatchObject({ source: 'task', activeEntity: 'Work', notificationReminderId: 'notification', notificationContent: 'Keep me', timestamp, infraFault: true });
  expect(getWorkingMemory(user)!.items.map(item => item.internalId)).toEqual([beta, alpha]);
  const prompt = formatWorkingMemoryPrompt(user);
  expect(prompt).toContain('position:2');
  expect(prompt).toContain('NO inventario vivo');
  expect(prompt).toContain('INCIDENCIA');
  expect(prompt).not.toMatch(/microcorte|falló debido a.*red/);
  plan([{ operation: 'task.update', contextRef: { source: 'working_memory', position: 2 }, clearFields: ['description'] }]);
  untrustedResultMock(executeTool).mockResolvedValueOnce({ success: true, action: 'updated_task', data: { ...rows[1], description: null } });
  await routeMessage('Clear number 2 description', user, []);
  expect((untrustedResultMock(executeTool).mock.calls[0]![0] as ToolOptions).params!.target).toBe(alpha);
  expect(createInputRun).not.toHaveBeenCalled();
  expect(createApprovalRun).not.toHaveBeenCalled();
  expect(getWorkingMemory(user)!.infraFault).toBeUndefined();
  expect(callChatCompletion).toHaveBeenCalledTimes(3);
});
it('retains a no-view failure marker and clears it on a valid reply', async () => {
  clearWorkingMemory(user);
  untrustedResultMock(callChatCompletion).mockRejectedValueOnce(new Error('offline provider error'));
  await routeMessage('Hello', user, []);
  expect(getWorkingMemory(user)!).toMatchObject({ source: 'system', lastAction: 'provider_failure', infraFault: true, items: [] });
  expect(formatWorkingMemoryPrompt(user)).toContain('INCIDENCIA');
  plan([{ operation: 'conversation.reply', content: 'Hello' }]);
  await routeMessage('Hello', user, []);
  expect(getWorkingMemory(user)!.infraFault).toBeUndefined();
});
it('does not resurrect older history behind invalid or explicit cleared latest snapshots', () => {
  const older = { ...getWorkingMemory(user)! };
  for (const latest of [null, { ...older, items: [], activeEntity: null }, { ...older, timestamp: Date.now() + 120_000 }, { ...older, timestamp: Date.now() - 3 * 60 * 60 * 1000 }]) {
    clearWorkingMemory(user);
    expect(hydrateWorkingMemoryFromHistory(user, [{ entities: { _workingMemory: older } }, { entities: { _workingMemory: latest } }])).toBeNull();
  }
});
it('accepts native empty refs for reply and mutation without changing data or granting authority', async () => {
  untrustedResultMock(callChatCompletion).mockResolvedValueOnce({ content: JSON.stringify({ responseCapability: 'general', responseLanguage: 'en', knowledgeRefs: [], actions: [{ operation: 'conversation.reply', content: 'Hello' }] }) });
  const before = getWorkingMemory(user)!;
  expect((await routeMessage('Hello', user, [])).confirmation).toBe('Hello');
  expect(getWorkingMemory(user)!).toEqual(before);
  untrustedResultMock(callChatCompletion).mockResolvedValueOnce({ content: JSON.stringify({ responseCapability: 'general', responseLanguage: 'en', knowledgeRefs: [], actions: [{ operation: 'task.update', contextRef: { source: 'working_memory', position: 2 }, clearFields: ['description'] }] }) });
  untrustedResultMock(executeTool).mockResolvedValueOnce({ success: true, action: 'updated_task', data: { ...rows[1], description: null } });
  await routeMessage('Clear number 2 description', user, []);
  expect((untrustedResultMock(executeTool).mock.calls[0]![0] as ToolOptions).params).toMatchObject({ target: alpha, updates: { description: null, append: false } });
  expect((untrustedResultMock(executeTool).mock.calls[0]![0] as ToolOptions).params).not.toHaveProperty('knowledgeRefs');
  expect(createInputRun).not.toHaveBeenCalled();
});
it('repeated failures cannot revive an expired view', async () => {
  saveWorkingMemory(user, getWorkingMemory(user)!, { restoredTimestamp: Date.now() - 3 * 60 * 60 * 1000 });
  untrustedResultMock(callChatCompletion).mockRejectedValueOnce(new Error('offline'));
  await routeMessage('Hello', user, []);
  expect(getWorkingMemory(user)!.items).toEqual([]);
});
it('keeps genuine missing-schedule drafts durable', async () => {
  await executeTurnIntent({ actions: [{ domain: 'reminder', action: 'create', content: 'Review', missingFields: ['schedule'] }] }, context);
  expect(createInputRun).toHaveBeenCalledWith(expect.objectContaining({ missingFields: ['schedule'], partialActions: [expect.objectContaining({ content: 'Review' })] }));
  expect(executeTool).not.toHaveBeenCalled();
});

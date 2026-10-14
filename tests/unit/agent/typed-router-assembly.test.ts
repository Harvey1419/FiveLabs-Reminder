import { describe, expect, it, vi } from 'vitest';
import { createRouterAssembly, type RouterAssemblyDependencies } from '../../../src/agent/orchestration/router-assembly.js';
import type { RouterPipelineFact } from '../../../src/agent/orchestration/router-pipeline.js';
import type { RouterContextMemory } from '../../../src/agent/orchestration/router-context-reads.js';
import type { PersonalKnowledgeFact } from '../../../src/agent/orchestration/personal-knowledge-core.js';
import type { LegacyAgentRunWithActions } from '../../../src/agent/core/active-run-lifecycle.js';
interface Fact extends RouterPipelineFact { marker: string }
interface Memory extends RouterContextMemory {}
type Lookup = Map<string, PersonalKnowledgeFact>;
type Knowledge = { refs: Map<Memory, string>; lookup: Lookup };
type Overview = { pendingConfirmationReminders: never[] };
type Dependencies = RouterAssemblyDependencies<Fact, Memory, Lookup, null, Overview, { status: string }, null, Knowledge, []>;
const user = () => ({ id: 'owner', phone_number: 'phone', timezone: 'UTC', locale: 'es-CO' });
const operation = { actions: [{ domain: 'task', action: 'complete', target: 'Task' }], excluded: [], responseCapability: 'general' };
function fixture() {
  const fact: Fact = { marker: 'domain', tool: 'manage_task', requestedAction: 'complete', success: true, complete: true, card: 'Observed card' };
  const compose = vi.fn((facts: readonly Fact[] | undefined) => (facts || []).map(fact => fact.marker === 'profile' ? 'Saved profile' : 'Observed card').join('\n'));
  const deps: Dependencies = {
    initialization: { profileDependencies: { extractCurrentUserText: (text, supplied) => String(supplied ?? text ?? ''), detectLanguageFromText: () => 'es', explicitEnglishDirective: /english/i, explicitSpanishDirective: /español/i, assertTurnLease: vi.fn(async () => {}), updateUserPreferences: vi.fn(async () => ({ timezone: 'America/Bogota' })), createExecutionFact: vi.fn(() => ({ marker: 'profile', success: true, complete: true, tool: 'profile' })) }, isAdminUser: () => false, computeOffsetMinutes: () => {}, nowISO: () => 'ISO', nowHuman: () => 'Human', hydrateClarificationStateFromHistory: vi.fn(), hydrateWorkingMemoryFromHistory: vi.fn(), now: () => 100, logger: { log: vi.fn() } },
    lifecycle: { getClarificationStateSnapshot: vi.fn(() => ({ version: 3 })), getWorkingMemorySnapshot: vi.fn(() => null), carryCreationReceiptEvents: vi.fn(() => []), carryOperationalEvidence: vi.fn((_history, facts, owner) => ({ owner, markers: facts.map((fact: Fact) => fact.marker) })), composeExecutionReply: compose },
    observedReply: { answerFromTaskReturnFields: vi.fn(() => null), answerFromObservedReads: vi.fn(async () => null), renderHistoricalEvidence: () => '', historicalRecap: () => '', callResponseSynthesis: vi.fn(async () => null), renderPersonalKnowledge: () => '', resolveNextBestAction: vi.fn(async () => null), composeExecutionReply: compose, historicalMutationReceipts: () => [], receiptBlock: () => '', sanitizeResponseText: value => value, now: () => 100 },
    execution: { executeTurnIntent: vi.fn(async () => ({ records: [{ toolName: 'manage_task', params: { action: 'complete' }, result: { success: true, action: 'completed_task' } }], facts: [fact] })), inferIntentFromTool: () => 'task', mutationReceiptsFromFacts: () => [], now: () => 100, logger: { log: vi.fn() } },
    actions: { normalizeTurnIntentForRuntime: vi.fn(intent => intent), renderOperationalEvidence: () => '', renderHistoricalEvidence: () => '', renderPersonalKnowledge: () => '', getGoogleConnectUrl: () => 'https://example.test/auth', now: () => 100, logger: { log: vi.fn(), warn: vi.fn() } },
    foreground: { operationalEvidenceFromHistory: () => [], callChatCompletion: vi.fn(async () => ({ structuredIntent: operation })), getWorkingMemory: () => null, saveWorkingMemory: vi.fn(), now: () => 100, logger: { log: vi.fn(), warn: vi.fn() } },
    activeRun: { getActiveAgentRun: vi.fn(async () => null), formatActiveRunPrompt: () => 'Pending', callChatCompletion: vi.fn(async () => ({ content: '{}' })), executeApprovalDecision: vi.fn(async () => ({ facts: [fact], success: true, executed: true, status: 'completed' })), executeContinuationDecision: vi.fn(async () => ({ facts: [fact], success: true, executed: true, status: 'completed' })), updateAgentRunIfStatusFromDb: vi.fn(async () => true), composeExecutionReply: compose, mutationReceiptsFromFacts: () => [], logger: { warn: vi.fn() } },
    prompt: { shouldEnforceBillingForUser: () => false, selectReminderProProvider: () => null, getBillingProvider: () => undefined, buildAgentCorePrompt: vi.fn(() => 'Prompt') },
    context: { getMemoryServiceMethod: () => undefined, retrieveRelevantMemories: vi.fn(async () => []), retrieveStandingPreferences: vi.fn(async () => []), getDailyOverview: vi.fn(async () => ({ pendingConfirmationReminders: [] })), getUserSubscription: vi.fn(async () => ({ status: 'active' })), getUserIntegration: vi.fn(async () => null), hasProAccess: () => true, buildPersonalKnowledge: () => ({ refs: new Map(), lookup: new Map() }), now: () => 100, logger: { warn: vi.fn() } },
    workingMemory: { getWorkingMemory: () => null, freezeTaskReferenceSnapshot: () => null, formatWorkingMemoryPrompt: () => '' }, logger: { log: vi.fn() },
  };
  return { deps, fact, compose, ...createRouterAssembly(deps) };
}
describe('typed assembly with actual router stages', () => {
  it('constructs without invoking host ports and connects observed execution through lifecycle-owned carry', async () => {
    const f = fixture(); expect(f.deps.foreground.callChatCompletion).not.toHaveBeenCalled(); expect(f.deps.context.getDailyOverview).not.toHaveBeenCalled(); expect(f.deps.execution.executeTurnIntent).not.toHaveBeenCalled();
    const result = await f.routeMessage('Complete Task', user(), [], { requestTimeMs: 100 });
    expect(result).toMatchObject({ intent: 'task', confirmation: 'Observed card', executionFacts: [f.fact], entities: { _turnMetadata: { operationalEvidence: { owner: 'owner', markers: ['domain'] } } } });
    expect(Object.getOwnPropertySymbols(result.entities)).toHaveLength(0);
    expect(f.deps.execution.executeTurnIntent).toHaveBeenCalledTimes(1); expect(f.deps.lifecycle.carryOperationalEvidence).toHaveBeenCalledTimes(1);
  });
  it('stops conversational turns before execution while retaining lifecycle snapshots', async () => {
    const f = fixture(); vi.mocked(f.deps.foreground.callChatCompletion).mockResolvedValue({ structuredIntent: { actions: [{ domain: 'conversation', action: 'reply', content: 'Hola' }], excluded: [], responseCapability: 'general' } });
    const result = await f.routeMessage('Hola', user()); expect(result).toMatchObject({ intent: 'chat', confirmation: 'Hola', entities: { _conversationState: { version: 3 } } }); expect(f.deps.execution.executeTurnIntent).not.toHaveBeenCalled();
  });
  it('keeps provider rejection inside the owned lifecycle and never invokes normalization or execution', async () => {
    const f = fixture(); vi.mocked(f.deps.foreground.callChatCompletion).mockResolvedValue({ unavailable: true });
    expect(await f.routeMessage('Complete Task', user())).toMatchObject({ intent: 'clarification', memoryDisposition: 'skip_operational' });
    expect(f.deps.actions.normalizeTurnIntentForRuntime).not.toHaveBeenCalled(); expect(f.deps.execution.executeTurnIntent).not.toHaveBeenCalled();
  });
  it('uses the same-turn profile context for execution and prepends its receipt after domain evidence carry', async () => {
    const f = fixture(); const currentUser = user(); const text = 'Use America/Bogota as my timezone';
    vi.mocked(f.deps.foreground.callChatCompletion).mockResolvedValue({ structuredIntent: { ...operation, profileUpdate: { sourceQuote: text, timezone: 'America/Bogota' } } });
    const result = await f.routeMessage(text, currentUser);
    expect(f.deps.initialization.profileDependencies.assertTurnLease).toHaveBeenCalledTimes(1);
    expect(f.deps.execution.executeTurnIntent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ timezone: 'America/Bogota', user: currentUser }));
    expect(result).toMatchObject({ confirmation: 'Saved profile\n\nObserved card', executionFacts: [expect.objectContaining({ marker: 'profile' }), f.fact] });
    expect(f.deps.lifecycle.carryOperationalEvidence).toHaveBeenCalledWith(expect.anything(), [f.fact], 'owner', undefined);
  });
  it('blocks domain execution when profile persistence is unconfirmed and propagates a lost lease', async () => {
    const f = fixture(); const text = 'Use America/Bogota as my timezone'; vi.mocked(f.deps.foreground.callChatCompletion).mockResolvedValue({ structuredIntent: { ...operation, profileUpdate: { sourceQuote: text, timezone: 'America/Bogota' } } });
    vi.mocked(f.deps.initialization.profileDependencies.updateUserPreferences).mockRejectedValue(new Error('unconfirmed'));
    expect(await f.routeMessage(text, user())).toMatchObject({ intent: 'clarification' }); expect(f.deps.execution.executeTurnIntent).not.toHaveBeenCalled();
    vi.mocked(f.deps.initialization.profileDependencies.assertTurnLease).mockRejectedValue(new Error('lease lost'));
    await expect(f.routeMessage(text, user())).rejects.toThrow('lease lost'); expect(f.deps.execution.executeTurnIntent).not.toHaveBeenCalled();
  });
  it('short-circuits a running pending operation before another foreground decision', async () => {
    const f = fixture(); const run: LegacyAgentRunWithActions = { id: 'run', user_id: 'owner', thread_id: 'thread', kind: 'task_mutation', status: 'running', context: {}, waiting_for: null, expires_at: '2035-10-13T12:00:00Z', preparedActions: [] };
    vi.mocked(f.deps.activeRun.getActiveAgentRun).mockResolvedValue(run);
    expect(await f.routeMessage('Continue', user())).toMatchObject({ intent: 'clarification' }); expect(f.deps.foreground.callChatCompletion).not.toHaveBeenCalled(); expect(f.deps.execution.executeTurnIntent).not.toHaveBeenCalled();
  });
  it('propagates uncertain execution without reply composition, historical carry or retry', async () => {
    const f = fixture(); vi.mocked(f.deps.execution.executeTurnIntent).mockRejectedValue(new Error('outcome unknown'));
    await expect(f.routeMessage('Complete Task', user())).rejects.toThrow('outcome unknown'); expect(f.deps.execution.executeTurnIntent).toHaveBeenCalledTimes(1); expect(f.compose).not.toHaveBeenCalled(); expect(f.deps.lifecycle.carryOperationalEvidence).not.toHaveBeenCalled();
  });
});

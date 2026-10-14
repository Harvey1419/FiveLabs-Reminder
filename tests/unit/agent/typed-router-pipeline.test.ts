import { describe, expect, it, vi } from 'vitest';
import { createRouterPipeline, type RouterPipelineDependencies, type RouterPipelineFact } from '../../../src/agent/orchestration/router-pipeline.js';
import { createRouterTurnInitialization } from '../../../src/agent/orchestration/router-turn-initialization.js';
import type { RouterLifecycleEntities } from '../../../src/agent/orchestration/router-turn-lifecycle.js';
import type { RouterContextMemory } from '../../../src/agent/orchestration/router-context-reads.js';
import type { PromptOverview } from '../../../src/agent/core/agent-prompt.js';
type Fact = RouterPipelineFact & { id: string }; type Lookup = Map<string, unknown>; type Memory = RouterContextMemory;
type Snapshot = { frozen: boolean }; type Overview = PromptOverview; type Knowledge = { refs: Map<Memory, string>; lookup: Lookup };
type Dependencies = RouterPipelineDependencies<Fact, RouterLifecycleEntities, Memory, Lookup, Snapshot, Overview, null, null, Knowledge, string[]>;
function fixture() {
  const events: string[] = [], lookup: Lookup = new Map(), snapshot: Snapshot = { frozen: true }, overview: Overview = { pendingConfirmationReminders: [] };
  const initial = createRouterTurnInitialization<Fact>({ profileDependencies: { extractCurrentUserText: (_model, authored) => typeof authored === 'string' ? authored : 'Current', detectLanguageFromText: () => 'es', explicitEnglishDirective: /english/i, explicitSpanishDirective: /español/i, assertTurnLease: async () => {}, updateUserPreferences: async () => ({ timezone: 'America/Bogota' }), createExecutionFact: () => ({ id: 'profile' }) }, isAdminUser: () => false, computeOffsetMinutes: () => {}, nowISO: () => 'ISO', nowHuman: () => 'Human', hydrateClarificationStateFromHistory: () => {}, hydrateWorkingMemoryFromHistory: () => {}, now: () => 100, logger: { log: () => {} } });
  const reply = { intent: 'clarification' as const, language: 'es', executionFacts: [] as [] };
  const deps: Dependencies = {
    initializeRouterTurn: vi.fn<Dependencies['initializeRouterTurn']>((...args) => { events.push('initialize'); return initial.initializeRouterTurn(...args); }),
    loadRouterContext: vi.fn<Dependencies['loadRouterContext']>(async () => { events.push('context'); return { relevantMemories: [], standingPreferences: [], proactiveAnchors: [], dailyOverview: overview, subscription: null, googleIntegration: null, memoryRetrievalStatus: 'available', contextElapsedMs: 1, entitlementKnown: true, isPro: false, effectiveMemories: [], personalKnowledge: { refs: new Map<Memory, string>(), lookup }, memoryHints: '', preferenceHints: '' }; }),
    getWorkingMemory: vi.fn<Dependencies['getWorkingMemory']>(() => { events.push('memory'); return null; }), freezeTaskReferenceSnapshot: vi.fn<Dependencies['freezeTaskReferenceSnapshot']>(() => { events.push('snapshot'); return snapshot; }), formatWorkingMemoryPrompt: vi.fn<Dependencies['formatWorkingMemoryPrompt']>(() => { events.push('memory-prompt'); return ''; }),
    prepareRouterPrompt: vi.fn<Dependencies['prepareRouterPrompt']>(() => { events.push('prompt'); return { rawPastTurns: [], pastTurns: [], latestAssistantMessage: 'Previous', historyChars: 0, proGuidance: null, prompt: 'Prompt', messages: [{ role: 'system', content: 'Prompt' }] }; }),
    resolveRouterActiveRun: vi.fn<Dependencies['resolveRouterActiveRun']>(async () => { events.push('pending'); return { handled: false, supersedesRunId: null, preserveExistingActiveRun: false }; }),
    decideRouterForeground: vi.fn<Dependencies['decideRouterForeground']>(async () => { events.push('foreground'); return { accepted: true, intent: { actions: [{ domain: 'task', action: 'list' }], excluded: [] }, hasHistoricalEvidence: false, modelElapsedMs: 2 }; }),
    prepareRouterActions: vi.fn<Dependencies['prepareRouterActions']>(async () => { events.push('prepare'); return { handled: false, runtimeIntent: { actions: [{ domain: 'task', action: 'list' }], excluded: [] }, learningMetadata: {}, operationalActions: [{ domain: 'task', action: 'list' }], recap: undefined, conversationReply: 'Planned text' }; }),
    executeRouterActions: vi.fn<Dependencies['executeRouterActions']>(async () => { events.push('execute'); return { execution: { records: [], facts: [{ id: 'observed' }], excluded: [] }, toolElapsedMs: 3 }; }),
    composeRouterObservedReply: vi.fn<Dependencies['composeRouterObservedReply']>(async () => { events.push('compose'); return { finalReply: 'Observed card', interpretationOutcome: 'partial', modelElapsedMs: 5 }; }),
    projectRouterResult: vi.fn<Dependencies['projectRouterResult']>(input => { events.push('project'); return { intent: 'task', entities: {}, language: input.language, confirmation: input.finalReply, ctaUrl: null, ctaHeader: null, ctaButtonText: null, flow: null, buttons: null, list: null, plan: { type: 'turn_intent', actions: [] }, executionFacts: input.execution.facts, memoryDisposition: 'skip_operational' }; }), logger: { log: vi.fn() },
  };
  return { deps, events, reply, snapshot, lookup, overview, ...createRouterPipeline(deps) };
}
describe('typed central router pipeline', () => {
  it('runs phases in order and freezes references before any model or tool stage', async () => {
    const f = fixture(); expect(await f.routeMessageInternal('Current', { id: 'owner', timezone: 'UTC' })).toMatchObject({ confirmation: 'Observed card' });
    expect(f.events).toEqual(['initialize', 'context', 'memory', 'snapshot', 'memory-prompt', 'prompt', 'pending', 'foreground', 'prepare', 'execute', 'compose', 'project']);
    expect(f.deps.composeRouterObservedReply).toHaveBeenCalledWith(expect.objectContaining({ referenceSnapshot: f.snapshot, personalKnowledge: expect.objectContaining({ lookup: f.lookup }), dailyOverview: f.overview }));
  });
  it('returns a pending-run response by identity and never enters a normal decision or execution', async () => {
    const f = fixture(); vi.mocked(f.deps.resolveRouterActiveRun).mockResolvedValue({ handled: true, response: f.reply });
    expect(await f.routeMessageInternal('Current', 'phone')).toBe(f.reply); expect(f.deps.decideRouterForeground).not.toHaveBeenCalled(); expect(f.deps.executeRouterActions).not.toHaveBeenCalled();
  });
  it('stops on rejected foreground admission before preparation or execution', async () => {
    const f = fixture(); const response = { ...f.reply, entities: {}, confirmation: 'Unavailable', ctaUrl: null, ctaHeader: null, ctaButtonText: null, plan: { type: 'provider_unavailable' }, executionFacts: [] as [], memoryDisposition: 'skip_operational' as const };
    vi.mocked(f.deps.decideRouterForeground).mockResolvedValue({ accepted: false, response }); expect(await f.routeMessageInternal('Current', 'phone')).toBe(response); expect(f.deps.prepareRouterActions).not.toHaveBeenCalled(); expect(f.deps.executeRouterActions).not.toHaveBeenCalled();
  });
  it('returns conversation/profile-failure preparation without executing or recomposing it', async () => {
    const f = fixture(); vi.mocked(f.deps.prepareRouterActions).mockResolvedValue({ handled: true, response: f.reply });
    expect(await f.routeMessageInternal('Current', 'phone')).toBe(f.reply); expect(f.deps.executeRouterActions).not.toHaveBeenCalled(); expect(f.deps.composeRouterObservedReply).not.toHaveBeenCalled();
  });
  it('propagates suspended replacement controls and the latest assistant context into execution', async () => {
    const f = fixture(); vi.mocked(f.deps.resolveRouterActiveRun).mockResolvedValue({ handled: false, supersedesRunId: 'pending', preserveExistingActiveRun: true });
    const options = { correlationId: 'request' }; await f.routeMessageInternal('Current', { id: 'owner' }, [], options);
    expect(f.deps.executeRouterActions).toHaveBeenCalledWith(expect.objectContaining({ supersedesRunId: 'pending', preserveExistingActiveRun: true, latestAssistantMessage: 'Previous', options }));
  });
  it('synchronizes same-turn language and timezone after applying a validated context decision', async () => {
    const f = fixture(); const user = { id: 'owner', timezone: 'UTC', locale: 'es-CO' }, effects: Fact[] = [];
    vi.mocked(f.deps.prepareRouterActions).mockImplementation(async input => { expect(await input.applyDecisionContext({ responseLanguage: 'en', profileUpdate: { sourceQuote: 'Current', timezone: 'America/Bogota' } })).toBe(true); return { handled: false, runtimeIntent: { actions: [{ domain: 'task', action: 'list' }], excluded: [] }, operationalActions: [{ domain: 'task', action: 'list' }], learningMetadata: {}, recap: undefined, conversationReply: '' }; });
    await f.routeMessageInternal('Current inglés', user, [], {}, effects); expect(f.deps.executeRouterActions).toHaveBeenCalledWith(expect.objectContaining({ language: 'en', timezone: 'America/Bogota', user })); expect(effects).toEqual([{ id: 'profile' }]);
  });
  it('passes current profile language onward after a pending decision changes the conversation context', async () => {
    const f = fixture(); vi.mocked(f.deps.resolveRouterActiveRun).mockImplementation(async input => { expect(input.language).toBe('es'); await input.applyDecisionContext({ responseLanguage: 'en' }); return { handled: false, supersedesRunId: null, preserveExistingActiveRun: true }; });
    await f.routeMessageInternal('Current inglés', { id: 'owner', locale: 'es-CO' }); expect(f.deps.decideRouterForeground).toHaveBeenCalledWith(expect.objectContaining({ language: 'en' }));
  });
  it.each(['context', 'pending', 'foreground', 'prepare', 'execute', 'compose'])('propagates %s failure without retrying or running later stages', async stage => {
    const f = fixture(), error = new Error('Stage failed'); const methods = { context: f.deps.loadRouterContext, pending: f.deps.resolveRouterActiveRun, foreground: f.deps.decideRouterForeground, prepare: f.deps.prepareRouterActions, execute: f.deps.executeRouterActions, compose: f.deps.composeRouterObservedReply };
    vi.mocked(methods[stage as keyof typeof methods]).mockRejectedValue(error); await expect(f.routeMessageInternal('Current', 'phone')).rejects.toBe(error); expect(methods[stage as keyof typeof methods]).toHaveBeenCalledTimes(1); expect(f.deps.projectRouterResult).not.toHaveBeenCalled();
  });
  it('projects the observed interpretation and updated model duration without using planned prose', async () => {
    const f = fixture(); await f.routeMessageInternal('Current', 'phone'); expect(f.deps.projectRouterResult).toHaveBeenCalledWith(expect.objectContaining({ finalReply: 'Observed card', interpretationOutcome: 'partial', modelElapsedMs: 5, toolElapsedMs: 3 }));
  });
});

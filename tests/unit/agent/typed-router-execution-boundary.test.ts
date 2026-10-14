import { describe, expect, it, vi } from 'vitest';
import { createRouterExecutionBoundary, type RouterExecutionDependencies, type RouterExecutionInput, type RouterObservedPresentation, type RouterObservedExecution, type RouterResultInput } from '../../../src/agent/orchestration/router-execution-boundary.js';
interface Fact extends RouterObservedPresentation { id: string }
function fixture() {
  let ticks = 10;
  const execution: RouterObservedExecution<Fact> = { records: [{ toolName: 'manage_task', params: { target: 'Task' }, result: { success: true, action: 'complete' } }], facts: [{ id: 'observed' }], excluded: [], memoryProcessed: false };
  const deps: RouterExecutionDependencies<Fact, Record<string, unknown>> = { executeTurnIntent: vi.fn(async () => execution), inferIntentFromTool: vi.fn(tool => tool === 'manage_task' ? 'task' : 'chat'), mutationReceiptsFromFacts: vi.fn((facts: Fact[]) => facts.map(f => f.id)), conversationStateEntities: vi.fn((user, extra) => ({ localOwner: user.id, ...extra })), now: () => ticks++, logger: { log: vi.fn() } };
  const input: RouterExecutionInput = { runtimeIntent: { actions: [{ domain: 'conversation', action: 'reply', content: 'Planned prose' }, { domain: 'task', action: 'list', returnFields: ['title'] }], excluded: [] }, operationalActions: [{ domain: 'task', action: 'list', returnFields: ['title'] }], user: { id: 'owner' }, isPro: false, language: 'en', currentUserText: 'Current request', requestReferenceTime: new Date('2027-01-14T12:00:00Z'), timezone: 'UTC', options: { correlationId: 'correlation' }, latestAssistantMessage: 'Previous', supersedesRunId: 'pending', preserveExistingActiveRun: true, requestId: 'request' };
  const resultInput: RouterResultInput<Fact> = { execution, runtimeIntent: input.runtimeIntent, learningMetadata: { learningCandidatesProvided: true, learningCandidates: [] }, user: input.user, language: 'en', finalReply: 'Observed card', requestId: 'request', startMs: 0, contextElapsedMs: 1, modelElapsedMs: 2, toolElapsedMs: 3 };
  return { execution, deps, input, resultInput, ...createRouterExecutionBoundary(deps) };
}
describe('typed execution handoff and result projection', () => {
  it('executes only prepared operational actions with the exact current context and suspension controls', async () => {
    const f = fixture(); const result = await f.executeRouterActions(f.input);
    expect(result.execution).toBe(f.execution); expect(result.toolElapsedMs).toBe(1); expect(f.deps.executeTurnIntent).toHaveBeenCalledTimes(1);
    expect(f.deps.executeTurnIntent).toHaveBeenCalledWith({ ...f.input.runtimeIntent, actions: f.input.operationalActions }, { user: f.input.user, isPro: false, language: 'en', userMessage: 'Current request', referenceTime: f.input.requestReferenceTime, timezone: 'UTC', correlationId: 'correlation', latestAssistantMessage: 'Previous', supersedesRunId: 'pending', preserveExistingActiveRun: true, preserveDisplayedReferences: true });
  });
  it.each(['recap', 'mixed', 'no-fields'])('preserves numbered references for %s execution', async mode => {
    const f = fixture(); if (mode === 'recap') f.input.recap = { domain: 'conversation', action: 'recap' };
    if (mode === 'mixed') f.input.operationalActions.push({ domain: 'reminder', action: 'list' });
    if (mode === 'no-fields') f.input.operationalActions = [{ domain: 'task', action: 'list' }];
    await f.executeRouterActions(f.input); expect(vi.mocked(f.deps.executeTurnIntent).mock.calls[0]![1].preserveDisplayedReferences).toBe(false);
  });
  it('propagates uncertain execution errors without retrying or projecting a success', async () => {
    const f = fixture(); vi.mocked(f.deps.executeTurnIntent).mockRejectedValue(new Error('write outcome unknown'));
    await expect(f.executeRouterActions(f.input)).rejects.toThrow('write outcome unknown'); expect(f.deps.executeTurnIntent).toHaveBeenCalledTimes(1); expect(f.deps.mutationReceiptsFromFacts).not.toHaveBeenCalled();
  });
  it('keeps observed fact identity, rendered confirmation and owner-bound host metadata', () => {
    const f = fixture(); f.resultInput.interpretationOutcome = { status: 'partial' }; const result = f.projectRouterResult(f.resultInput);
    expect(result.executionFacts).toBe(f.execution.facts); expect(result.confirmation).toBe('Observed card'); expect(result.confirmation).not.toContain('Planned prose');
    expect(result.entities).toMatchObject({ localOwner: 'owner', target: 'Task', _turnMetadata: { kind: 'operational_result', mutationReceipts: ['observed'], interpretationOutcome: { status: 'partial' } } });
    expect(result).toMatchObject({ intent: 'task', learningCandidatesProvided: true, learningCandidates: [], memoryDisposition: 'skip_operational' });
    expect(f.deps.executeTurnIntent).not.toHaveBeenCalled();
  });
  it('prefers observed fact CTA fields before the first actionable raw result', () => {
    const f = fixture(); f.execution.facts[0] = { id: 'observed', ctaUrl: 'https://example.test/fact', ctaHeader: 'Fact header' }; f.execution.records[0]!.result = { ctaUrl: 'https://example.test/raw', ctaButtonText: 'Raw button', data: { auth_url: 'https://example.test/auth', checkout_url: 'https://example.test/checkout' } };
    expect(f.projectRouterResult(f.resultInput)).toMatchObject({ ctaUrl: 'https://example.test/fact', ctaHeader: 'Fact header', ctaButtonText: 'Raw button' });
  });
  it.each(['auth_url', 'checkout_url'])('retains observed raw data CTA fallback %s', key => {
    const f = fixture(); f.execution.records[0]!.result = { data: { [key]: 'https://example.test/observed' } };
    expect(f.projectRouterResult(f.resultInput).ctaUrl).toBe('https://example.test/observed');
  });
  it('selects flow, nonempty buttons and section-bearing lists independently and retains their identities', () => {
    const f = fixture(); const flow = { token: 'observed-flow' }, buttons = [{ id: 'observed-button' }], list = { sections: [{ title: 'Observed' }] };
    f.execution.facts = [{ id: 'empty', buttons: [], list: {} }, { id: 'ui', flow, buttons, list }];
    f.execution.records[0]!.result = { flow: 'raw', buttons: ['raw'], list: { sections: ['raw'] } };
    const result = f.projectRouterResult(f.resultInput); expect(result.flow).toBe(flow); expect(result.buttons).toBe(buttons); expect(result.list).toBe(list);
  });
  it('falls back to observed raw UI outputs and returns null when no actionable metadata is present', () => {
    const f = fixture(); const raw = { flow: { id: 'raw' }, buttons: ['raw'], list: { sections: ['raw'] } }; f.execution.records[0]!.result = raw;
    expect(f.projectRouterResult(f.resultInput)).toMatchObject(raw); f.execution.records = []; f.execution.facts = [];
    expect(f.projectRouterResult(f.resultInput)).toMatchObject({ intent: 'chat', ctaUrl: null, ctaHeader: null, ctaButtonText: null, flow: null, buttons: null, list: null });
    expect(f.deps.inferIntentFromTool).toHaveBeenLastCalledWith(undefined);
  });
  it('ignores non-object primary params and omits absent interpretation metadata', () => {
    const f = fixture(); f.execution.records[0]!.params = ['untrusted-array']; const result = f.projectRouterResult(f.resultInput);
    expect(result.entities).not.toHaveProperty('0'); expect(result.entities._turnMetadata).not.toHaveProperty('interpretationOutcome');
  });
  it('marks memory processed only from the executor result and never mutates the supplied arrays', () => {
    const f = fixture(); f.execution.memoryProcessed = true; const before = structuredClone(f.execution);
    expect(f.projectRouterResult(f.resultInput).memoryDisposition).toBe('processed'); expect(f.execution).toEqual(before);
  });
});

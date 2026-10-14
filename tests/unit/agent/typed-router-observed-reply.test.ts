import { describe, expect, it, vi } from 'vitest';
import { createRouterObservedReply, type RouterReplyDependencies, type RouterReplyInput, type RouterReplyFact, type ReplyFraming } from '../../../src/agent/orchestration/router-observed-reply.js';
import { TASK_CARD_COVERAGE } from '../../../src/agent/core/execution-presentation.js';
interface Fact extends RouterReplyFact { id: string; tool: string; card?: string }
type Lookup = Map<string, unknown>;
function fixture() {
  let ticks = 10;
  const fact: Fact = { id: 'observed', tool: 'manage_task', success: true, complete: true, requestedAction: 'complete', card: 'Observed card' };
  const input: RouterReplyInput<Fact, Lookup, { frozen: boolean }, { notices: string[] }> = { execution: { records: [], facts: [fact], excluded: [] }, runtimeIntent: { actions: [{ domain: 'task', action: 'complete', target: 'Task' }], excluded: [] }, operationalActions: [{ domain: 'task', action: 'complete', target: 'Task' }], conversationReply: 'Planned success text', language: 'en', rawPastTurns: [], currentUserText: 'Current request', user: { id: 'owner' }, personalKnowledge: { lookup: new Map() }, referenceSnapshot: { frozen: true }, options: { correlationId: 'correlation' }, modelElapsedMs: 30, requestId: 'request', dailyOverview: { notices: [] }, requestReferenceTime: new Date('2027-01-14T12:00:00Z'), timezone: 'UTC', phoneNumber: 'phone' };
  const deps: RouterReplyDependencies<Fact, Lookup, { frozen: boolean }, { notices: string[] }, string[]> = {
    answerFromTaskReturnFields: vi.fn(() => null), answerFromObservedReads: vi.fn(async () => null), renderHistoricalEvidence: vi.fn(() => 'Historical observations'), historicalRecap: vi.fn(() => 'Historical recap'), callResponseSynthesis: vi.fn(async () => null), renderPersonalKnowledge: vi.fn(() => ''), resolveNextBestAction: vi.fn(async () => null),
    composeExecutionReply: vi.fn((facts: Fact[], _language: string, options?: { framing: ReplyFraming | null }) => [options?.framing?.before, ...facts.map(f => f.card || f.id), options?.framing?.after].filter(Boolean).join('\n\n')),
    historicalMutationReceipts: vi.fn(() => ['old receipt']), receiptBlock: vi.fn(() => 'Previous confirmed operation'), replaceTrustedLinkPlaceholders: vi.fn(async input => input.text || ''), sanitizeResponseText: vi.fn(text => text), now: () => ticks++,
  };
  return { input, deps, fact, ...createRouterObservedReply(deps) };
}
describe('typed observed-result composition', () => {
  it('uses observed cards rather than planned operational success prose', async () => {
    const f = fixture(); expect(await f.composeRouterObservedReply(f.input)).toEqual({ finalReply: 'Observed card', interpretationOutcome: undefined, modelElapsedMs: 30 });
    expect(f.deps.composeExecutionReply).toHaveBeenCalledWith(f.input.execution.facts, 'en', { framing: null });
  });
  it('replaces a single simple read card with its verified field answer and skips interpretation', async () => {
    const f = fixture(); f.input.operationalActions = [{ domain: 'task', action: 'list', returnFields: ['status'] }]; f.fact.requestedAction = 'list'; f.input.runtimeIntent.answerFromResults = true; vi.mocked(f.deps.answerFromTaskReturnFields).mockReturnValue('Verified task status');
    expect((await f.composeRouterObservedReply(f.input)).finalReply).toBe('Verified task status'); expect(f.deps.answerFromObservedReads).not.toHaveBeenCalled(); expect(f.deps.resolveNextBestAction).not.toHaveBeenCalled();
  });
  it('keeps mixed-read cards and preserves the frozen snapshot during interpretation', async () => {
    const f = fixture(); f.input.operationalActions = [{ domain: 'task', action: 'list', returnFields: ['status'] }, { domain: 'reminder', action: 'list' }]; f.input.runtimeIntent.answerFromResults = true; f.fact.requestedAction = 'list';
    vi.mocked(f.deps.answerFromObservedReads).mockResolvedValue('Observed read answer'); expect((await f.composeRouterObservedReply(f.input)).finalReply).toBe('Observed read answer\n\nObserved card');
    expect(f.deps.answerFromTaskReturnFields).not.toHaveBeenCalled(); expect(f.deps.answerFromObservedReads).toHaveBeenCalledWith(expect.objectContaining({ facts: f.input.execution.facts, referenceSnapshot: f.input.referenceSnapshot, userId: 'owner' }));
  });
  it('bounds carried coverage to twelve facts and one hundred task entries with exact call IDs', async () => {
    const f = fixture(); f.input.operationalActions = [{ domain: 'task', action: 'list' }]; f.input.runtimeIntent.answerFromResults = true;
    f.input.execution.facts = Array.from({ length: 13 }, (_, i) => ({ ...f.fact, callId: `call-${i}`, requestedAction: 'list', [TASK_CARD_COVERAGE]: Array.from({ length: 12 }, (_, j) => ({ itemId: `item-${i}-${j}`, fields: ['title'] })) }));
    await f.composeRouterObservedReply(f.input); const arg = vi.mocked(f.deps.answerFromObservedReads).mock.calls[0]![0]; expect(arg.retainedTaskCoverage).toHaveLength(100); expect(arg.retainedTaskCoverage[0]).toEqual({ callId: 'call-0', itemId: 'item-0-0', fields: ['title'] }); expect(arg.retainedTaskCoverage.some(x => x.callId === 'call-12')).toBe(false);
  });
  it('merges callback personal refs uniquely up to eight and retains interpretation outcome', async () => {
    const f = fixture(); f.input.operationalActions = [{ domain: 'task', action: 'list' }]; f.input.runtimeIntent.answerFromResults = true; f.input.runtimeIntent.knowledgeRefs = ['existing'];
    vi.mocked(f.deps.answerFromObservedReads).mockImplementation(async arg => { arg.onKnowledgeRefs(['existing', ...Array.from({ length: 12 }, (_, i) => `ref-${i}`)]); arg.onInterpretationOutcome('reference_unresolved'); return null; });
    expect(await f.composeRouterObservedReply(f.input)).toMatchObject({ interpretationOutcome: 'reference_unresolved' }); const refs = vi.mocked(f.deps.renderPersonalKnowledge).mock.calls[0]![0]; expect(refs).toEqual(['existing', ...Array.from({ length: 7 }, (_, i) => `ref-${i}`)]); expect(f.deps.resolveNextBestAction).not.toHaveBeenCalled();
  });
  it('retains the complete subscription card beside ordinary read cards and excludes it from read interpretation', async () => {
    const f = fixture(); const subscription: Fact = { id: 'subscription', tool: 'manage_subscription', requestedAction: 'info', success: true, complete: true, card: 'Canonical plan card', presentationData: { benefits: [], hasProAccess: false } };
    f.input.execution.facts.push(subscription); f.fact.requestedAction = 'list'; f.input.operationalActions = [{ domain: 'task', action: 'list' }, { domain: 'subscription', action: 'info' }]; f.input.runtimeIntent.answerFromResults = true;
    vi.mocked(f.deps.answerFromObservedReads).mockResolvedValue('Read answer'); expect((await f.composeRouterObservedReply(f.input)).finalReply).toBe('Read answer\n\nObserved card\n\nCanonical plan card'); expect(vi.mocked(f.deps.answerFromObservedReads).mock.calls[0]![0].facts).toEqual([f.fact]); expect(f.deps.callResponseSynthesis).not.toHaveBeenCalled();
  });
  it.each(['https://example.test', '[checkout_url]', '[auth_url]'])('does not use linked plan prose %s around observed subscription cards', async prose => {
    const f = fixture(); f.fact.tool = 'manage_subscription'; f.fact.requestedAction = 'info'; f.fact.presentationData = { benefits: [], hasProAccess: true }; f.input.operationalActions = [{ domain: 'subscription', action: 'info' }]; f.input.conversationReply = prose;
    expect((await f.composeRouterObservedReply(f.input)).finalReply).toBe('Observed card');
  });
  it('allows link-free plan framing only after complete observed entitlement', async () => {
    const f = fixture(); f.fact.tool = 'manage_subscription'; f.fact.requestedAction = 'info'; f.fact.presentationData = { benefits: [], hasProAccess: true }; f.input.operationalActions = [{ domain: 'subscription', action: 'info' }]; f.input.conversationReply = 'Observed plan explanation';
    expect((await f.composeRouterObservedReply(f.input)).finalReply).toBe('Observed plan explanation\n\nObserved card'); f.fact.complete = false; expect((await f.composeRouterObservedReply(f.input)).finalReply).toBe('Observed card');
  });
  it('states bounded coverage and unknown failed reads for subscription-only current recap', async () => {
    const f = fixture(); f.fact.tool = 'manage_subscription'; f.fact.complete = false; f.input.operationalActions = [{ domain: 'subscription', action: 'info' }]; f.input.recap = { domain: 'conversation', action: 'recap', recapMode: 'current' };
    const text = (await f.composeRouterObservedReply(f.input)).finalReply; expect(text).toContain('complete inventory coverage is not verified'); expect(text).toContain('Current status in failed or partial reads is unknown'); expect(f.deps.answerFromObservedReads).not.toHaveBeenCalled();
  });
  it('synthesizes excluded-clause framing around eligible observations and includes its duration', async () => {
    const f = fixture(); f.input.execution.excluded = [{ quote: 'Excluded request' }]; vi.mocked(f.deps.callResponseSynthesis).mockResolvedValue({ before: 'Excluded explanation' });
    expect(await f.composeRouterObservedReply(f.input)).toMatchObject({ finalReply: 'Excluded explanation\n\nObserved card', modelElapsedMs: 31 }); expect(f.deps.callResponseSynthesis).toHaveBeenCalledWith(expect.objectContaining({ facts: f.input.execution.facts, excludedClauses: f.input.execution.excluded }));
  });
  it('marks excluded read instructions without invoking excluded-clause synthesis', async () => {
    const f = fixture(); f.fact.requestedAction = 'list'; f.input.operationalActions = [{ domain: 'task', action: 'list' }]; f.input.execution.excluded = [{ quote: 'Excluded' }];
    expect((await f.composeRouterObservedReply(f.input)).finalReply).toContain('Excluded instructions were not executed.'); expect(f.deps.callResponseSynthesis).not.toHaveBeenCalled();
  });
  it('retains historical receipts beside failed current reads without duplicating them', async () => {
    const f = fixture(); f.fact.success = false; f.fact.complete = false; f.fact.requestedAction = 'list'; f.input.operationalActions = [{ domain: 'task', action: 'list' }];
    expect((await f.composeRouterObservedReply(f.input)).finalReply).toBe('Observed card\n\nPrevious confirmed operation'); f.fact.card = 'Previous confirmed operation'; expect((await f.composeRouterObservedReply(f.input)).finalReply).toBe('Previous confirmed operation');
  });
  it('adds a recommendation only on the eligible mutation path and skips it for recap', async () => {
    const f = fixture(); vi.mocked(f.deps.resolveNextBestAction).mockResolvedValue({ recommendationText: 'Suggested next step' });
    expect((await f.composeRouterObservedReply(f.input)).finalReply).toBe('Observed card\n\nSuggested next step'); f.input.recap = { domain: 'conversation', action: 'recap', recapMode: 'historical' }; vi.mocked(f.deps.resolveNextBestAction).mockClear(); await f.composeRouterObservedReply(f.input); expect(f.deps.resolveNextBestAction).not.toHaveBeenCalled();
  });
  it('sanitizes and replaces operational templates before appending stored original quotes', async () => {
    const f = fixture(); vi.mocked(f.deps.replaceTrustedLinkPlaceholders).mockResolvedValue('Replaced operation'); vi.mocked(f.deps.sanitizeResponseText).mockReturnValue('Sanitized operation'); vi.mocked(f.deps.renderPersonalKnowledge).mockReturnValue('Original quote [auth_url]');
    expect((await f.composeRouterObservedReply(f.input)).finalReply).toBe('Sanitized operation\n\nOriginal quote [auth_url]'); expect(f.deps.sanitizeResponseText).toHaveBeenCalledWith('Replaced operation');
  });
});

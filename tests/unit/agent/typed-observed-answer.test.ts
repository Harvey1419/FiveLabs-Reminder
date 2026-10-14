import { describe, expect, it, vi } from 'vitest';
import { createObservedAnswer, type ObservedAnswerDependencies, type ObservedAnswerInput } from '../../../src/agent/orchestration/observed-answer-core.js';
const row = { id: 'task-id', user_id: 'owner', title: 'Observed task', status: 'pending', description: null };
const decision = { kind: 'task_status', answer: '', evidenceCallIds: ['read-1'], knowledgeRefs: null, taskCoverage: 'returned_rows', taskClaims: [{ callId: 'read-1', itemId: 'task-id', referencePosition: null, fields: ['status', 'description'] }] };
function fixture() {
  const complete = vi.fn<ObservedAnswerDependencies['complete']>(async () => ({ content: JSON.stringify(decision) }));
  const refs = vi.fn<(refs: readonly string[]) => void>(); const outcome = vi.fn<(outcome: string) => void>();
  const deps: ObservedAnswerDependencies = { complete, historicalMutationReceipts: vi.fn(() => []), historicalRecap: vi.fn(() => 'Historical quote'), receiptBlock: vi.fn(() => '') };
  const input: ObservedAnswerInput = { userText: 'Task fields?', language: 'en', userId: 'owner', facts: [{ tool: 'manage_task', requestedAction: 'list', callId: 'read-1', success: true, complete: true, presentationData: { tasks: [row] } }], onKnowledgeRefs: refs, onInterpretationOutcome: outcome };
  return { input, deps, complete, refs, outcome, ...createObservedAnswer(deps) };
}
describe('typed bounded observed-answer completion', () => {
  it('renders observed task fields rather than generated values with strict JSON and no tools', async () => {
    const f = fixture(); f.complete.mockResolvedValue({ content: JSON.stringify({ ...decision, answer: 'Invented model prose' }) });
    expect(await f.answerFromObservedReads(f.input)).toBe('Observed task: pending; description: absent.');
    expect(f.outcome).toHaveBeenCalledWith('accepted'); expect(f.complete).toHaveBeenCalledTimes(1);
    expect(f.complete.mock.calls[0]![1]).toMatchObject({ purpose: 'observed_answer', tools: null, toolChoice: 'none', max_tokens: 2048, responseFormat: { type: 'json_schema', json_schema: { strict: true } } });
  });
  it('bounds prior dialogue text and projects no entities or tool history', async () => {
    const f = fixture(); f.input.conversationHistory = [...Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i}:` + 'x'.repeat(2100), entities: { secret: 'hidden' } })), { role: 'tool', content: 'tool secret' }];
    const before = structuredClone(f.input.conversationHistory); await f.answerFromObservedReads(f.input);
    const context = JSON.parse(f.complete.mock.calls[0]![0][1]!.content);
    expect(context.priorConversation).toHaveLength(6); expect(context.priorConversation[0].content).toMatch(/^34:/);
    expect(context.priorConversation.reduce((sum: number, turn: { content: string }) => sum + turn.content.length, 0)).toBe(12000);
    expect(context.priorConversation.every((turn: object) => !('entities' in turn))).toBe(true); expect(f.input.conversationHistory).toEqual(before);
  });
  it('projects only owned personal quotes and constrains personal answers to typed selections', async () => {
    const f = fixture(); const ref = 'pk_012345abcdef_1'; f.input.personalKnowledge = new Map([[ref, { userId: 'owner', content: 'Original quote' }], ['foreign', { userId: 'other', content: 'Foreign quote' }]]);
    f.complete.mockResolvedValue({ content: JSON.stringify({ ...decision, knowledgeRefs: [ref] }) }); await f.answerFromObservedReads(f.input);
    expect(f.refs).toHaveBeenCalledWith([ref]);
    const [messages, options] = f.complete.mock.calls[0]!;
    expect(JSON.parse(messages[1]!.content).personalSources).toEqual([{ ref, quote: 'Original quote' }]);
    expect(options.validateStructuredContent?.(JSON.stringify({ ...decision, answer: 'Generated personal value' }))).toEqual({ valid: false });
    expect(options.responseFormat).toMatchObject({ json_schema: { schema: { properties: { answer: { enum: [''] } } } } });
  });
  it('rejects combined personal selections above eight before publishing refs', async () => {
    const f = fixture(); f.input.selectedKnowledgeRefs = Array.from({ length: 8 }, (_, i) => `pk_012345abcdef_${i + 1}`);
    f.complete.mockResolvedValue({ content: JSON.stringify({ ...decision, knowledgeRefs: ['pk_012345abcdef_9'] }) });
    await f.answerFromObservedReads(f.input); expect(f.refs).not.toHaveBeenCalled(); expect(f.outcome).toHaveBeenCalledWith('rejected');
  });
  it.each([{ referenceSnapshot: false }, { userText: 'x'.repeat(24001) }])('stops before inference for invalid/over-budget context', async patch => {
    const f = fixture(); await f.answerFromObservedReads({ ...f.input, ...patch }); expect(f.complete).not.toHaveBeenCalled(); expect(f.outcome).not.toHaveBeenCalled();
  });
  it('rejects a combined over-budget observation view without truncating evidence into a smaller request', async () => {
    const f = fixture(); f.input.facts = [{ ...f.input.facts[0], presentationData: { tasks: [{ ...row, description: 'x'.repeat(25000) }] } }];
    await f.answerFromObservedReads(f.input); expect(f.complete).not.toHaveBeenCalled();
  });
  it.each([{ content: 'invalid' }, { unavailable: true, content: JSON.stringify(decision) }, null])('keeps useful observed fields after unavailable or invalid completions %j', async response => {
    const f = fixture(); f.complete.mockResolvedValue(response); const text = await f.answerFromObservedReads(f.input);
    expect(text).toContain('Observed task: pending; description: absent.'); expect(f.refs).not.toHaveBeenCalled(); expect(f.complete).toHaveBeenCalledTimes(1);
    expect(f.outcome).toHaveBeenCalledWith(response && 'unavailable' in response ? 'unavailable' : 'rejected');
  });
  it('reports unresolved frozen ordinals after named field rendering in callback order', async () => {
    const f = fixture(); const events: string[] = [];
    f.input.referenceSnapshot = { items: [{ type: 'task', position: 2, internalId: 'other-id', title: 'Different task' }] };
    f.input.onKnowledgeRefs = () => { events.push('refs'); }; f.input.onInterpretationOutcome = outcome => { events.push(outcome); };
    f.complete.mockResolvedValue({ content: JSON.stringify({ ...decision, taskClaims: [{ ...decision.taskClaims[0], referencePosition: 2 }] }) });
    expect(await f.answerFromObservedReads(f.input)).toContain('requested positions cannot be bound'); expect(events).toEqual(['refs', 'reference_unresolved']);
  });
  it('does not replay completion when a callback fails, and leaves pre-inference history errors visible', async () => {
    const f = fixture(); f.input.onKnowledgeRefs = () => { throw new Error('callback failed'); };
    expect(await f.answerFromObservedReads(f.input)).toContain("couldn't finish"); expect(f.complete).toHaveBeenCalledTimes(1); expect(f.outcome).toHaveBeenCalledWith('unavailable');
    const g = fixture(); vi.mocked(g.deps.historicalMutationReceipts).mockImplementation(() => { throw new Error('history failed'); });
    await expect(g.answerFromObservedReads(g.input)).rejects.toThrow('history failed'); expect(g.complete).not.toHaveBeenCalled();
  });
  it('requires actual cited pending and completed rows for both-status coverage', async () => {
    const f = fixture(); f.complete.mockResolvedValue({ content: JSON.stringify({ ...decision, taskCoverage: 'both_statuses' }) });
    await f.answerFromObservedReads(f.input); expect(f.outcome).toHaveBeenCalledWith('rejected');
    f.input.facts = [{ ...f.input.facts[0], presentationData: { tasks: [row, { ...row, id: 'completed-id', status: 'completed' }] } }];
    await f.answerFromObservedReads(f.input); expect(f.outcome).toHaveBeenLastCalledWith('accepted');
  });
  it('retains ordinary non-task prose backed by exact observed calls', async () => {
    const f = fixture(); f.input.facts = [{ tool: 'manage_reminder', requestedAction: 'list', success: true, complete: true, callId: 'read-1' }];
    f.complete.mockResolvedValue({ content: JSON.stringify({ ...decision, kind: 'derived', answer: 'A supported explanation.', taskClaims: [] }) });
    expect(await f.answerFromObservedReads(f.input)).toBe('A supported explanation.'); expect(f.outcome).toHaveBeenCalledWith('accepted');
  });
});

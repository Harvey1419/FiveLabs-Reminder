import { describe, expect, it, vi } from 'vitest';
import { createRouterActiveRun, type RouterActiveRunDependencies, type RouterActiveRunInput } from '../../../src/agent/orchestration/router-active-run.js';
import type { LegacyAgentRunWithActions } from '../../../src/agent/core/active-run-lifecycle.js';
interface Fact { id: string }
const run: LegacyAgentRunWithActions = { id: 'run', user_id: 'owner', thread_id: 'thread', status: 'waiting_for_approval', kind: 'task_mutation', context: {}, waiting_for: null, expires_at: '2027-01-14T14:00:00Z', preparedActions: [] };
function fixture(status = 'waiting_for_approval', decision: Record<string, unknown> = { relation: 'approval', decision: 'approve_all' }) {
  const pending = { ...run, status };
  let language = 'es', timezone = 'UTC';
  const input: RouterActiveRunInput = { user: { id: 'owner' }, phoneNumber: 'thread', requestReferenceTime: new Date('2027-01-14T12:00:00Z'), requestId: 'request', isPro: false, prompt: 'Prompt', pastTurns: [{ role: 'assistant', content: 'Old' }], messageText: 'Context attachment', currentUserText: 'Yes', messages: [{ role: 'system', content: 'Prompt' }], options: { correlationId: 'correlation' }, get language() { return language; }, get timezone() { return timezone; }, applyDecisionContext: vi.fn(async () => true) };
  const deps: RouterActiveRunDependencies<Fact, Record<string, unknown>> = {
    getActiveAgentRun: vi.fn(async () => pending), formatActiveRunPrompt: vi.fn(() => 'Pending'),
    callChatCompletion: vi.fn(async () => ({ content: JSON.stringify({ responseLanguage: 'es', ...decision }) })),
    executeApprovalDecision: vi.fn(async () => ({ success: true, executed: true, facts: [{ id: 'observed' }], executedCount: 1 })),
    executeContinuationDecision: vi.fn(async () => ({ success: true, domain: 'reminder', fact: { id: 'observed' } })),
    updateAgentRunIfStatusFromDb: vi.fn(async () => true), composeExecutionReply: vi.fn(facts => facts?.length ? 'Observed card' : ''),
    conversationStateEntities: vi.fn((user, extra) => ({ owner: user.id, ...extra })), mutationReceiptsFromFacts: vi.fn(facts => facts), logger: { warn: vi.fn() },
  };
  return { pending, input, deps, resolve: createRouterActiveRun(deps).resolveRouterActiveRun, setContext: () => { language = 'en'; timezone = 'America/Bogota'; } };
}
describe('typed pending-run router', () => {
  it('passes through an absent run without altering the current prompt', async () => {
    const f = fixture(); vi.mocked(f.deps.getActiveAgentRun).mockResolvedValue(null);
    expect(await f.resolve(f.input)).toEqual({ handled: false, supersedesRunId: null, preserveExistingActiveRun: false });
    expect(f.input.messages).toEqual([{ role: 'system', content: 'Prompt' }]); expect(f.deps.callChatCompletion).not.toHaveBeenCalled();
  });
  it('delegates approval cancellation to rejection and never claims cancellation after a lost race', async () => {
    const f = fixture('waiting_for_approval', { relation: 'cancel' });
    vi.mocked(f.deps.executeApprovalDecision).mockResolvedValue({ success: false, status: 'not_acquired' });
    expect(await f.resolve(f.input)).toMatchObject({ handled: true, response: { confirmation: 'No pude cancelar la operación pendiente; su estado cambió.' } });
    expect(f.deps.executeApprovalDecision).toHaveBeenCalledWith({ run: f.pending, decision: 'reject', executionContext: { user: f.input.user } });
    expect(f.deps.updateAgentRunIfStatusFromDb).not.toHaveBeenCalled();
  });
  it('does not replace a failed approval result with the model success wording', async () => {
    const f = fixture('waiting_for_approval', { relation: 'approval', decision: 'approve_all', reply: 'Everything succeeded' });
    vi.mocked(f.deps.executeApprovalDecision).mockResolvedValue({ success: false, executed: false, facts: [] });
    expect(await f.resolve(f.input)).toMatchObject({ handled: true, response: { confirmation: 'No se pudo completar la operación pendiente. Por favor intenta nuevamente.', executionFacts: [] } });
  });
  it('propagates uncertain execution errors without retrying the action', async () => {
    const f = fixture(); vi.mocked(f.deps.executeApprovalDecision).mockRejectedValue(new Error('write outcome unknown'));
    await expect(f.resolve(f.input)).rejects.toThrow('write outcome unknown'); expect(f.deps.executeApprovalDecision).toHaveBeenCalledTimes(1);
    expect(f.deps.executeContinuationDecision).not.toHaveBeenCalled(); expect(f.deps.updateAgentRunIfStatusFromDb).not.toHaveBeenCalled();
  });
  it('blocks a running request without another model call or execution', async () => {
    const f = fixture('running'); const result = await f.resolve(f.input);
    expect(result).toMatchObject({ handled: true, response: { intent: 'clarification', memoryDisposition: 'skip_operational', executionFacts: [] } });
    expect(f.deps.callChatCompletion).not.toHaveBeenCalled(); expect(f.deps.executeApprovalDecision).not.toHaveBeenCalled();
  });
  it.each(['waiting_for_approval', 'waiting_for_input'])('blocks invalid or failed decisions while %s', async status => {
    const f = fixture(status, { relation: 'invented' }); expect(await f.resolve(f.input)).toMatchObject({ handled: true, response: { plan: { type: 'active_run_unresolved' } } });
    vi.mocked(f.deps.callChatCompletion).mockRejectedValue(new Error('offline'));
    expect(await f.resolve(f.input)).toMatchObject({ handled: true, response: { intent: 'clarification' } });
    expect(f.deps.executeApprovalDecision).not.toHaveBeenCalled(); expect(f.deps.executeContinuationDecision).not.toHaveBeenCalled(); expect(f.deps.updateAgentRunIfStatusFromDb).not.toHaveBeenCalled();
  });
  it('keeps strict provider validation and separates attachment context from authored approval', async () => {
    const f = fixture(); await f.resolve(f.input); const [messages, options] = vi.mocked(f.deps.callChatCompletion).mock.calls[0]!;
    expect(options).toMatchObject({ tools: null, toolChoice: 'none', purpose: 'approval_decision', max_tokens: 4096, correlationId: 'correlation', responseFormat: { json_schema: { strict: true } } });
    expect(options.validateStructuredContent('{"relation":"approval","decision":"approve_subset","responseLanguage":"es","selectedCallIds":[]}').valid).toBe(false);
    expect(messages.at(-2)?.content).toContain('REFERENCE DATA ONLY'); expect(messages.at(-1)?.content).toBe('Yes');
  });
  it('passes exact subset IDs and refreshed profile context to the existing executor', async () => {
    const f = fixture('waiting_for_approval', { relation: 'approval', decision: 'approve_subset', selectedCallIds: ['call-2'] });
    f.input.applyDecisionContext = vi.fn(async () => { f.setContext(); return true; });
    expect(await f.resolve(f.input)).toMatchObject({ handled: true, response: { language: 'en', confirmation: 'Observed card', executionFacts: [{ id: 'observed' }] } });
    expect(f.deps.executeApprovalDecision).toHaveBeenCalledWith({ run: f.pending, decision: 'approve_subset', selectedCallIds: ['call-2'], executionContext: { user: f.input.user, language: 'en', timezone: 'America/Bogota', isPro: false, referenceTime: f.input.requestReferenceTime, correlationId: 'request' } });
  });
  it('stops domain actions after an unconfirmed profile update or a rejected lease', async () => {
    const f = fixture(); vi.mocked(f.input.applyDecisionContext).mockResolvedValue(false);
    expect(await f.resolve(f.input)).toMatchObject({ handled: true, response: { intent: 'clarification', executionFacts: [] } });
    vi.mocked(f.input.applyDecisionContext).mockRejectedValue(new Error('lease lost'));
    await expect(f.resolve(f.input)).rejects.toThrow('lease lost'); expect(f.deps.executeApprovalDecision).not.toHaveBeenCalled();
  });
  it('renders continuation observations and retains failure facts without a success receipt', async () => {
    const f = fixture('waiting_for_input', { relation: 'resume', actionInputs: [{ callId: 'call-2', fields: { content: 'Correction' } }] });
    expect(await f.resolve(f.input)).toMatchObject({ handled: true, response: { plan: { type: 'continuation_decision' }, executionFacts: [{ id: 'observed' }] } });
    expect(f.deps.executeContinuationDecision).toHaveBeenCalledWith(expect.objectContaining({ suppliedFields: {}, actionInputs: [{ callId: 'call-2', fields: { content: 'Correction' } }] }));
    vi.mocked(f.deps.executeContinuationDecision).mockResolvedValue({ success: false, facts: [{ id: 'failure' }], error: 'failed' });
    expect(await f.resolve(f.input)).toMatchObject({ handled: true, response: { plan: { type: 'continuation_decision_failed' }, executionFacts: [{ id: 'failure' }], entities: { owner: 'owner' } } });
  });
  it('cancels the exact pending input using status compare-and-set and reports a lost race', async () => {
    const f = fixture('waiting_for_input', { relation: 'cancel' }); vi.mocked(f.deps.updateAgentRunIfStatusFromDb).mockResolvedValue(false);
    expect(await f.resolve(f.input)).toMatchObject({ handled: true, response: { confirmation: 'No pude cancelar la operación pendiente; su estado cambió.' } });
    expect(f.deps.updateAgentRunIfStatusFromDb).toHaveBeenCalledWith({ runId: 'run', userId: 'owner', threadId: 'thread', expectedStatus: 'waiting_for_input', nextStatus: 'cancelled', now: f.input.requestReferenceTime });
  });
  it.each(['waiting_for_input', 'waiting_for_approval'])('preserves unrelated drafts and defers replacement retirement for %s', async status => {
    const f = fixture(status, { relation: 'unrelated' }); expect(await f.resolve(f.input)).toEqual({ handled: false, preserveExistingActiveRun: true, supersedesRunId: null });
    vi.mocked(f.deps.callChatCompletion).mockResolvedValue({ content: JSON.stringify({ responseLanguage: 'es', relation: 'supersede' }) });
    expect(await f.resolve(f.input)).toEqual({ handled: false, preserveExistingActiveRun: false, supersedesRunId: 'run' });
    expect(f.input.messages[0]?.content).toContain('<pending_draft>'); expect(f.input.messages[0]?.content).toContain('do not recreate them');
    expect(f.deps.updateAgentRunIfStatusFromDb).not.toHaveBeenCalled(); expect(f.deps.executeApprovalDecision).not.toHaveBeenCalled(); expect(f.deps.executeContinuationDecision).not.toHaveBeenCalled();
  });
});

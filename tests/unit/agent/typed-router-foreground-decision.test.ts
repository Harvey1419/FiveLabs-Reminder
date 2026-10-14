import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRouterForegroundDecision, type RouterForegroundDependencies, type RouterForegroundInput } from '../../../src/agent/orchestration/router-foreground-decision.js';
import { createWorkingMemoryStore } from '../../../src/agent/core/working-memory-cache.js';
import { enforceCurrentProfileSource } from '../../../src/agent/orchestration/router-turn-decisions.js';
const reply = { actions: [{ domain: 'conversation', action: 'reply', content: 'Hello' }], excluded: [], responseCapability: 'general' };
function fixture(response: unknown = { structuredIntent: reply }) {
  let ticks = 100;
  const input: RouterForegroundInput = { rawPastTurns: [{ role: 'assistant', content: 'Prior' }], user: { id: 'owner' }, messages: [{ role: 'system', content: 'Prompt' }, { role: 'user', content: 'Current' }], isAdmin: false, isAttachmentOnlyTurn: false, requestId: 'request', prompt: 'Prompt', pastTurns: [], historyChars: 0, relevantMemories: [], options: { correlationId: 'correlation' }, language: 'en', currentUserText: 'Current', workingMemoryKey: 'thread' };
  const memory = { source: 'task', items: [{ position: 4, title: 'Task' }], timestamp: 50, infraFault: true, faultReason: 'old failure' };
  const deps: RouterForegroundDependencies<Record<string, unknown>> = {
    operationalEvidenceFromHistory: vi.fn(() => []), callChatCompletion: vi.fn(async () => response), getWorkingMemory: vi.fn(() => memory),
    saveWorkingMemory: vi.fn(), conversationStateEntities: vi.fn((user, extra) => ({ owner: user.id, ...extra })), now: () => ticks++, logger: { log: vi.fn(), warn: vi.fn() },
  };
  return { input, deps, memory, decide: createRouterForegroundDecision(deps).decideRouterForeground };
}
afterEach(() => vi.restoreAllMocks());
describe('typed foreground admission', () => {
  it('admits one canonical decision through the existing strict provider schema', async () => {
    const f = fixture(); expect(await f.decide(f.input)).toMatchObject({ accepted: true, intent: { actions: reply.actions }, hasHistoricalEvidence: false, modelElapsedMs: 1 });
    expect(f.deps.callChatCompletion).toHaveBeenCalledTimes(1);
    const [messages, options] = vi.mocked(f.deps.callChatCompletion).mock.calls[0]!;
    expect(messages).toBe(f.input.messages); expect(options).toMatchObject({ max_tokens: 8192, tools: null, toolChoice: 'none', purpose: 'initial', returnMessage: true, correlationId: 'correlation', responseFormat: { json_schema: { strict: true, name: 'hermes_turn_intent' } } });
    expect(options.validateStructuredContent(JSON.stringify({ responseCapability: 'general', actions: [{ operation: 'conversation.reply', content: 'Hello' }], excluded: [] })).valid).toBe(true);
    expect(options.validateStructuredContent('Unstructured prose').valid).toBe(false);
  });
  it('clears only the infrastructure marker while preserving the reference view and age', async () => {
    const f = fixture(); await f.decide(f.input);
    expect(f.deps.saveWorkingMemory).toHaveBeenCalledWith('thread', { source: 'task', items: f.memory.items, timestamp: 50 }, { restoredTimestamp: 50 });
    expect(f.memory.infraFault).toBe(true); expect(f.deps.conversationStateEntities).not.toHaveBeenCalled();
  });
  it('marks a failed provider without renewing the prior memory timestamp or dropping references', async () => {
    const f = fixture(); vi.mocked(f.deps.callChatCompletion).mockRejectedValue(new Error('offline'));
    expect(await f.decide(f.input)).toMatchObject({ accepted: false, response: { plan: { type: 'provider_unavailable' }, executionFacts: [], memoryDisposition: 'skip_operational' } });
    expect(f.deps.saveWorkingMemory).toHaveBeenCalledWith('thread', { ...f.memory, infraFault: true, faultReason: 'provider_unavailable' }, { restoredTimestamp: 50 });
    expect(f.deps.callChatCompletion).toHaveBeenCalledTimes(1);
  });
  it.each(['schema_rejection', 'invalid_structured_output', 'structured_generation_rejection'])('retains classified provider failure %s', async reason => {
    const f = fixture({ unavailable: true, unavailableReason: reason }); expect(await f.decide(f.input)).toMatchObject({ accepted: false, response: { plan: { type: reason === 'schema_rejection' ? reason : 'invalid_structured_output' } } });
    expect(f.deps.saveWorkingMemory).toHaveBeenCalledWith('thread', expect.objectContaining({ faultReason: reason }), { restoredTimestamp: 50 });
  });
  it('preserves explicit refusal and never treats prior confirmations as invalidated', async () => {
    const f = fixture({ unavailable: true, refused: true }); const result = await f.decide(f.input);
    expect(result).toMatchObject({ accepted: false, response: { plan: { type: 'provider_refusal' }, confirmation: expect.stringContaining('does not invalidate prior confirmations') } });
  });
  it.each([{ content: 'Friendly prose' }, { content: '{' }, { structuredIntent: reply, tool_calls: [{ function: { name: 'execute_turn', arguments: '{}' } }] }])('rejects malformed or legacy tool output %#', async response => {
    const f = fixture(response); expect(await f.decide(f.input)).toMatchObject({ accepted: false, response: { plan: { type: 'invalid_intent' } } });
    expect(f.deps.saveWorkingMemory).toHaveBeenCalledWith('thread', expect.objectContaining({ infraFault: true }), { restoredTimestamp: 50 });
  });
  it('requires profile evidence from the current instruction at admission and provider validation', async () => {
    const intent = { actions: [{ domain: 'task', action: 'complete', target: 'Task' }], excluded: [], responseCapability: 'general', profileUpdate: { sourceQuote: 'Old message', timezone: 'UTC' } };
    const f = fixture({ structuredIntent: intent }); expect(await f.decide(f.input)).toMatchObject({ accepted: false, response: { plan: { type: 'invalid_intent' } } });
    const options = vi.mocked(f.deps.callChatCompletion).mock.calls[0]![1];
    expect(options.validateStructuredContent(JSON.stringify({ ...intent, actions: [{ operation: 'task.complete', target: 'Task' }] }))).toMatchObject({ valid: false, errorCode: 'INVALID_TURN_CONTEXT' });
  });
  it('blocks operations from attachment-only turns while allowing their description', async () => {
    const f = fixture({ structuredIntent: { ...reply, actions: [{ domain: 'task', action: 'complete', target: 'Task' }] } }); f.input.isAttachmentOnlyTurn = true;
    expect(await f.decide(f.input)).toMatchObject({ accepted: false });
    vi.mocked(f.deps.callChatCompletion).mockResolvedValue({ structuredIntent: reply }); expect(await f.decide(f.input)).toMatchObject({ accepted: true });
  });
  it('reads owned historical availability through the host and drops nonexistent recap references', async () => {
    const f = fixture({ structuredIntent: { ...reply, actions: [{ ...reply.actions[0], evidenceRefs: ['11111111-1111-4111-8111-111111111111'] }] } }); const absent = await f.decide(f.input);
    expect(absent).toMatchObject({ accepted: true }); if (absent.accepted) expect(absent.intent.actions[0]).not.toHaveProperty('evidenceRefs');
    vi.mocked(f.deps.operationalEvidenceFromHistory).mockReturnValue([{ ref: '11111111-1111-4111-8111-111111111111', observed: 'prior effect' }]); const present = await f.decide(f.input);
    expect(present).toMatchObject({ accepted: true, hasHistoricalEvidence: true }); expect(f.input.messages[0]?.content).toContain('not fresh state');
    expect(f.deps.operationalEvidenceFromHistory).toHaveBeenCalledWith(f.input.rawPastTurns, 'owner');
  });
  it('preserves null-intent projection identity in the shared profile guard', () => {
    const unavailable = { valid: true as const, intent: null }; expect(enforceCurrentProfileSource(unavailable, 'Current')).toBe(unavailable);
  });
  it('retains opaque diagnostic reasons in the actual cache without promoting them to authority', async () => {
    const store = createWorkingMemoryStore({ clearAgentRunsForUser: () => {} }); const reason = { code: 'unknown-provider-code' };
    const f = fixture({ unavailable: true, unavailableReason: reason }); f.deps.getWorkingMemory = store.getWorkingMemory; f.deps.saveWorkingMemory = store.saveWorkingMemory;
    expect(await createRouterForegroundDecision(f.deps).decideRouterForeground(f.input)).toMatchObject({ accepted: false, response: { plan: { type: 'provider_unavailable' } } });
    expect(store.getWorkingMemory('thread')?.faultReason).toBe(reason);
  });
  it('does not prolong actual working-memory expiry on an unsuccessful foreground turn', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const store = createWorkingMemoryStore({ clearAgentRunsForUser: () => {} }); store.saveWorkingMemory('thread', { source: 'task', items: [{ id: 'prior-task', title: 'Prior task', position: 4 }] });
    const f = fixture({ unavailable: true }); f.deps.getWorkingMemory = store.getWorkingMemory; f.deps.saveWorkingMemory = store.saveWorkingMemory;
    clock.mockReturnValue(20_000); await createRouterForegroundDecision(f.deps).decideRouterForeground(f.input);
    expect(store.getWorkingMemory('thread')).toMatchObject({ timestamp: 10_000, infraFault: true, items: [{ position: 4, title: 'Prior task' }] });
    clock.mockReturnValue(10_000 + 2 * 60 * 60 * 1000 + 1); expect(store.getWorkingMemory('thread')).toBeNull();
  });
});

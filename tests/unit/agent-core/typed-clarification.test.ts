import { describe, expect, it, vi } from 'vitest';
import { MockAIProvider } from '@templelabs/ai';
import { aiTranscriptSchema, type AIResponse } from '@templelabs/contracts';
import { productivityClarificationSchema, productivityUiPayloadSchema } from '../../../packages/contracts/src/productivity-turn.js';
import { createReminderTools, ToolRegistry, type ReminderDomainPort } from '@templelabs/tools';
import { ProductivityTurnRunner } from '../../../packages/agent-core/src/productivity-turn.js';
import type { AgentLoopOptions } from '../../../packages/agent-core/src/agent-loop.js';
import { context, response, reminderCreate, reminderId } from './productivity-fixtures.js';

const metadata = { domain: 'reminders', missing: 'today_or_tomorrow' };
const clarify = (args = metadata, content = ''): AIResponse => ({ ...response([{ id: 'clarify', name: 'conversation_clarify', arguments: args }]),
  message: { role: 'assistant', content, toolCalls: [{ id: 'clarify', name: 'conversation_clarify', arguments: args }] } });
const create = () => response([{ ...reminderCreate, arguments: { ...reminderCreate.arguments, turnDisposition: 'continue' } }]);
function harness(script: AIResponse[], options: AgentLoopOptions & { compactObservations?: boolean } = {}, uncertain = false) {
  const provider = new MockAIProvider(script.map(response => ({ response })), () => 100);
  const execute = vi.fn<ReminderDomainPort['execute']>(async (request, ctx, operationId) => {
    if (uncertain) return { status: 'indeterminate', operationId, observation: 'Unknown effect' };
    const data = { operation: request.operation, complete: true, coverage: 'operation' as const,
      records: [{ id: reminderId, content: 'Preparar reunión', sendAt: '2026-10-11T21:00:00Z', status: 'pending' as const,
        recurrence: null, isAdvanceNotice: false, parentReminderId: null, requiresConfirmation: false, acknowledgedAt: null }],
      rejections: [], presentation: { canonicalCard: null, questions: [], cta: null } };
    return { status: 'success', data, observation: JSON.stringify(data), receipt: { userId: ctx.userId, operationId,
      toolName: `reminder_${request.operation}`, resourceIds: [reminderId] } };
  });
  const authorizeWrite = vi.fn(async () => true);
  const runner = new ProductivityTurnRunner(provider, new ToolRegistry(createReminderTools({ execute })), {
    continuation: 'observation_driven', finishWithVerifiedResults: true, now: () => 100, authorizeWrite, ...options });
  const journal = { beforeDispatch: vi.fn(async () => {}), afterOutcome: vi.fn(async () => {}) };
  return { runner, provider, execute, journal, authorizeWrite,
    run: () => runner.run('Crea el primero y pregunta la fecha del segundo', context, undefined, journal) };
}
describe('typed non-execution clarification S1–S3', () => {
  it('exports a strict additive contract and accepts old UI payloads', () => {
    expect(productivityClarificationSchema.parse(metadata)).toEqual(metadata);
    for (const value of [{ ...metadata, question: 'created!' }, { ...metadata, missing: 'anything' }, { ...metadata, domain: 'agenda' }])
      expect(productivityClarificationSchema.safeParse(value).success).toBe(false);
    expect(productivityUiPayloadSchema.safeParse({ language: 'es', timezone: 'UTC', items: [], notices: [] }).success).toBe(true);
    expect(productivityUiPayloadSchema.parse({ language: 'es', timezone: 'UTC', items: [], notices: [], clarification: metadata }).clarification).toEqual(metadata);
  });
  it.each([false, true])('advertises only after verified results, pairs and stops without execution (compact %s)', async compactObservations => {
    const h = harness([create(), clarify()], { compactObservations });
    const result = await h.run();
    expect(h.provider.requests).toHaveLength(2);
    expect(h.provider.requests[0]!.tools.some(tool => tool.name === 'conversation_clarify')).toBe(false);
    expect(h.provider.requests[1]!.tools.find(tool => tool.name === 'conversation_clarify')?.inputSchema).toMatchObject({ additionalProperties: false });
    expect(result.uiPayload.clarification).toEqual(metadata);
    expect(result.uiPayload.items).toHaveLength(1);
    expect(result.uiPayload.dialogue?.kind).toBe('execution');
    expect(result.conversationReply).toBeNull();
    expect(result.uiPayload.notices).toEqual([]);
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.authorizeWrite).toHaveBeenCalledOnce();
    expect(h.journal.beforeDispatch).toHaveBeenCalledOnce();
    expect(h.journal.afterOutcome).toHaveBeenCalledOnce();
    expect(aiTranscriptSchema.safeParse(result.conversation.history).success).toBe(true);
    expect(result.conversation.history.at(-1)).toMatchObject({ role: 'tool', isError: false, content: { status: 'clarification_required' } });
    expect(h.provider.requests[1]!.messages.find(message => message.role === 'system')?.content).toContain('conversation_clarify');
  });
  it.each([
    ['extra field', clarify({ ...metadata, question: 'done' } as typeof metadata)],
    ['invalid enum', clarify({ ...metadata, missing: 'nonsense' })],
    ['raw prose', clarify(metadata, 'I created everything. What next?')],
    ['combined write', response([clarify().message.toolCalls[0]!, reminderCreate])],
  ])('rejects %s atomically before transcript/dispatch changes', async (_name, rejected) => {
    const h = harness([create(), rejected]);
    const result = await h.run();
    expect(result.uiPayload.clarification).toBeUndefined();
    expect(result.uiPayload.notices).toEqual(['invalid_response']);
    expect(result.conversation.history).toHaveLength(3);
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.authorizeWrite).toHaveBeenCalledOnce();
    expect(h.journal.beforeDispatch).toHaveBeenCalledOnce();
    expect(h.journal.afterOutcome).toHaveBeenCalledOnce();
    expect(result.uiPayload.items).toHaveLength(1);
  });
  it('rejects unadvertised clarification without any domain effect', async () => {
    const h = harness([clarify()]);
    const result = await h.run();
    expect(result.uiPayload.clarification).toBeUndefined();
    expect(result.uiPayload.notices).toEqual(['invalid_response']);
    expect(result.conversation.history).toHaveLength(1);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.authorizeWrite).not.toHaveBeenCalled();
    expect(h.journal.beforeDispatch).not.toHaveBeenCalled();
  });
  it('does not open clarification when a verified result has a failed sibling', async () => {
    const second = { ...reminderCreate, id: 'second', arguments: { ...reminderCreate.arguments,
      content: 'Segundo recordatorio', turnDisposition: 'continue' } };
    const h = harness([response([create().message.toolCalls[0]!, second]), clarify()]);
    const execute = h.execute.getMockImplementation()!;
    h.execute.mockImplementationOnce(execute).mockImplementationOnce(async () => ({
      status: 'failed', code: 'FIXTURE_FAILED', observation: 'The second operation failed.',
    }));
    const result = await h.run();
    expect(result.uiPayload.items.map(item => item.status)).toEqual(['success', 'failed']);
    expect(h.provider.requests).toHaveLength(2);
    expect(h.provider.requests[1]!.tools.some(tool => tool.name === 'conversation_clarify')).toBe(false);
    expect(result.uiPayload.clarification).toBeUndefined();
    expect(result.uiPayload.notices).toEqual(['invalid_response']);
    expect(h.execute).toHaveBeenCalledTimes(2);
    expect(h.journal.beforeDispatch).toHaveBeenCalledTimes(2);
    expect(h.journal.afterOutcome).toHaveBeenCalledTimes(2);
  });
  it('stops at uncertain effects without advertising or accepting clarification', async () => {
    const h = harness([create(), clarify()], {}, true);
    const result = await h.run();
    expect(result.requiresReconciliation).toBe(true);
    expect(result.uiPayload.clarification).toBeUndefined();
    expect(h.provider.requests).toHaveLength(1);
  });
  it.each([
    ['tool calls', { maxToolCalls: 1 }],
    ['tokens', { maxTotalTokens: 70, estimateInputTokens: (): number => 0 }],
    ['cost', { maxCostUsd: 0.00007, pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, maxOutputTokens: 10, estimateInputTokens: (): number => 0 }],
  ] as const)('keeps the %s guard before accepting clarification', async (_name, options) => {
    const h = harness([create(), clarify()], options);
    const result = await h.run();
    expect(result.uiPayload.clarification).toBeUndefined();
    expect(result.uiPayload.notices).toContain('limit_reached');
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.journal.beforeDispatch).toHaveBeenCalledOnce();
  });
  it.each(['cancellation', 'deadline', 'output tokens', 'input tokens'])('preserves the %s post-response guard before clarification', async guard => {
    const controller = new AbortController();
    let clock = 100;
    const h = harness([create(), clarify()], { now: () => clock, maxInputTokens: 20000 });
    const complete = h.provider.complete.bind(h.provider);
    let step = 0;
    vi.spyOn(h.provider, 'complete').mockImplementation(async request => {
      const result = await complete(request);
      if (++step !== 2) return result;
      if (guard === 'cancellation') controller.abort();
      if (guard === 'deadline') clock = 100000;
      if (guard === 'output tokens') return { ...result, usage: { ...result.usage, outputTokens: 2000 } };
      if (guard === 'input tokens') return { ...result, usage: { ...result.usage, inputTokens: 20001 } };
      return result;
    });
    const result = await h.runner.run('Crea el primero y pregunta la fecha del segundo', { ...context, signal: controller.signal }, undefined, h.journal);
    expect(result.uiPayload.clarification).toBeUndefined();
    expect(result.uiPayload.notices).toEqual([guard === 'output tokens' ? 'invalid_response' : 'limit_reached']);
    expect(result.conversation.history).toHaveLength(3);
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.authorizeWrite).toHaveBeenCalledOnce();
    expect(h.journal.beforeDispatch).toHaveBeenCalledOnce();
    expect(h.journal.afterOutcome).toHaveBeenCalledOnce();
  });
  it('preserves explicit finish without another call; pending work must declare continue, not guessed intent', async () => {
    const h = harness([response([{ ...reminderCreate, arguments: { ...reminderCreate.arguments, turnDisposition: 'finish' } }])]);
    const result = await h.run();
    expect(h.provider.requests).toHaveLength(1);
    expect(result.uiPayload.items).toHaveLength(1);
    expect(result.uiPayload.clarification).toBeUndefined();
    expect(result.uiPayload.notices).toEqual([]);
  });
});

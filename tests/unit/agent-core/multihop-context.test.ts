import { describe, expect, it, vi } from 'vitest';
import { MockAIProvider } from '@templelabs/ai';
import { compactContext, estimateContextTokens, ReminderTurnRunner } from '@templelabs/agent-core';
import { createReminderTools, ToolRegistry } from '@templelabs/tools';
import { aiTranscriptSchema, type AIMessage, type AIResponse, type ToolCall, type TurnContext } from '@templelabs/contracts';
import { createLegacyReminderPort } from '../../../src/adapters/agent-core/legacy-reminders.js';

const id = '11111111-1111-4111-8111-111111111111';
const args = { content: 'Llamar a Ana', targetTimeIso: '2026-10-11T21:00:00Z' };
const context: TurnContext = { userId: 'owner', runId: 'run', requestId: 'request', language: 'es', timezone: 'America/Bogota',
  referenceTimeIso: '2026-10-11T17:49:00Z', signal: new AbortController().signal,
  capabilities: new Set(['reminders.read', 'reminders.create', 'reminders.update']) };
const row = { id, content: args.content, sendAt: args.targetTimeIso };
const read: ToolCall = { id: 'local', name: 'reminder_read', arguments: { filter: 'today' } };
const create: ToolCall = { id: 'local', name: 'reminder_create', arguments: args };
function response(calls: ToolCall[] = [], inputTokens = 30): AIResponse {
  return { message: { role: 'assistant', content: 'Internal instructions never reach the presenter.', toolCalls: calls },
    stopReason: calls.length ? 'tool_calls' : 'completed', usage: { inputTokens, outputTokens: 10 } };
}
function setup(sequence: AIResponse[], options: ConstructorParameters<typeof ReminderTurnRunner>[2] = {}) {
  const execute = vi.fn().mockResolvedValue({ success: true, action: 'created_reminders_batch', data: [row] });
  const provider = new MockAIProvider(sequence.map(response => ({ response })), () => 100);
  const registry = new ToolRegistry(createReminderTools(createLegacyReminderPort({ id: context.userId, timezone: context.timezone }, execute)));
  return { execute, provider, runner: new ReminderTurnRunner(provider, registry, {
    now: () => 100, continuation: 'observation_driven', authorizeWrite: async () => true, ...options,
  }) };
}

describe('bounded observation-driven reminder loop', () => {
  it('reads an ID, changes that observed reminder, and closes every batch before continuation', async () => {
    const { runner, provider, execute } = setup([response([read]), response([{ id: 'local', name: 'reminder_update',
      arguments: { reminderId: id, targetTimeIso: '2026-10-11T22:00:00Z' } }]), response()]);
    execute.mockResolvedValueOnce({ success: true, action: 'listed_reminders', data: { reminders: [row] } })
      .mockResolvedValueOnce({ success: true, action: 'updated_reminder', data: { ...row, sendAt: '2026-10-11T22:00:00Z' } });
    const result = await runner.run('Busca el recordatorio de Ana y muévelo una hora', context);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.uiPayload.items.map(item => item.status)).toEqual(['success', 'success']);
    expect(provider.requests).toHaveLength(3);
    expect(result.usage).toEqual({ modelSteps: 3, inputTokens: 90, outputTokens: 30, estimatedCostUsd: null, accountingComplete: true });
    const observation = provider.requests[1]?.messages.find(message => message.role === 'tool');
    expect(JSON.stringify(observation)).toContain(id);
    for (const request of provider.requests) expect(aiTranscriptSchema.safeParse(request.messages).success).toBe(true);
    expect(result.conversation.history.filter(message => message.role === 'tool').map(message => message.toolCallId))
      .toEqual(['request:local', 'request:step:1:local']);
  });

  it('feeds validation errors back and executes only corrected arguments', async () => {
    const { runner, provider, execute } = setup([response([{ ...create, arguments: { content: 'Ana' } }]), response([create]), response()]);
    const result = await runner.run('Crea', context);
    expect(result.uiPayload.items.map(item => item.status)).toEqual(['validation_failed', 'success']);
    expect(JSON.stringify(provider.requests[1]?.messages)).toContain('targetTimeIso');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not repeat a successful write with reordered arguments and a new call ID', async () => {
    const { runner, execute } = setup([response([create]), response([{ ...create, id: 'again',
      arguments: { targetTimeIso: args.targetTimeIso, content: args.content } }]), response()]);
    const result = await runner.run('Crea', context);
    expect(result.uiPayload.items[1]).toMatchObject({ status: 'denied', code: 'DUPLICATE_WRITE' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('stops continuation after an unknown write without consuming a retry completion', async () => {
    const { runner, provider, execute } = setup([response([create]), response([create])]);
    execute.mockRejectedValueOnce(new Error('receipt lost'));
    expect((await runner.run('Crea', context)).uiPayload.items[0]?.status).toBe('indeterminate');
    expect(provider.requests).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('caps total model steps and total calls across different batches', async () => {
    const steps = setup([response([read]), response([read]), response()], { maxModelSteps: 2 });
    expect((await steps.runner.run('Consulta', context)).uiPayload.notices).toContain('limit_reached');
    expect(steps.provider.requests).toHaveLength(2);
    const calls = setup([response([read]), response([create])], { maxToolCalls: 1 });
    expect((await calls.runner.run('Consulta y crea', context)).uiPayload.notices).toContain('limit_reached');
    expect(calls.execute).toHaveBeenCalledTimes(1);
  });

  it('reserves input/output tokens before each request and rejects actual usage overruns before effects', async () => {
    const preflight = setup([response([create])], { maxTotalTokens: 10, estimateInputTokens: () => 10 });
    expect((await preflight.runner.run('Crea', context)).uiPayload.notices).toEqual(['limit_reached']);
    expect(preflight.provider.requests).toHaveLength(0);
    const actual = setup([response([create], 200)], { maxTotalTokens: 100, estimateInputTokens: () => 1 });
    expect((await actual.runner.run('Crea', context)).uiPayload.notices).toEqual(['limit_reached']);
    expect(actual.execute).not.toHaveBeenCalled();
    const cumulative = setup([response([read]), response([create])], { maxTotalTokens: 45, estimateInputTokens: () => 5 });
    expect((await cumulative.runner.run('Consulta y crea', context)).uiPayload.notices).toEqual(['limit_reached']);
    expect(cumulative.provider.requests).toHaveLength(1);
  });

  it('requires pricing for a spend limit and reserves spend before contacting the provider', async () => {
    expect(() => setup([], { maxCostUsd: 0.01 })).toThrow('explicit provider pricing');
    const { runner, provider } = setup([response([create])], { maxCostUsd: 0.000001,
      pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, estimateInputTokens: () => 5 });
    expect((await runner.run('Crea', context)).uiPayload.notices).toEqual(['limit_reached']);
    expect(provider.requests).toHaveLength(0);
  });

  it('does not dispatch or continue after deadline and never swallows journal failure', async () => {
    let now = 100;
    const expired = setup([response([read]), response([create])], { timeoutMs: 5, now: () => now });
    expired.execute.mockImplementationOnce(async () => { now = 106; return { success: true, action: 'listed_reminders', data: { reminders: [row] } }; });
    expect((await expired.runner.run('Consulta y crea', context)).uiPayload.notices).toContain('limit_reached');
    expect(expired.provider.requests).toHaveLength(1);
    const failed = setup([response([create]), response()]);
    await expect(failed.runner.run('Crea', context, undefined, {
      beforeDispatch: async () => { throw new Error('checkpoint unavailable'); }, afterOutcome: async () => {},
    })).rejects.toThrow('checkpoint unavailable');
    expect(failed.execute).not.toHaveBeenCalled();
  });
});

describe('whole-turn context window', () => {
  function turn(index: number): AIMessage[] {
    return [{ role: 'user', content: `Turn ${index}` },
      { role: 'assistant', content: '', toolCalls: [{ ...read, id: `call-${index}` }] },
      { role: 'tool', toolCallId: `call-${index}`, content: { status: 'success' }, isError: false }];
  }
  it('keeps the last three user turns and complete tool pairs without mutating durable history', () => {
    const history = Array.from({ length: 20 }, (_, index) => turn(index)).flat();
    const recent = compactContext(history, 10);
    expect(recent).toHaveLength(9);
    expect(recent[0]).toMatchObject({ role: 'user', content: 'Turn 17' });
    expect(aiTranscriptSchema.safeParse(recent).success).toBe(true);
    expect(history).toHaveLength(60);
    expect(compactContext(history, 64)).toHaveLength(60);
    expect(compactContext(history, 64, 3, messages => messages.length < 10)).toHaveLength(9);
    expect(() => compactContext(history, 8)).toThrow('recent turns exceed');
    expect(estimateContextTokens(recent)).toBeGreaterThan(JSON.stringify(recent).length);
  });
  it('retains verified references and request deduplication when compacting the model prompt', async () => {
    const { runner, provider } = setup([response()], { maxHistoryMessages: 10 });
    const first = await setup([response([create]), response()]).runner.run('Crea', context);
    const history = Array.from({ length: 20 }, (_, index) => turn(index)).flat();
    const previous = { ...first.conversation, history };
    const result = await runner.run('Consulta', { ...context, requestId: 'next' }, previous);
    expect(provider.requests[0]?.messages.length).toBeLessThan(12);
    expect(JSON.stringify(provider.requests[0]?.messages[0])).toContain(id);
    expect(result.conversation.history).toHaveLength(62);
    expect(result.conversation.references).toEqual(previous.references);
    expect(result.conversation.handledRequestIds).toEqual(['request', 'next']);
  });
});

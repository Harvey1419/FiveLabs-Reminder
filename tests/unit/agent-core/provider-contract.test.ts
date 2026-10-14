import { describe, expect, it } from 'vitest';
import { aiResponseSchema, aiTranscriptSchema, type AIMessage, type AIResponse } from '@templelabs/contracts';
import { MockAIProvider, type CompletionRequest } from '@templelabs/ai';
import { selectEngine } from '@templelabs/agent-core';
import { reminderContinuity } from '../../fixtures/agent-core/reminder-continuity.js';

const reply: AIResponse = {
  message: { role: 'assistant', content: 'Listo.', toolCalls: [] },
  stopReason: 'completed', usage: { inputTokens: 20, outputTokens: 4 },
};
function request(messages: readonly AIMessage[] = [{ role: 'user', content: 'Hola' }]): CompletionRequest {
  return { messages, tools: [], maxOutputTokens: 100, deadlineMs: 200, signal: new AbortController().signal };
}

describe('provider-neutral continuation protocol', () => {
  it.each(reminderContinuity)('pairs the $name call with the same result identity', async fixture => {
    const call: AIResponse = {
      message: {
        role: 'assistant', content: '',
        toolCalls: [{ id: `call-${fixture.name}`, name: fixture.tool, arguments: fixture.arguments }],
      },
      stopReason: 'tool_calls', usage: { inputTokens: 30, outputTokens: 10 },
    };
    const provider = new MockAIProvider([{ response: call }, {
      response: reply,
      inspect: captured => expect(captured.messages.at(-1)).toMatchObject({
        role: 'tool', toolCallId: `call-${fixture.name}`, content: fixture.result,
      }),
    }], () => 100);
    const initial = request([{ role: 'user', content: fixture.prompt }]);
    const first = await provider.complete(initial);
    const final = await provider.complete(request([
      ...initial.messages, first.message,
      { role: 'tool', toolCallId: `call-${fixture.name}`, content: fixture.result, isError: false },
    ]));
    expect(final).toEqual(reply);
    expect(provider.remainingSteps).toBe(0);
    expect(provider.requests).toHaveLength(2);
    await expect(provider.complete(initial)).rejects.toThrow('sequence exhausted');
  });

  it('rejects orphan results and unresolved, duplicate or interrupted calls', () => {
    const assistant: AIMessage = {
      role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'task_read', arguments: {} }],
    };
    const result: AIMessage = { role: 'tool', toolCallId: 'call-1', content: {}, isError: false };
    const invalid: AIMessage[][] = [
      [result], [assistant], [assistant, result, result],
      [assistant, { role: 'user', content: 'Otra cosa' }, result],
      [assistant, result, assistant, result],
    ];
    for (const transcript of invalid) expect(aiTranscriptSchema.safeParse(transcript).success).toBe(false);
    expect(aiTranscriptSchema.safeParse([assistant, result]).success).toBe(true);
  });

  it('accepts all results from one assistant batch in either result order', () => {
    expect(aiTranscriptSchema.safeParse([
      { role: 'assistant', content: '', toolCalls: [
        { id: 'a', name: 'task_read', arguments: {} }, { id: 'b', name: 'calendar_read', arguments: {} },
      ] },
      { role: 'tool', toolCallId: 'b', content: [], isError: false },
      { role: 'tool', toolCallId: 'a', content: [], isError: false },
    ]).success).toBe(true);
  });

  it('rejects conflicting stop reasons, duplicate call IDs and malformed wire data', () => {
    expect(aiResponseSchema.safeParse({ ...reply, stopReason: 'tool_calls' }).success).toBe(false);
    expect(aiResponseSchema.safeParse({ ...reply, usage: { inputTokens: -1, outputTokens: 2 } }).success).toBe(false);
    const call = { id: 'a', name: 'task_read', arguments: {} };
    expect(aiResponseSchema.safeParse({
      ...reply, stopReason: 'tool_calls', message: { ...reply.message, toolCalls: [call, call] },
    }).success).toBe(false);
  });
});

describe('network-free scripted provider boundaries', () => {
  it('does not consume a response for an aborted or expired request', async () => {
    const provider = new MockAIProvider([{ response: reply }], () => 100);
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(provider.complete({ ...request(), signal: controller.signal })).rejects.toThrow('cancelled');
    await expect(provider.complete({ ...request(), deadlineMs: 100 })).rejects.toThrow('deadline');
    expect(provider.remainingSteps).toBe(1);
    expect(provider.requests).toHaveLength(0);
  });

  it('surfaces scripted failures and rejects replies above the output budget', async () => {
    const provider = new MockAIProvider([{ response: new Error('synthetic outage') }, { response: reply }], () => 100);
    await expect(provider.complete(request())).rejects.toThrow('synthetic outage');
    await expect(provider.complete({ ...request(), maxOutputTokens: 1 })).rejects.toThrow('token budget');
    expect(provider.remainingSteps).toBe(0);
  });

  it('keeps recorded requests and scripted responses independent from caller mutation', async () => {
    const provider = new MockAIProvider([{ response: reply }], () => 100);
    const input = request();
    const output = await provider.complete(input);
    output.message.content = 'changed';
    const snapshot = provider.requests[0];
    if (!snapshot) throw new Error('Missing request snapshot');
    const message = snapshot.messages[0];
    if (!message || message.role !== 'user') throw new Error('Missing user message');
    message.content = 'changed';
    expect(provider.requests[0]?.messages[0]).toEqual({ role: 'user', content: 'Hola' });
    expect(reply.message.content).toBe('Listo.');
  });
});

describe('cohort admission and active-run rollback', () => {
  const userIds = new Set(['user-canary']);
  it('requires both the global gate and authenticated cohort membership', () => {
    expect(selectEngine('user-canary', { enabled: false, userIds })).toBe('legacy');
    expect(selectEngine('user-other', { enabled: true, userIds })).toBe('legacy');
    expect(selectEngine('user-canary', { enabled: true, userIds })).toBe('v2');
    expect(() => selectEngine('', { enabled: true, userIds })).toThrow('Authenticated');
  });
  it('keeps active run ownership when admission changes in either direction', () => {
    expect(selectEngine('user-canary', { enabled: false, userIds }, 'v2')).toBe('v2');
    expect(selectEngine('user-canary', { enabled: true, userIds }, 'legacy')).toBe('legacy');
  });
});

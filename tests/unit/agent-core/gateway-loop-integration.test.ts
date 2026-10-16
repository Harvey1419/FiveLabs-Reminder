import { describe, expect, it, vi } from 'vitest';
import { OpenRouterProvider, AIProviderError, MockAIProvider, type AIProvider } from '@templelabs/ai';
import { ProductivityTurnRunner } from '@templelabs/agent-core';
import { createTaskTools, ToolRegistry } from '@templelabs/tools';
import { productivityCheckpointSchema } from '@templelabs/contracts';
import { withTurnLease } from '../../../src/agent/core/turn-lease.js';
import { createLegacyTaskPort } from '../../../src/adapters/agent-core/legacy-tasks.js';
import { DurableProductivityAssistant } from '../../../src/adapters/agent-core/durable-productivity-assistant.js';
import { setup, context, taskId, taskCreate, response } from './productivity-fixtures.js';

const routes = [{ id: 'primary', model: 'fixture/primary', providers: ['primary'], timeoutMs: 1000 },
  { id: 'secondary', model: 'fixture/secondary', providers: ['secondary'], timeoutMs: 1000 }];
function raw(name?: string, args = {}) {
  return { choices: [{ message: { role: 'assistant', content: name ? null : 'Listo, quedó completada.',
    ...(name ? { tool_calls: [{ id: 'local', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : {}) },
  finish_reason: name ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 10 } };
}
function runner(provider: AIProvider, execute: ReturnType<typeof setup>['execute']) {
  return new ProductivityTurnRunner(provider, new ToolRegistry(createTaskTools(createLegacyTaskPort({
    id: context.userId, timezone: context.timezone,
  }, execute))), { continuation: 'observation_driven', authorizeWrite: async () => true, now: () => 100 });
}
describe('native gateway through the shared loop and durable boundary', () => {
  it('fails over once, reads/completes the observed task and narrates only verified outcomes', async () => {
    const s = setup();
    const responses = [
      { error: {}, usage: { prompt_tokens: 5, completion_tokens: 2 } },
      raw('task_read'), raw('task_complete', { taskId }), raw(),
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const stored = productivityCheckpointSchema.parse(s.snapshot().agentCoreProductivity);
      if (responses.length === 2) {
        expect(stored.effects[0]?.item?.status).toBe('success');
        expect(body.messages.some((message: { role: string; tool_call_id?: string }) => message.role === 'tool' && message.tool_call_id === 'call_0')).toBe(true);
        expect(s.send).not.toHaveBeenCalled();
      }
      return new Response(JSON.stringify(responses.shift()), { status: responses.length === 3 ? 429 : 200 });
    });
    const provider = new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch, now: () => 100 });
    const assistant = new DurableProductivityAssistant(runner(provider, s.execute), { send: s.send });
    const result = await withTurnLease(s.lease, () => assistant.handle('Busca la propuesta y complétala', context, 'thread'));
    expect(result.conversation.tasks[0]?.status).toBe('completed');
    expect(result.usage).toMatchObject({ modelSteps: 3, inputTokens: 95, outputTokens: 32, accountingComplete: true });
    expect(fetch.mock.calls.map(call => JSON.parse(String(call[1]?.body)).model))
      .toEqual(['fixture/primary', 'fixture/secondary', 'fixture/secondary', 'fixture/secondary']);
    expect(result.reply.text).toContain('Listo.');
    expect(result.reply.text).not.toContain('Listo, quedó completada.');
    expect(result.conversation.history.at(-1)?.content).toBe(result.reply.text);
    const checkpoint = productivityCheckpointSchema.parse(s.snapshot().agentCoreProductivity);
    expect(checkpoint.completed?.conversation.history).toEqual(result.conversation.history);
    expect(checkpoint.phase).toBe('completed');
  });
  it('preserves a completed effect when the next provider step loses usage, without another write or resend', async () => {
    const s = setup();
    const responses = [raw('task_create', { title: 'Propuesta', scheduleReminder: false }), { choices: [], usage: null }];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(responses.shift()), { status: 200 }));
    const provider = new OpenRouterProvider({ apiKey: 'fixture-key', routes, fetch, now: () => 100 });
    const assistant = new DurableProductivityAssistant(runner(provider, s.execute), { send: s.send });
    const result = await withTurnLease(s.lease, () => assistant.handle('Crea propuesta y continúa', context, 'thread'));
    expect(result.usage).toMatchObject({ inputTokens: 30, outputTokens: 10, accountingComplete: false, estimatedCostUsd: null });
    expect(result.uiPayload.notices).toEqual(['provider_unavailable']);
    expect(result.reply.text).toContain('Tarea creada'); expect(result.reply.text).toContain('Propuesta');
    expect(s.execute).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(2);
    expect(productivityCheckpointSchema.parse(s.snapshot().agentCoreProductivity).phase).toBe('completed');
  });
  it('keeps known exhausted-attempt usage and reports unknown accounting honestly', async () => {
    const s = setup();
    const provider: AIProvider = { capabilities: { toolCalling: true, structuredOutput: false },
      complete: vi.fn(async () => { throw new AIProviderError('UNVERIFIED_USAGE', { inputTokens: 45, outputTokens: 8 }, false); }) };
    const result = await runner(provider, s.execute).run('Crea', context, undefined, {
      beforeDispatch: vi.fn(), afterOutcome: vi.fn(),
    });
    expect(result.usage).toMatchObject({ inputTokens: 45, outputTokens: 8, accountingComplete: false, estimatedCostUsd: null });
    expect(s.execute).not.toHaveBeenCalled();
  });
  it('starts one provider scope for all model steps and a fresh scope for the next independent run', async () => {
    const s = setup();
    const factory = vi.fn(() => new MockAIProvider([{ response: response([taskCreate]) }, { response: response() }], () => 100));
    const provider: AIProvider = { capabilities: { toolCalling: true, structuredOutput: false }, forTurn: factory,
      complete: vi.fn(async () => { throw new Error('Root provider must not complete'); }) };
    const r = runner(provider, s.execute);
    const journal = { beforeDispatch: vi.fn(async () => {}), afterOutcome: vi.fn(async () => {}) };
    await r.run('Crea', context, undefined, journal);
    await r.run('Crea otra vez', { ...context, requestId: 'second', runId: 'second-run' }, undefined, journal);
    expect(factory).toHaveBeenCalledTimes(2); expect(provider.complete).not.toHaveBeenCalled();
    expect(s.execute).toHaveBeenCalledTimes(2);
  });
});

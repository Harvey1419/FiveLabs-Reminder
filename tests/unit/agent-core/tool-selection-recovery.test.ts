import { describe, expect, it, vi } from 'vitest';
import { OpenRouterProvider, type OpenRouterAttempt } from '@templelabs/ai';
import { ProductivityTurnRunner } from '@templelabs/agent-core';
import { createTaskTools, ToolRegistry } from '@templelabs/tools';
import { aiTranscriptSchema } from '@templelabs/contracts';
import { createLegacyTaskPort } from '../../../src/adapters/agent-core/legacy-tasks.js';
import { setup, context } from './productivity-fixtures.js';

function rejection(name: string) {
  return { id: 'gen-rejected', error: { code: 502,
    message: `Upstream error from Groq: Tool call validation failed: tool call validation failed: attempted to call tool '${name}' which was not in request.tools`,
    // Deliberately untrusted: rejected arguments must never reach execution.
    metadata: { failed_generation: '{"title":"Do not execute this"}' } } };
}
const created = { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'create', type: 'function',
  function: { name: 'task_create', arguments: JSON.stringify({ title: 'Propuesta', turnDisposition: 'finish' }) } }] },
finish_reason: 'tool_calls' }], usage: { prompt_tokens: 30, completion_tokens: 10 } };

function harness(responses: unknown[], options: ConstructorParameters<typeof ProductivityTurnRunner>[2] = {}) {
  const s = setup();
  const attempts: OpenRouterAttempt[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    if (!responses.length) throw new Error('Unexpected inference');
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  });
  const provider = new OpenRouterProvider({ apiKey: 'fixture-key', fetch, now: () => 100,
    estimateInputTokens: () => 100, onAttempt: attempt => attempts.push(attempt),
    routes: [{ id: 'primary', model: 'fixture/model', providers: ['groq'], timeoutMs: 1000 }] });
  const authorizeWrite = vi.fn(async () => true);
  const journal = { beforeDispatch: vi.fn(async () => {}), afterOutcome: vi.fn(async () => {}) };
  const runner = new ProductivityTurnRunner(provider, new ToolRegistry(createTaskTools(createLegacyTaskPort({
    id: context.userId, timezone: context.timezone,
  }, s.execute))), { continuation: 'observation_driven', discoverTools: true, initialTools: ['task_read'],
    finishWithVerifiedResults: true, now: () => 100, maxOutputTokens: 100, maxTotalTokens: 10000,
    estimateInputTokens: () => 100, authorizeWrite, ...options });
  return { ...s, fetch, attempts, authorizeWrite, journal,
    run: () => runner.run('Crea la tarea Propuesta', context, undefined, journal) };
}

describe('explicit provider schema rejection recovery', () => {
  it('loads the authorized schema, regenerates arguments, and executes once through authorization and journaling', async () => {
    const h = harness([rejection('task_create'), created], { pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } });
    const result = await h.run();
    expect(result.uiPayload.notices).toEqual([]);
    expect(result.uiPayload.items).toMatchObject([{ toolName: 'task_create', status: 'success' }]);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    const payloads = h.fetch.mock.calls.map(call => JSON.parse(String(call[1]?.body)));
    expect(payloads[0].tools.map((tool: { function: { name: string } }) => tool.function.name)).not.toContain('task_create');
    expect(payloads[1].tools.map((tool: { function: { name: string } }) => tool.function.name)).toContain('task_create');
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.authorizeWrite).toHaveBeenCalledTimes(1);
    expect(h.journal.beforeDispatch).toHaveBeenCalledTimes(1);
    expect(h.journal.afterOutcome).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.execute.mock.calls)).not.toContain('Do not execute');
    expect(result.usage).toMatchObject({ modelSteps: 2, inputTokens: 30, outputTokens: 10,
      accountingComplete: false, estimatedCostUsd: null });
    expect(h.attempts[0]).toMatchObject({ providerErrorCode: 502, usage: null });
    expect(aiTranscriptSchema.safeParse(result.conversation.history).success).toBe(true);
  });

  it.each(['foreign_tool', 'task_create'])('stops after a second rejection (%s), without dispatching either decision', async name => {
    const h = harness([rejection('task_create'), rejection(name), created]);
    expect((await h.run()).uiPayload.notices).toEqual(['provider_unavailable']);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.authorizeWrite).not.toHaveBeenCalled();
    expect(h.journal.beforeDispatch).not.toHaveBeenCalled();
  });

  it.each(['foreign_tool', 'task_read'])('does not recover unauthorized or already-loaded tools (%s)', async name => {
    const h = harness([rejection(name), created]);
    expect((await h.run()).uiPayload.notices).toEqual(['provider_unavailable']);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('does not turn an arbitrary 502 or missing usage into a safe retry', async () => {
    const h = harness([{ id: 'gen-unknown', error: { code: 502, message: 'Upstream disconnected' } }, created]);
    expect((await h.run()).uiPayload.notices).toEqual(['provider_unavailable']);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('keeps the lease authorization gate on the regenerated write', async () => {
    const h = harness([rejection('task_create'), created]);
    h.authorizeWrite.mockResolvedValue(false);
    const result = await h.run();
    expect(result.uiPayload.items).toMatchObject([{ status: 'approval_required' }]);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('charges the opaque attempt reservation to the total-token guard before recovery', async () => {
    const h = harness([rejection('task_create'), created], { maxTotalTokens: 250 });
    expect((await h.run()).uiPayload.notices).toEqual(['limit_reached']);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('does not exceed the configured model step limit', async () => {
    const h = harness([rejection('task_create'), created], { maxModelSteps: 1 });
    expect((await h.run()).uiPayload.notices).toEqual(['limit_reached']);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('reserves opaque inference cost without claiming measured spend', async () => {
    const h = harness([rejection('task_create'), created], {
      maxCostUsd: 0.00025, pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
    });
    const result = await h.run();
    expect(result.uiPayload.notices).toEqual(['limit_reached']);
    expect(result.usage).toMatchObject({ accountingComplete: false, estimatedCostUsd: null });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.execute).not.toHaveBeenCalled();
  });
});

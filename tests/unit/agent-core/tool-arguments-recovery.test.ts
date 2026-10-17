import { describe, expect, it, vi } from 'vitest';
import { OpenRouterProvider, type OpenRouterAttempt } from '@templelabs/ai';
import { ProductivityTurnRunner } from '@templelabs/agent-core';
import { createTaskTools, ToolRegistry } from '@templelabs/tools';
import { createLegacyTaskPort } from '../../../src/adapters/agent-core/legacy-tasks.js';
import { context, setup } from './productivity-fixtures.js';

const rejected = (name = 'task_create') => ({ id: 'rejected', error: { code: 502,
  message: `Tool call validation failed: parameters for tool ${name} did not match schema: errors: PRIVATE_VENDOR_DETAILS`,
  metadata: { failed_generation: '{"title":"NEVER_EXECUTE_REJECTED_ARGUMENTS"}' } } });
const reply = (name?: string) => ({ choices: [{ message: { role: 'assistant', content: name ? '' : 'Listo.',
  ...(name ? { tool_calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(name === 'task_create'
    ? { title: 'Propuesta' } : { status: 'pending' }) } }] } : {}) }, finish_reason: name ? 'tool_calls' : 'stop' }],
  usage: { prompt_tokens: 30, completion_tokens: 10 } });
function harness(responses: unknown[], total = 10000) {
  const s = setup(), attempts: OpenRouterAttempt[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(responses.shift()), { status: 200 }));
  const provider = new OpenRouterProvider({ apiKey: 'fixture-key', fetch, now: () => 100, estimateInputTokens: () => 100,
    routes: [{ id: 'primary', model: 'fixture/model', providers: ['groq'], timeoutMs: 1000 }], onAttempt: attempt => attempts.push(attempt) });
  const runner = new ProductivityTurnRunner(provider, new ToolRegistry(createTaskTools(createLegacyTaskPort({ id: context.userId, timezone: context.timezone }, s.execute))),
    { nativeToolCalling: true, continuation: 'observation_driven', now: () => 100, maxInputTokens: 1000, maxOutputTokens: 100,
      maxTotalTokens: total, estimateInputTokens: () => 100, authorizeWrite: async () => true });
  const journal = { beforeDispatch: vi.fn(async () => {}), afterOutcome: vi.fn(async () => {}) };
  return { ...s, fetch, attempts, journal, run: () => runner.run('Crea Propuesta y consulta mis tareas pendientes.', context, undefined, journal) };
}
describe('bounded native tool argument recovery', () => {
  it('preserves reported usage when the provider meters its rejected inference', async () => {
    const f = harness([{ ...rejected(), usage: { prompt_tokens: 30, completion_tokens: 10 } }, reply('task_create'), reply()]);
    const result = await f.run();
    expect(result.usage.accountingComplete).toBe(true);
    expect(result.usage.inputTokens).toBe(90);
    expect(result.usage.outputTokens).toBe(30);
    expect(f.execute).toHaveBeenCalledOnce();
  });
  it('requests fresh valid arguments without executing rejected data or claiming complete accounting', async () => {
    const f = harness([rejected(), reply('task_create'), reply()]);
    const result = await f.run();
    expect(result.uiPayload.notices).toEqual([]);
    expect(result.uiPayload.items).toMatchObject([{ toolName: 'task_create', status: 'success' }]);
    expect(f.execute).toHaveBeenCalledOnce(); expect(f.journal.beforeDispatch).toHaveBeenCalledOnce();
    expect(result.usage.accountingComplete).toBe(false);
    const second = JSON.parse(String(f.fetch.mock.calls[1]![1]!.body));
    expect(JSON.stringify(second)).toContain('Arguments for task_create did not match');
    expect(JSON.stringify(second)).not.toMatch(/PRIVATE_VENDOR_DETAILS|NEVER_EXECUTE_REJECTED_ARGUMENTS/);
    expect(f.attempts[0]).toMatchObject({ failureClass: 'tool_arguments_rejection', rejectedToolName: 'task_create', usage: null });
  });
  it('preserves a prior confirmed write while correcting a later read', async () => {
    const f = harness([reply('task_create'), rejected('task_read'), reply('task_read'), reply()]);
    const result = await f.run();
    expect(result.uiPayload.notices).toEqual([]);
    expect(result.uiPayload.items.map(i => i.toolName)).toEqual(['task_create', 'task_read']);
    expect(f.journal.beforeDispatch).toHaveBeenCalledTimes(2);
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(f.execute.mock.calls.filter(call => call[0].params.action === 'create')).toHaveLength(1);
  });
  it('stops after one correction attempt', async () => {
    const f = harness([rejected(), rejected(), reply('task_create')]);
    const result = await f.run();
    expect(result.uiPayload.notices).toEqual(['provider_unavailable']);
    expect(f.fetch).toHaveBeenCalledTimes(2); expect(f.execute).not.toHaveBeenCalled();
  });
  it('charges the rejected inference reservation against the remaining token budget', async () => {
    const f = harness([rejected(), reply('task_create')], 250);
    const result = await f.run();
    expect(result.uiPayload.notices).toEqual(['limit_reached']);
    expect(f.fetch).toHaveBeenCalledOnce(); expect(f.execute).not.toHaveBeenCalled();
    expect(result.usage.accountingComplete).toBe(false);
  });
  it.each(['generic', 'foreign', 'ambiguous', 'hasChoices'])('does not recover an unsafe %s rejection', async kind => {
    const raw: Record<string, unknown> = rejected(kind === 'foreign' ? 'foreign_tool' : 'task_create');
    if (kind === 'generic') raw.error = { code: 502, message: 'Upstream unavailable' };
    if (kind === 'ambiguous') (raw.error as { message: string }).message += ' parameters for tool task_read did not match schema';
    if (kind === 'hasChoices') raw.choices = [];
    const f = harness([raw, reply('task_create')]);
    expect((await f.run()).uiPayload.notices).toEqual(['provider_unavailable']);
    expect(f.fetch).toHaveBeenCalledOnce(); expect(f.execute).not.toHaveBeenCalled();
  });
});

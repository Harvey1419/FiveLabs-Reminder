import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { OpenRouterProvider, estimateBoundedInput, type OpenRouterAttempt } from '@templelabs/ai';
import { ProductivityTurnRunner } from '@templelabs/agent-core';
import { createTaskTools, createReminderTools, createCalendarTools, ToolRegistry, type ReminderDomainPort } from '@templelabs/tools';
import { aiTranscriptSchema, jsonObjectSchema } from '@templelabs/contracts';
import { createLegacyTaskPort } from '../../../src/adapters/agent-core/legacy-tasks.js';
import { setup, context } from './productivity-fixtures.js';
import { recentToolScope } from '../../../src/adapters/agent-core/recent-tool-scope.js';
import { productivityBudget } from '../../../src/adapters/agent-core/productivity-budget.js';

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
  it.each([
    "Tool call validation failed: attempted to call tool 'task_create' which was not in request.tools.",
    'Provider returned error: Attempted to call tool "task_create" which was not in request.tools (validation rejected).',
    "upstream: attempted\n to call tool 'task_create' which was not\n in request.tools; no calls returned",
  ])('recognizes explicit rejections independently of provider prefix and trailing details: %s', async message => {
    const rejected = rejection('task_create'); rejected.error.message = message;
    const h = harness([rejected, created]);
    expect((await h.run()).uiPayload.notices).toEqual([]);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it('does not guess a selection from ambiguous rejection names', async () => {
    const rejected = rejection('task_create');
    rejected.error.message += " attempted to call tool 'task_read' which was not in request.tools";
    const h = harness([rejected, created]);
    expect((await h.run()).uiPayload.notices).toEqual(['provider_unavailable']);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.execute).not.toHaveBeenCalled();
  });
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
    expect(h.attempts[0]).toMatchObject({ providerErrorCode: 502, usage: null, failureClass: 'unadvertised_tool_rejection' });
    expect(h.attempts).toHaveLength(2);
    expect(h.attempts[1]).not.toHaveProperty('failureClass');
    expect(aiTranscriptSchema.safeParse(result.conversation.history).success).toBe(true);
  });

  it.each(['foreign_tool', 'task_create'])('stops after a second rejection (%s), without dispatching either decision', async name => {
    const h = harness([rejection('task_create'), rejection(name), created]);
    expect((await h.run()).uiPayload.notices).toEqual(['provider_unavailable']);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.attempts.map(attempt => attempt.failureClass)).toEqual([
      'unadvertised_tool_rejection', name === 'task_create' ? 'provider_error' : 'unadvertised_tool_rejection',
    ]);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.authorizeWrite).not.toHaveBeenCalled();
    expect(h.journal.beforeDispatch).not.toHaveBeenCalled();
    expect(h.journal.afterOutcome).not.toHaveBeenCalled();
  });

  it.each(['foreign_tool', 'task_read'])('does not recover unauthorized or already-loaded tools (%s)', async name => {
    const h = harness([rejection(name), created]);
    expect((await h.run()).uiPayload.notices).toEqual(['provider_unavailable']);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('does not turn an arbitrary 502 or missing usage into a safe retry', async () => {
    const h = harness([{ id: 'gen-unknown', error: { code: 502, message: 'Upstream disconnected' } }, created]);
    const result = await h.run();
    expect(result.uiPayload.notices).toEqual(['provider_unavailable']);
    expect(result.usage.accountingComplete).toBe(false);
    expect(h.attempts).toMatchObject([{ failureClass: 'provider_error', providerErrorCode: 502, usage: null }]);
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
    const onLimit = vi.fn();
    const h = harness([rejection('task_create'), created], { maxTotalTokens: 250, onLimit });
    expect((await h.run()).uiPayload.notices).toEqual(['limit_reached']);
    expect(onLimit).toHaveBeenCalledExactlyOnceWith({ reason: 'total_tokens' });
    expect(h.attempts).toMatchObject([{ failureClass: 'unadvertised_tool_rejection', usage: null }]);
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

describe('proactive initial scope through the native provider', () => {
  it('executes two reminders in one model step after calendar/reminder reads without recovery', async () => {
    const s = setup();
    const scopedContext = { ...context, capabilities: new Set([...context.capabilities, 'reminders.read']) };
    let recordCount = 0;
    const execute = vi.fn<ReminderDomainPort['execute']>(async (request, ctx, operationId) => {
      if (request.operation !== 'create') throw new Error('Unexpected read');
      const records = [{ id: `22222222-2222-4222-8222-${String(++recordCount).padStart(12, '0')}`,
        content: request.input.content, sendAt: request.input.targetTimeIso, recurrence: null,
        isAdvanceNotice: false, parentReminderId: null, requiresConfirmation: false, acknowledgedAt: null }];
      const data = { operation: 'create' as const, records, complete: true, coverage: 'operation' as const,
        rejections: [], presentation: { canonicalCard: null, questions: [], cta: null } };
      return { status: 'success' as const, data, observation: JSON.stringify(data),
        receipt: { userId: ctx.userId, operationId, toolName: 'reminder_create', resourceIds: records.map(row => row.id) } };
    });
    const registry = new ToolRegistry([
      ...createReminderTools({ execute }),
      ...createTaskTools(createLegacyTaskPort({ id: context.userId, timezone: context.timezone }, s.execute)),
      ...createCalendarTools({ execute: async () => { throw new Error('Unexpected calendar action'); } }),
    ]);
    const previous = { userId: context.userId, history: [
      { role: 'user' as const, content: 'Consulta anterior.' },
      { role: 'assistant' as const, content: '', toolCalls: [
        { id: 'calendar', name: 'calendar_read', arguments: {} }, { id: 'reminders', name: 'reminder_read', arguments: {} },
      ] },
      { role: 'tool' as const, toolCallId: 'calendar', content: { status: 'success' }, isError: false },
      { role: 'tool' as const, toolCallId: 'reminders', content: { status: 'success' }, isError: false },
    ], tasks: [], reminders: [], events: [], handledRequestIds: [] };
    const attempts: OpenRouterAttempt[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const payload = JSON.parse(String(init?.body));
      expect(payload.tools.map((tool: { function: { name: string } }) => tool.function.name))
        .toEqual(expect.arrayContaining(['task_create', 'reminder_create']));
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [
        { id: 'leave', type: 'function', function: { name: 'reminder_create', arguments: JSON.stringify({ content: 'Salir', delayMinutes: 10, turnDisposition: 'continue' }) } },
        { id: 'arrival', type: 'function', function: { name: 'reminder_create', arguments: JSON.stringify({ content: 'Llegada del aeropuerto', targetTimeIso: '2026-10-12T01:00:00Z', turnDisposition: 'finish' }) } },
      ] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1000, completion_tokens: 100 } }));
    });
    const provider = new OpenRouterProvider({ apiKey: 'fixture-key', routes: [{ id: 'primary', model: 'fixture/model', providers: ['groq'], timeoutMs: 1000 }],
      fetch, estimateInputTokens: estimateBoundedInput, onAttempt: attempt => attempts.push(attempt) });
    const journal = { beforeDispatch: vi.fn(async () => {}), afterOutcome: vi.fn(async () => {}) };
    const requestSchema = z.object({ messages: aiTranscriptSchema, tools: z.array(z.object({
      name: z.string(), description: z.string(), inputSchema: jsonObjectSchema,
    })) });
    const result = await new ProductivityTurnRunner(provider, registry, { ...productivityBudget,
      initialTools: recentToolScope(previous.history, registry.available(scopedContext).map(tool => tool.name), productivityBudget.initialTools),
      continuation: 'observation_driven', discoverTools: true, compactObservations: true, maxModelSteps: 1,
      estimateInputTokens: input => provider.estimateNativeInput(requestSchema.parse(input)),
      authorizeWrite: async () => true,
    }).run('Recuérdame salir en 10 minutos y la llegada del aeropuerto a las 8.', scopedContext, previous, journal);
    expect(result.uiPayload.notices).toEqual([]);
    expect(result.uiPayload.items.map(item => item.status)).toEqual(['success', 'success']);
    expect(result.usage).toMatchObject({ modelSteps: 1, accountingComplete: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(journal.beforeDispatch).toHaveBeenCalledTimes(2);
    expect(journal.afterOutcome).toHaveBeenCalledTimes(2);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.providerErrorCode).toBeUndefined();
  });
});

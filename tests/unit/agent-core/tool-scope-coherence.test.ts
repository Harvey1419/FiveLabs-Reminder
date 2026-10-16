import { describe, expect, it, vi } from 'vitest';
import { MockAIProvider, ToolSelectionError, OpenRouterProvider } from '@templelabs/ai';
import type { AIProvider, CompletionRequest } from '@templelabs/ai';
import { createReminderTools, createTaskTools, createAgendaTools, ToolRegistry, type ReminderDomainPort } from '@templelabs/tools';
import { ProductivityTurnRunner } from '../../../packages/agent-core/src/productivity-turn.js';
import { AgentLoop, type AgentLoopOptions, type AgentLoopPolicy } from '../../../packages/agent-core/src/agent-loop.js';
import { context, response, reminderCreate, reminderId, setup } from './productivity-fixtures.js';
import { createLegacyTaskPort } from '../../../src/adapters/agent-core/legacy-tasks.js';

function guidance(options: AgentLoopOptions & { compactObservations?: boolean } = {}, failure?: 'failed' | 'indeterminate', sibling = false) {
  const create = { ...reminderCreate, arguments: { ...reminderCreate.arguments, turnDisposition: 'continue' } };
  const provider = new MockAIProvider([response(sibling ? [create, { ...create, id: 'sibling', arguments: { ...create.arguments, content: 'Second reminder' } }] : [create]), response([])].map(response => ({ response })), () => 100);
  let calls = 0;
  const execute = vi.fn<ReminderDomainPort['execute']>(async (request, ctx, operationId) => {
    calls++;
    if (failure && (!sibling || calls === 2)) return failure === 'failed'
      ? { status: 'failed', code: 'FIXTURE_FAILED', observation: 'failed' }
      : { status: 'indeterminate', operationId, observation: 'uncertain' };
    const data = { operation: request.operation, complete: true, coverage: 'operation' as const,
      records: [{ id: reminderId, content: 'Prepare', sendAt: '2026-10-11T21:00:00Z', recurrence: null,
        isAdvanceNotice: false, parentReminderId: null, requiresConfirmation: false, acknowledgedAt: null }],
      rejections: [], presentation: { canonicalCard: null, questions: [], cta: null } };
    return { status: 'success', data, observation: JSON.stringify(data), receipt: { userId: ctx.userId, operationId,
      toolName: `reminder_${request.operation}`, resourceIds: [reminderId] } };
  });
  const runner = new ProductivityTurnRunner(provider, new ToolRegistry(createReminderTools({ execute })), {
    continuation: 'observation_driven', finishWithVerifiedResults: true, now: () => 100, authorizeWrite: async () => true, ...options });
  const journal = { beforeDispatch: vi.fn(async () => {}), afterOutcome: vi.fn(async () => {}) };
  return { provider, execute, journal, run: () => runner.run('Create first; second needs a date', context, undefined, journal) };
}
const system = (request: Pick<CompletionRequest, 'messages'>) => request.messages.filter(m => m.role === 'system').map(m => m.content).join(' ');

describe('S2 current-decision guidance', () => {
  it.each([false, true])('names the reserved channel only after verified advertisement (compact %s)', async compactObservations => {
    const h = guidance({ compactObservations });
    await h.run();
    expect(h.provider.requests).toHaveLength(2);
    for (const request of h.provider.requests) {
      const advertised = request.tools.some(t => t.name === 'conversation_clarify');
      expect(system(request).includes('conversation_clarify')).toBe(advertised);
      expect(system(request)).toContain('never repeat');
    }
    expect(system(h.provider.requests[0]!)).toContain('continue');
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.journal.afterOutcome).toHaveBeenCalledOnce();
  });
  it.each(['failed', 'indeterminate'] as const)('does not name a suppressed channel after %s', async failure => {
    const h = guidance({}, failure, failure === 'failed');
    await h.run();
    for (const request of h.provider.requests) expect(system(request)).not.toContain('conversation_clarify');
  });
  it('keeps budget fallback executable guidance coherent', async () => {
    const h = guidance({ compactObservations: true, estimateInputTokens: input => {
      const request = input as CompletionRequest;
      return system(request).includes('You are Hermes, a personal assistant.') ? 100 : 2000;
    }, maxInputTokens: 1000 });
    await h.run();
    expect(h.provider.requests).toHaveLength(2);
    expect(system(h.provider.requests[0]!)).toContain('You are Hermes, a personal assistant.');
    for (const request of h.provider.requests) {
      expect(system(request).includes('conversation_clarify')).toBe(request.tools.some(t => t.name === 'conversation_clarify'));
      expect(system(request).includes('tools_select')).toBe(request.tools.some(t => t.name === 'tools_select'));
    }
  });
  it.each([false, true])('distinguishes selectable agenda schemas from directly advertised tools (executable %s)', async executable => {
    for (const loaded of [false, true]) {
      const provider = new MockAIProvider([{ response: response([]) }], () => 100);
      const registry = new ToolRegistry(createAgendaTools(new ToolRegistry([])));
      const runner = new ProductivityTurnRunner(provider, registry, { continuation: 'observation_driven', discoverTools: true,
        initialTools: loaded ? ['agenda_read'] : [], compactObservations: true, now: () => 100, maxInputTokens: 1000,
        estimateInputTokens: input => !executable || system(input as CompletionRequest).includes('You are Hermes, a personal assistant.') ? 100 : 2000 });
      await runner.run('What is planned?', { ...context, capabilities: new Set([...context.capabilities, 'agenda.read']) });
      const request = provider.requests[0]!;
      expect(request.tools.map(t => t.name)).toEqual([loaded ? 'agenda_read' : 'tools_select']);
      expect(system(request)).toContain(loaded ? 'General agenda questions require agenda_read' : 'select agenda_read through tools_select');
      expect(system(request).includes('tools_select')).toBe(!loaded);
      expect(system(request)).not.toContain('conversation_clarify');
    }
  });
  it('does not instruct selection when discovery is enabled but all schemas are loaded', async () => {
    const h = guidance({ discoverTools: true, initialTools: ['reminder_create'] });
    await h.run();
    for (const request of h.provider.requests) if (!request.tools.some(t => t.name === 'tools_select')) expect(system(request)).not.toContain('tools_select');
  });
});

function loopHarness(errors: (Error | null)[], options: AgentLoopOptions = {}, names = ['task_read', 'task_create'], synthetic = false) {
  const requests: CompletionRequest[] = [];
  const provider: AIProvider = { capabilities: { toolCalling: true, structuredOutput: true }, complete: vi.fn(async request => {
    requests.push(request);
    const error = errors.shift();
    if (error) throw error;
    return response([]);
  }) };
  const s = setup();
  const definitions = createTaskTools(createLegacyTaskPort({ id: context.userId, timezone: context.timezone }, s.execute));
  const registry = new ToolRegistry(synthetic ? names.map(name => ({ ...definitions[0]!, specification: { ...definitions[0]!.specification, name } })) : definitions);
  const policy: AgentLoopPolicy = { acceptsTool: name => names.includes(name), referenceMissing: () => false,
    writeJournalAvailable: true, prepareContext: history => [...history], requiresReconciliation: () => false,
    normalizeOutcome: (_call, outcome) => outcome, beforeDispatch: async () => {}, afterOutcome: async () => {} };
  const loop = new AgentLoop(provider, registry, { continuation: 'observation_driven', discoverTools: true,
    initialTools: ['task_read'], now: () => 100, estimateInputTokens: () => 100, ...options });
  return { requests, s, run: () => loop.run('Read', context, [], policy) };
}
describe('S3 safe selection events; unchanged recovery authority', () => {
  it.each([
    ['task_create', {}, 'reload_schema', 'authorized_schema', 2],
    ['conversation_clarify', {}, 'stop', 'reserved_control', 1],
    ['tools_select', {}, 'stop', 'reserved_control', 1],
    ['foreign', {}, 'stop', 'unknown_tool', 1],
    ['task_read', {}, 'stop', 'already_advertised', 1],
    ['task_create', { discoverTools: false }, 'stop', 'discovery_disabled', 1],
  ] as const)('classifies %s without changing execution', async (name, options, decision, reason, count) => {
    const onToolSelection = vi.fn();
    const h = loopHarness([new ToolSelectionError(name), null], { ...options, onToolSelection });
    const result = await h.run();
    expect(onToolSelection).toHaveBeenCalledOnce();
    expect(onToolSelection.mock.calls[0]![0]).toEqual({ rejectedToolName: name,
      advertisedToolNames: ('discoverTools' in options && options.discoverTools === false) ? ['task_create', 'task_read'] : ['tools_select', 'task_read'],
      advertisedToolsTruncated: false, decision, reason, accountingComplete: false });
    expect(h.requests).toHaveLength(count);
    expect(h.s.execute).not.toHaveBeenCalled();
    expect(result.usage.accountingComplete).toBe(false);
    expect(result.usage.estimatedCostUsd).toBeNull();
    expect(result.notices).toEqual(count === 2 ? [] : ['provider_unavailable']);
  });
  it('reports exhausted recovery, and isolates observer mutations and exceptions', async () => {
    const events: unknown[] = [];
    const error = new ToolSelectionError('task_create');
    const h = loopHarness([error, new ToolSelectionError('task_read')], { onToolSelection: event => {
      events.push(structuredClone(event));
      (event.advertisedToolNames as string[]).push('injected');
      throw new Error('observer failed');
    } });
    const result = await h.run();
    expect(events).toMatchObject([{ decision: 'reload_schema' }, { decision: 'stop', reason: 'recovery_exhausted' }]);
    expect(h.requests).toHaveLength(2);
    expect(h.requests.flatMap(r => r.tools.map(t => t.name))).not.toContain('injected');
    expect(error.toolName).toBe('task_create');
    expect(result.notices).toEqual(['provider_unavailable']);
  });
  it.each(['private content !', '', 'x'.repeat(65), 'safe\n', 'á', null])('filters invalid rejected identifier %j in diagnostics only', async value => {
    const error = new ToolSelectionError('foreign');
    Object.defineProperty(error, 'toolName', { value });
    const onToolSelection = vi.fn();
    const h = loopHarness([error], { onToolSelection });
    await h.run();
    expect(onToolSelection.mock.calls[0]?.[0]).toMatchObject({ rejectedToolName: null, reason: 'unknown_tool' });
    expect(h.requests).toHaveLength(1);
  });
  it('bounds and filters advertised identifiers without mutating request schemas', async () => {
    const names = ['bad name', ...Array.from({ length: 70 }, (_, i) => `safe_${i}`)];
    const onToolSelection = vi.fn();
    const h = loopHarness([new ToolSelectionError('foreign')], { discoverTools: false, onToolSelection }, names, true);
    await h.run();
    expect(onToolSelection.mock.calls[0]?.[0]).toEqual({ rejectedToolName: 'foreign', advertisedToolNames: names.slice(1, 65),
      advertisedToolsTruncated: true, decision: 'stop', reason: 'discovery_disabled', accountingComplete: false });
    expect(h.requests[0]!.tools.map(t => t.name)).toEqual(names);
  });
  it('does not recover after the deadline', async () => {
    let ticks = 0;
    const onToolSelection = vi.fn();
    const h = loopHarness([new ToolSelectionError('task_create')], { now: () => ++ticks < 3 ? 100 : 2000, timeoutMs: 1000, onToolSelection });
    const result = await h.run();
    expect(h.requests).toHaveLength(1);
    expect(onToolSelection.mock.calls[0]?.[0]).toMatchObject({ decision: 'stop', reason: 'turn_inactive' });
    expect(result.notices).toEqual(['provider_unavailable']);
  });
  it('does not report generic provider failures', async () => {
    const onToolSelection = vi.fn();
    const h = loopHarness([new Error('private failure')], { onToolSelection });
    await h.run();
    expect(onToolSelection).not.toHaveBeenCalled();
    expect(h.requests).toHaveLength(1);
  });
});

it.each(['task_read', 'conversation_clarify', 'unknown_tool'])('S4 mock wire rejection %s preserves unknown accounting and executes only fresh decisions', async name => {
  const s = setup();
  let attempts = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(++attempts === 1
    ? { error: { code: 502, message: `attempted to call tool '${name}' which was not in request.tools` } }
    : { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'read', type: 'function', function: { name: 'task_read', arguments: JSON.stringify({ turnDisposition: 'finish' }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 30, completion_tokens: 10 } }), { status: 200 }));
  const provider = new OpenRouterProvider({ apiKey: 'fixture-key', fetch, now: () => 100, estimateInputTokens: () => 100,
    routes: [{ id: 'offline', model: 'fixture/model', providers: ['fixture'], timeoutMs: 1000 }] });
  const onToolSelection = vi.fn();
  const runner = new ProductivityTurnRunner(provider, new ToolRegistry(createTaskTools(createLegacyTaskPort({ id: context.userId, timezone: context.timezone }, s.execute))), {
    continuation: 'observation_driven', discoverTools: true, initialTools: ['task_create'], finishWithVerifiedResults: true,
    now: () => 100, estimateInputTokens: () => 100, pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, onToolSelection });
  const result = await runner.run('Read tasks', context);
  expect(fetch).toHaveBeenCalledTimes(name === 'task_read' ? 2 : 1);
  expect(onToolSelection).toHaveBeenCalledOnce();
  expect(result.usage.accountingComplete).toBe(false);
  expect(result.usage.estimatedCostUsd).toBeNull();
  expect(result.uiPayload.items).toHaveLength(name === 'task_read' ? 1 : 0);
  expect(result.uiPayload.notices).toEqual(name === 'task_read' ? [] : ['provider_unavailable']);
});

import { describe, expect, it, vi } from 'vitest';
import { AgentLoop, ProductivityTurnRunner, type AgentLoopOptions, type AgentLoopPolicy } from '@templelabs/agent-core';
import { OpenRouterProvider, type CompletionRequest, type OpenRouterAttempt } from '@templelabs/ai';
import { ToolRegistry, createReminderTools, createAgendaTools } from '@templelabs/tools';
import type { TurnContext, JsonObject } from '@templelabs/contracts';
import { createSyntheticReminders, runConversation, safeAttempt, main, SYNTHETIC_USER } from '../../../scripts/evals/v2-fluent-conversation.js';
import { createBudgetedTransport } from '../../../scripts/evals/live-evaluation-budget.js';

const canary = vi.hoisted(() => ({ raw: [] as unknown[], fetches: 0, domain: vi.fn() }));
vi.mock('../../../src/adapters/agent-core/configured-ai-provider.js', () => ({ createConfiguredAIProvider: (options: { onAttempt: (attempt: OpenRouterAttempt) => void }) => new OpenRouterProvider({ apiKey: 'OFFLINE', routes: [{ id: 'offline', model: 'mock/model', providers: ['mock'], timeoutMs: 1000 }], estimateInputTokens: () => 1, onAttempt: options.onAttempt, fetch: async () => { canary.fetches++; return new Response(JSON.stringify(canary.raw.shift())); } }) }));
vi.mock('../../../src/infrastructure/database/index.js', () => ({ getUserSubscription: async () => null, hasProAccess: () => false }));
vi.mock('../../../src/features/memory/service.js', () => ({ retrieveRelevantMemories: async () => [], retrieveStandingPreferences: async () => [] }));
vi.mock('../../../src/adapters/agent-core/proactive-memory.js', () => ({ scheduleProactiveMemory: vi.fn() }));
vi.mock('../../../src/features/tasks/productivity-service.js', () => ({ createTaskService: () => ({ execute: canary.domain }) }));
vi.mock('../../../src/features/calendar/productivity-service.js', () => ({ createCalendarService: () => ({ execute: canary.domain }) }));
vi.mock('../../../src/features/reminders/productivity-service.js', () => ({ createReminderService: () => ({ execute: canary.domain }) }));
import { routeCanaryProductivity } from '../../../src/adapters/agent-core/canary-productivity-router.js';
import { withTurnLease } from '../../../src/agent/core/turn-lease.js';

const secret = 'PRIVATE_do_not_log';
const ctx = (signal = new AbortController().signal): TurnContext => ({ userId: SYNTHETIC_USER, runId: 'ind-run', requestId: 'ind-request', timezone: 'America/Bogota', language: 'es', referenceTimeIso: '2026-10-11T17:00:00Z', signal, capabilities: new Set(['probe', 'reminders.create', 'reminders.read', 'reminders.pro']) });
const routes = [{ id: 'offline', model: 'mock/model', providers: ['mock'], timeoutMs: 1000 }];
const usage = { prompt_tokens: 13, completion_tokens: 7 };
const healthy = (name?: string, args: JsonObject = {}) => ({ usage, choices: [{ message: { role: 'assistant', content: name ? '' : 'Done', ...(name ? { tool_calls: [{ id: 'fresh', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : {}) }, finish_reason: name ? 'tool_calls' : 'stop' }] });
const rejected = (name: string, metered = true) => ({ ...(metered ? { usage } : {}), error: { code: 502, message: `attempted to call tool '${name}' which was not in request.tools`, metadata: { failed_generation: secret } } });
function wire(raw: unknown[], onAttempt?: (a: OpenRouterAttempt) => void) {
  const bodies: Record<string, unknown>[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_u, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify(raw.shift() ?? healthy()), { status: 200 }); });
  const provider = new OpenRouterProvider({ apiKey: secret, routes, fetch, now: () => 0, estimateInputTokens: () => 1, ...(onAttempt ? { onAttempt } : {}) });
  return { provider, bodies, fetch };
}
const scope = (body: Record<string, unknown>) => ((body.tools ?? []) as { function: { name: string } }[]).map(t => t.function.name);
function loopProbe(name: string, options: AgentLoopOptions = {}, controller = new AbortController(), metered = true, journal = true, observeAttempt?: (a: OpenRouterAttempt) => void) {
  const events: unknown[] = [], attempts: OpenRouterAttempt[] = [], effects: unknown[] = [], fences: string[] = [];
  const w = wire([rejected(name, metered), healthy('cold', { marker: 'fresh' }), healthy()], a => { attempts.push(structuredClone(a)); observeAttempt?.(a); });
  const registry = new ToolRegistry(['warm', 'cold'].map(name => ({ specification: { name, description: secret, inputSchema: { type: 'object', properties: { marker: { type: 'string' } }, additionalProperties: false } }, effect: 'write' as const, requiredCapability: 'probe', execute: async (input: unknown, context: TurnContext, operationId: string) => { effects.push(input); return { status: 'success' as const, data: {}, observation: 'verified', receipt: { userId: context.userId, operationId, toolName: name, resourceIds: [] } }; } })));
  const policy: AgentLoopPolicy = { acceptsTool: () => true, referenceMissing: () => false, writeJournalAvailable: journal, prepareContext: h => [...h], requiresReconciliation: () => false, normalizeOutcome: (_c, o) => o, beforeDispatch: async () => { fences.push('before'); }, afterOutcome: async () => { fences.push('after'); } };
  const loop = new AgentLoop(w.provider, registry, { continuation: 'observation_driven', discoverTools: true, initialTools: ['warm'], now: () => 0, timeoutMs: 1000, estimateInputTokens: () => 1, authorizeWrite: async () => { fences.push('authorize'); return true; }, onToolSelection: e => { events.push(structuredClone(e)); }, ...options });
  return { ...w, events, attempts, effects, fences, run: () => loop.run(secret, ctx(controller.signal), [], policy) };
}

describe('independent S2: actual wire guidance, never future authority', () => {
  it.each(['full', 'executable', 'compressed'] as const)('%s has no initial reserved name/schema but retains eligible instructions', async profile => {
    const port = createSyntheticReminders();
    const w = wire([healthy('reminder_create', { content: 'Prepare', targetTimeIso: '2026-10-11T21:00:00Z', turnDisposition: 'continue' }), healthy()]);
    const runner = new ProductivityTurnRunner(w.provider, new ToolRegistry(createReminderTools(port)), { continuation: 'observation_driven', discoverTools: true, initialTools: ['reminder_create'], compactObservations: profile !== 'full', finishWithVerifiedResults: true, now: () => 0, maxInputTokens: 1000, authorizeWrite: async () => true, estimateInputTokens: value => {
      const r = value as CompletionRequest, sys = String(r.messages[0]?.content);
      if (profile === 'executable' && !sys.startsWith('You are Hermes, a personal assistant.')) return 2000;
      if (profile === 'compressed' && r.messages.some(m => m.role === 'tool') && !sys.includes('"completedActiveTools":')) return 2000;
      return 10;
    } });
    const result = await runner.run('Create Prepare, and another without a date', ctx(), undefined, { beforeDispatch: async () => {}, afterOutcome: async () => {} });
    expect(w.fetch).toHaveBeenCalledTimes(2); expect(port.operations).toHaveLength(1); expect(result.uiPayload.notices).toEqual([]);
    expect(scope(w.bodies[0]!)).toEqual(['tools_select', 'reminder_create']);
    for (const [index, body] of w.bodies.entries()) {
      const sys = (body.messages as { role: string; content: string }[]).filter(m => m.role === 'system').map(m => m.content).join('\n');
      expect(sys.includes('conversation_clarify')).toBe(index === 1); expect(scope(body).includes('conversation_clarify')).toBe(index === 1);
      expect(sys).toContain('continue'); expect(sys).toContain('never repeat');
      if (profile === 'executable') expect(sys).toContain('You are Hermes, a personal assistant.');
      if (profile === 'compressed' && index === 1) expect(sys).toContain('"completedActiveTools":');
    }
  });
  it.each([[false, false], [false, true], [true, false], [true, true]])('agenda guidance follows selector availability: executable=%s loaded=%s', async (executable, loaded) => {
    const w = wire([healthy()]); const context = { ...ctx(), capabilities: new Set([...ctx().capabilities, 'agenda.read']) };
    const runner = new ProductivityTurnRunner(w.provider, new ToolRegistry(createAgendaTools(new ToolRegistry([]))), { continuation: 'observation_driven', discoverTools: true, initialTools: loaded ? ['agenda_read'] : [], compactObservations: true, now: () => 0, maxInputTokens: 1000, estimateInputTokens: value => !executable || String((value as CompletionRequest).messages[0]?.content).startsWith('You are Hermes, a personal assistant.') ? 10 : 2000 });
    await runner.run('What is on my agenda?', context); expect(w.fetch).toHaveBeenCalledOnce(); expect(scope(w.bodies[0]!)).toEqual([loaded ? 'agenda_read' : 'tools_select']);
    const system = String((w.bodies[0]!.messages as { content: string }[])[0]!.content);
    expect(system.includes('tools_select')).toBe(!loaded); expect(system).not.toContain('conversation_clarify');
    expect(system).toContain(loaded ? 'General agenda questions require agenda_read' : 'then call it only after its schema is advertised');
  });
  it('never recommends selector when all domain schemas are already advertised', async () => {
    const port = createSyntheticReminders(); const w = wire([healthy()]);
    const runner = new ProductivityTurnRunner(w.provider, new ToolRegistry(createReminderTools(port).filter(t => t.specification.name === 'reminder_create')), { continuation: 'observation_driven', discoverTools: true, initialTools: ['reminder_create'], now: () => 0, estimateInputTokens: () => 1 });
    await runner.run('Hello', ctx()); expect(scope(w.bodies[0]!)).toEqual(['reminder_create']); expect(JSON.stringify(w.bodies[0]!.messages)).not.toMatch(/tools_select|conversation_clarify|agenda_read/);
  });
  it.each(['failed', 'indeterminate'] as const)('successful sibling plus %s never opens clarification', async status => {
    const port = createSyntheticReminders(); let count = 0;
    const execute: typeof port.execute = async (request, context, operationId) => ++count === 1 ? port.execute(request, context, operationId) : status === 'failed' ? { status: 'failed', code: 'REJECTED', observation: 'failed' } : { status: 'indeterminate', operationId, observation: 'uncertain' };
    const first = healthy('reminder_create', { content: 'One', delayMinutes: 10, turnDisposition: 'continue' });
    first.choices[0]!.message.tool_calls!.push({ id: 'sibling', type: 'function', function: { name: 'reminder_create', arguments: JSON.stringify({ content: 'Two', delayMinutes: 20, turnDisposition: 'continue' }) } });
    const w = wire([first, healthy()]);
    const runner = new ProductivityTurnRunner(w.provider, new ToolRegistry(createReminderTools({ execute })), { continuation: 'observation_driven', discoverTools: true, initialTools: ['reminder_create'], finishWithVerifiedResults: true, now: () => 0, estimateInputTokens: () => 1, authorizeWrite: async () => true });
    await runner.run('Create two', ctx(), undefined, { beforeDispatch: async () => {}, afterOutcome: async () => {} });
    expect(count).toBe(2); expect(port.operations).toHaveLength(1);
    for (const body of w.bodies) { expect(scope(body)).not.toContain('conversation_clarify'); expect(JSON.stringify(body.messages)).not.toContain('conversation_clarify'); }
    expect(w.fetch).toHaveBeenCalledTimes(status === 'indeterminate' ? 1 : 2);
  });
});

describe('independent S3/S4: public recovery authority and hard fences', () => {
  it.each(['cold', 'warm', 'conversation_clarify', 'tools_select', 'foreign'])('baseline-compatible rejection %s executes fresh args only', async name => {
    const p = loopProbe(name); const result = await p.run(); const eligible = name === 'cold';
    expect(p.fetch).toHaveBeenCalledTimes(eligible ? 3 : 1);
    expect(p.effects).toEqual(eligible ? [{ marker: 'fresh' }] : []);
    expect(p.fences).toEqual(eligible ? ['authorize', 'before', 'after'] : []);
    expect(result.usage.inputTokens).toBe(eligible ? 39 : 13); expect(result.usage.outputTokens).toBe(eligible ? 21 : 7);
    expect(JSON.stringify(p.attempts)).not.toContain(secret);
    expect(JSON.stringify(p.events)).not.toContain(secret);
  });
  it('observer field mutations and throw cannot change selected schema or accounting', async () => {
    const control = loopProbe('cold'); const expected = await control.run();
    const p = loopProbe('cold', { onToolSelection: e => { Object.assign(e, { rejectedToolName: 'warm', decision: 'stop', reason: 'unknown_tool', accountingComplete: false }); (e.advertisedToolNames as string[]).splice(0, 9, 'injected'); throw Error(secret); } });
    expect(await p.run()).toEqual(expected); expect(p.bodies).toEqual(control.bodies); expect(p.effects).toEqual(control.effects); expect(p.fences).toEqual(control.fences);
  });
  it.each(['steps', 'time', 'cancel', 'tokens', 'authorization', 'journal', 'calls'] as const)('%s fence still blocks fresh dispatch', async fence => {
    const controller = new AbortController(); let time = 0;
    const options: AgentLoopOptions = { now: () => time, ...(fence === 'steps' ? { maxModelSteps: 1 } : {}), ...(fence === 'tokens' ? { maxTotalTokens: 2 } : {}), ...(fence === 'authorization' ? { authorizeWrite: async () => false } : {}), ...(fence === 'calls' ? { maxToolCalls: 1 } : {}), onToolSelection: e => { if (fence === 'time') time = 1001; if (fence === 'cancel') controller.abort(); expect(e.decision).toBe('reload_schema'); } };
    const p = loopProbe('cold', options, controller, fence !== 'tokens', fence !== 'journal');
    if (fence === 'calls') { const fresh = healthy('cold', { marker: 'fresh' }); fresh.choices[0]!.message.tool_calls!.push({ id: 'extra', type: 'function', function: { name: 'warm', arguments: '{}' } }); p.fetch.mockImplementationOnce(async () => new Response(JSON.stringify(rejected('cold')))).mockImplementationOnce(async () => new Response(JSON.stringify(fresh))); }
    const result = await p.run(); expect(p.effects).toEqual([]);
    expect(p.fetch).toHaveBeenCalledTimes(['authorization', 'journal'].includes(fence) ? 3 : fence === 'calls' ? 2 : 1);
    if (fence === 'tokens') { expect(result.usage.accountingComplete).toBe(false); expect(result.usage.estimatedCostUsd).toBeNull(); }
  });
  it.each(['cancel', 'time'] as const)('provider observer %s cannot grant another request or dispatch', async kind => {
    const controller = new AbortController(); let time = 0;
    const p = loopProbe('cold', { now: () => time }, controller, true, true, a => {
      (a.advertisedToolNames as string[]).push('injected');
      if (kind === 'cancel') controller.abort(); else time = 1001;
      throw Error(secret);
    });
    const result = await p.run(); expect(p.fetch).toHaveBeenCalledOnce(); expect(p.effects).toEqual([]); expect(p.fences).toEqual([]);
    expect(p.events).toEqual([expect.objectContaining({ decision: 'stop', reason: 'turn_inactive', accountingComplete: true })]);
    expect(result.usage).toMatchObject({ modelSteps: 1, inputTokens: 13, outputTokens: 7, accountingComplete: true });
  });
  it('one schema reload only; a second rejection never dispatches recovered arguments', async () => {
    const p = loopProbe('cold');
    p.fetch.mockImplementationOnce(async () => new Response(JSON.stringify(rejected('cold')))).mockImplementationOnce(async () => new Response(JSON.stringify(rejected('warm'))));
    const result = await p.run(); expect(p.fetch).toHaveBeenCalledTimes(2); expect(p.effects).toEqual([]); expect(p.fences).toEqual([]);
    expect(p.events).toEqual([expect.objectContaining({ reason: 'authorized_schema', decision: 'reload_schema' }), expect.objectContaining({ reason: 'recovery_exhausted', decision: 'stop' })]);
    expect(result.usage).toMatchObject({ modelSteps: 2, inputTokens: 26, outputTokens: 14, accountingComplete: true });
  });
  it.each(['foreign', 'warm', 'cold'])('clock short-circuit count stays baseline-compatible for %s', async name => {
    let ticks = 0; const p = loopProbe(name, { now: () => { ticks++; return 0; } }); await p.run();
    expect(ticks).toBe(name === 'cold' ? 10 : 2);
  });
});

describe('independent S3: actual payload bounds and narrow classifier', () => {
  it.each([0, 1, 64, 65])('captures %i valid names without changing wire payload', async count => {
    const events: OpenRouterAttempt[] = []; const w = wire([healthy()], a => { events.push(a); });
    const names = Array.from({ length: count }, (_, i) => `A_${i}-z`);
    await w.provider.complete({ messages: [{ role: 'user', content: secret }], tools: names.map(name => ({ name, description: secret, inputSchema: { type: 'object' } })), maxOutputTokens: 100, deadlineMs: 1000, signal: ctx().signal });
    expect(scope(w.bodies[0]!)).toEqual(names); expect(events[0]!.advertisedToolNames).toEqual(names.slice(0, 64)); expect(events[0]!.advertisedToolsTruncated).toBe(count > 64); expect(JSON.stringify(events)).not.toContain(secret);
  });
  it('filters overlong names and detaches observers', async () => {
    const names = ['z'.repeat(65), 'z'.repeat(64), 'ok']; const snapshots: OpenRouterAttempt[] = [];
    const w = wire([rejected('cold')], a => { snapshots.push(structuredClone(a)); Object.assign(a, { rejectedToolName: 'changed' }); (a.advertisedToolNames as string[]).push('injected'); if (a.usage) Object.assign(a.usage, { inputTokens: 999 }); throw Error(secret); });
    await expect(w.provider.complete({ messages: [{ role: 'user', content: secret }], tools: names.map(name => ({ name, description: secret, inputSchema: { type: 'object' } })), maxOutputTokens: 100, deadlineMs: 1000, signal: ctx().signal })).rejects.toMatchObject({ toolName: 'cold', usage: { inputTokens: 13, outputTokens: 7 }, accountingComplete: true });
    expect(scope(w.bodies[0]!)).toEqual(names); expect(snapshots[0]).toMatchObject({ advertisedToolNames: ['z'.repeat(64), 'ok'], advertisedToolsTruncated: true, rejectedToolName: 'cold', providerErrorCode: 502 }); expect(JSON.stringify(snapshots)).not.toContain(secret);
  });
  it.each([[''], ['á'], ['not.valid'], ['name\n'], ['ok', 'ok']])('preserves preflight validation for invalid tool list %j', async (...names) => {
    const events: OpenRouterAttempt[] = []; const w = wire([healthy()], a => events.push(a));
    await expect(w.provider.complete({ messages: [{ role: 'user', content: secret }], tools: names.map(name => ({ name, description: secret, inputSchema: { type: 'object' } })), maxOutputTokens: 100, deadlineMs: 1000, signal: ctx().signal })).rejects.toBeInstanceOf(Error);
    expect(w.fetch).not.toHaveBeenCalled(); expect(events).toEqual([]);
  });
  it.each(['empty', 'overlong', 'duplicate', 'wrongcode', 'choices', 'advertised', 'mismatch'] as const)('never classifies malformed %s as rejected tool', async kind => {
    const raw = rejected('cold');
    if (kind === 'empty') raw.error.message = "attempted to call tool '' which was not in request.tools";
    if (kind === 'overlong') raw.error.message = `attempted to call tool '${'x'.repeat(65)}' which was not in request.tools`;
    if (kind === 'duplicate') raw.error.message += ' '+raw.error.message;
    if (kind === 'wrongcode') raw.error.code = 500;
    if (kind === 'choices') Object.assign(raw, { choices: [] });
    if (kind === 'mismatch') raw.error.message = `attempted to call tool 'cold" which was not in request.tools`;
    const events: OpenRouterAttempt[] = []; const w = wire([raw], a => events.push(a));
    await expect(w.provider.complete({ messages: [{ role: 'user', content: secret }], tools: kind === 'advertised' ? [{ name: 'cold', description: '', inputSchema: { type: 'object' } }] : [], maxOutputTokens: 100, deadlineMs: 1000, signal: ctx().signal })).rejects.toMatchObject({ code: 'ROUTES_EXHAUSTED' });
    expect(w.fetch).toHaveBeenCalledOnce(); expect(events[0]).not.toHaveProperty('rejectedToolName'); expect(events[0]!.providerErrorCode).toBe(kind === 'wrongcode' ? 500 : 502); expect(JSON.stringify(events)).not.toContain(secret);
  });
});

describe('independent S3/S5: evaluator consumer and offline entry', () => {
  it.each(['reminder_read', 'conversation_clarify'])('retains safe %s event while unknown spend locks transport', async name => {
    const attempts: unknown[] = []; let requests = 0;
    const budget = createBudgetedTransport({ maxCalls: 60, maxUsd: 0.25, rates: { 'mock/model': { prompt: 0.000001, completion: 0.000001 } }, fetch: async () => { requests++; return new Response(JSON.stringify(rejected(name, false))); } });
    const provider = new OpenRouterProvider({ apiKey: secret, routes, fetch: budget.fetch, estimateInputTokens: () => 1, onAttempt: a => attempts.push(safeAttempt(a)) });
    const report = await runConversation({ forTurn: () => provider.forTurn(), budgetReport: budget.report, attempts });
    expect(requests).toBe(1); expect(report.turns).toHaveLength(1); expect(report.turns[0]!.operations).toEqual([]); expect(report.receipts).toEqual([]); expect(report.finalRecords).toEqual([]);
    expect(report.turns[0]!.toolSelections).toEqual([expect.objectContaining({ rejectedToolName: name, reason: name === 'reminder_read' ? 'authorized_schema' : 'reserved_control', accountingComplete: false })]);
    expect(report.turns[0]!.safeAttempts[0]).toMatchObject({ rejectedToolName: name, providerErrorCode: 502, advertisedToolNames: ['tools_select', 'reminder_create', 'conversation_decide'], usage: null });
    expect(report.budget.calls).toBe(1); expect(report.budget.reservedUsd).toBeGreaterThan(0); expect(report.budget.blockedReason).toBe('missing usage or provider error'); expect(report.liveProof).toBe(false); expect(JSON.stringify([report.turns[0]!.safeAttempts, report.turns[0]!.toolSelections])).not.toContain(secret);
  });
  it('CLI help/dry are offline and reject unrecognized options', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('network forbidden'));
    try { for (const [args, code] of [[['--help'], 0], [[], 0], [['--unknown'], 2]] as const) { const print = vi.fn(); expect(await main([...args], print)).toBe(code); expect(print).toHaveBeenCalledOnce(); } expect(fetch).not.toHaveBeenCalled(); } finally { fetch.mockRestore(); }
  });
});

// S3/S4: the real public canary consumes both observer seams, not just a fake provider.
it.each(['reminder_read', 'conversation_clarify'])('independent canary wire %s correlates safe diagnostics with no effects', async name => {
  canary.raw = [rejected(name, false), healthy()]; canary.fetches = 0; canary.domain.mockClear();
  const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
  const send = vi.fn(async () => ({ messageId: 'offline-delivery' })); const checkpoints: JsonObject[] = []; const context = ctx();
  const lease = { inboundTurn: { id: context.runId, messageId: context.requestId, threadId: 'ind-thread', response: {} }, signal: context.signal, assertActive: async () => {}, checkpoint: async (patch: JsonObject) => { checkpoints.push(patch); } };
  try {
    await withTurnLease(lease, () => routeCanaryProductivity(secret, { id: context.userId, timezone: context.timezone }, { agentCoreDelivery: { send } }, { context, threadId: 'ind-thread', prior: null }));
    const selections = logs.mock.calls.filter(c => c[0] === '[agent-core-v2] tool_selection').map(c => JSON.parse(String(c[1])) as Record<string, unknown>);
    const attempts = logs.mock.calls.filter(c => c[0] === '[agent-core-v2] provider_attempt').map(c => JSON.parse(String(c[1])) as Record<string, unknown>);
    expect(selections).toEqual([expect.objectContaining({ runId: context.runId, requestId: context.requestId, rejectedToolName: name, advertisedToolNames: ['tools_select', 'task_create', 'reminder_create', 'conversation_decide'], reason: name === 'reminder_read' ? 'authorized_schema' : 'reserved_control', accountingComplete: false })]);
    expect(attempts[0]).toMatchObject({ runId: context.runId, requestId: context.requestId, rejectedToolName: name, providerErrorCode: 502, usage: null });
    expect(canary.fetches).toBe(name === 'reminder_read' ? 2 : 1); expect(canary.domain).not.toHaveBeenCalled(); expect(send).toHaveBeenCalledOnce();
    expect(JSON.stringify([selections, attempts])).not.toContain(secret); expect(checkpoints.at(-1)).toMatchObject({ agentCoreProductivity: { effects: [] } });
  } finally { logs.mockRestore(); }
});

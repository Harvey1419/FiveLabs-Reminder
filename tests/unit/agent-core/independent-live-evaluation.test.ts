import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { OpenRouterProvider, estimateBoundedInput } from '@templelabs/ai';
import type { CompletionRequest } from '@templelabs/ai';
import { createBudgetedTransport } from '../../../scripts/evals/live-evaluation-budget.js';
import { main, runConversation, createSyntheticReminders, gradeTurn, SYNTHETIC_USER } from '../../../scripts/evals/v2-fluent-conversation.js';
import type { TurnContext } from '@templelabs/contracts';
const url = 'https://openrouter.ai/api/v1/chat/completions';
const body = (model = 'primary') => JSON.stringify({ model, max_tokens: 10, messages: [{ role: 'user', content: 'á🧪' }] });
const init = (model = 'primary') => ({ method: 'POST', body: body(model) });
const envelope = (model = 'primary', usage: unknown = { prompt_tokens: 6, completion_tokens: 4, cost: 0.001 }) => new Response(JSON.stringify({ id: 'generation-independent', model, usage, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] }));
const rates = { primary: { prompt: 1e-6, completion: 2e-6 }, secondary: { prompt: 3e-6, completion: 4e-6 } };
const guard = (fetch: typeof globalThis.fetch, prices = rates, maxCalls = 60, maxUsd = 0.25) => createBudgetedTransport({ fetch, rates: prices, maxCalls, maxUsd });
const completion = (): CompletionRequest => ({ messages: [{ role: 'user', content: 'Hola' }], tools: [], maxOutputTokens: 10, deadlineMs: Date.now() + 10000, signal: new AbortController().signal });
const source = (fetch: typeof globalThis.fetch) => new OpenRouterProvider({ apiKey: 'synthetic-only', fetch, estimateInputTokens: estimateBoundedInput, routes: [{ id: 'primary', model: 'primary', providers: ['p1'], timeoutMs: 1000 }, { id: 'secondary', model: 'secondary', providers: ['p2'], timeoutMs: 1000 }] });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

describe('independent S4 eval-only safety probes', () => {
  it('atomically bounds 61 simultaneous mixed-route HTTP calls at exactly 60', async () => {
    const network = vi.fn<typeof fetch>(async (_url, opts) => envelope(JSON.parse(String(opts?.body)).model, { cost: 0, prompt_tokens: 1, completion_tokens: 1 }));
    const budget = guard(network, rates, 99, 99);
    const out = await Promise.allSettled(Array.from({ length: 61 }, (_, i) => budget.fetch(url, init(i % 2 ? 'secondary' : 'primary'))));
    expect(out.filter(r => r.status === 'fulfilled')).toHaveLength(60);
    expect(out.filter(r => r.status === 'rejected')).toHaveLength(1);
    const rejection = out.find(r => r.status === 'rejected');
    expect(rejection?.status === 'rejected' && rejection.reason.message).toBe('Budget transport: call limit');
    expect(network).toHaveBeenCalledTimes(60);
    expect(budget.report()).toMatchObject({ calls: 60, chargedUsd: 0, reservedUsd: 0, blockedReason: 'call limit' });
  });
  it('reserves atomic USD .125 twice, rejects the third at .25, and keeps both pending reservations', async () => {
    const done: ((r: Response) => void)[] = [];
    const network = vi.fn<typeof fetch>(() => new Promise(resolve => done.push(resolve)));
    const budget = guard(network, { primary: { prompt: 0, completion: 0.0125 }, secondary: { prompt: 0, completion: 0.0125 } }, 999, 999);
    const first = budget.fetch(url, init()); const second = budget.fetch(url, init('secondary'));
    await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(2));
    expect(budget.report()).toMatchObject({ calls: 2, chargedUsd: 0, reservedUsd: 0.25 });
    await expect(budget.fetch(url, init())).rejects.toThrow('Budget transport: USD limit');
    expect(budget.report().reservedUsd).toBe(0.25);
    done.forEach(resolve => resolve(envelope('primary', { cost: 0.125 })));
    await Promise.all([first, second]);
    expect(budget.report()).toMatchObject({ calls: 2, chargedUsd: 0.25, reservedUsd: 0, blockedReason: 'USD limit' });
    expect(network).toHaveBeenCalledTimes(2);
  });
  it('snapshots prices and detaches returned token accounting from caller mutation', async () => {
    const prices = structuredClone(rates);
    const network = vi.fn<typeof fetch>(async () => envelope('primary', { prompt_tokens: 6, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 3 } }));
    const budget = guard(network, prices);
    prices.primary.prompt = 100; prices.primary.completion = 100;
    await budget.fetch(url, init());
    expect(budget.report().chargedUsd).toBe(6e-6 + 4 * 2e-6);
    const snapshot = budget.report();
    (snapshot.attempts[0] as { usage: { promptTokens: number } }).usage.promptTokens = 999;
    expect(budget.report().attempts[0]).toMatchObject({ responseModel: 'primary', id: 'generation-independent', usage: { promptTokens: 6, completionTokens: 4, cachedTokens: 5, reasoningTokens: 3 } });
  });
  it.each([NaN, Infinity, -0.01, '0.01', null])('invalid supplied prompt rate %s never dispatches', async prompt => {
    const network = vi.fn<typeof fetch>(async () => envelope());
    const budget = guard(network, { ...rates, primary: { prompt: prompt as number, completion: 1e-6 } });
    await expect(budget.fetch(url, init())).rejects.toThrow('Budget transport: valid pricing required');
    expect(network).not.toHaveBeenCalled();
    expect(budget.report()).toMatchObject({ calls: 0, chargedUsd: 0, reservedUsd: 0, attempts: [] });
  });
  it.each([
    ['different returned model', 'secondary', { prompt_tokens: 1, completion_tokens: 1 }],
    ['invalid explicit zero substitute', 'primary', { prompt_tokens: 1, completion_tokens: 1, cost: null }],
    ['missing usage', 'primary', undefined],
    ['excess output', 'primary', { prompt_tokens: 1, completion_tokens: 11 }],
  ])('locks %s before any cross-route fallback dispatch', async (_name, model, usage) => {
    const network = vi.fn<typeof fetch>(async () => usage === undefined ? new Response(JSON.stringify({ model })) : envelope(model, usage));
    const budget = guard(network);
    await budget.fetch(url, init());
    const before = budget.report();
    expect(before.blockedReason).not.toBeNull(); expect(before.reservedUsd).toBeGreaterThan(0);
    await expect(budget.fetch(url, init('secondary'))).rejects.toThrow();
    expect(hash(budget.report())).toBe(hash(before));
    expect(network).toHaveBeenCalledTimes(1);
  });
  it('counts actual OpenRouter fallback and forTurn forks through the one shared guard', async () => {
    let calls = 0;
    const network = vi.fn<typeof fetch>(async (_url, opts) => {
      const model = JSON.parse(String(opts?.body)).model; calls++;
      if (calls === 1) return new Response(JSON.stringify({ model, usage: { prompt_tokens: 2, completion_tokens: 1, cost: 0.001 }, choices: [] }));
      return envelope(model);
    });
    const budget = guard(network, rates, 2);
    const provider = source(budget.fetch);
    await expect(provider.forTurn().complete(completion())).resolves.toMatchObject({ message: { content: 'ok' } });
    expect(budget.report()).toMatchObject({ calls: 2, chargedUsd: 0.002, reservedUsd: 0 });
    await expect(provider.forTurn().complete(completion())).rejects.toThrow();
    expect(network).toHaveBeenCalledTimes(2);
    expect(budget.report().blockedReason).toBe('call limit');
  });
  it('unknown accounting cannot cause a real fallback even with the actual OpenRouter adapter', async () => {
    const network = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [] })));
    const budget = guard(network);
    await expect(source(budget.fetch).forTurn().complete(completion())).rejects.toThrow();
    expect(budget.report().calls).toBe(1);
    await expect(source(budget.fetch).forTurn().complete(completion())).rejects.toThrow();
    expect(network).toHaveBeenCalledTimes(1);
  });
  it('only explicit total cost authorizes charging a different returned model', async () => {
    const budget = guard(async () => envelope('actual/returned-build', { prompt_tokens: 6, completion_tokens: 4, cost: 0.003 }));
    await budget.fetch(url, init());
    expect(budget.report()).toMatchObject({ chargedUsd: 0.003, reservedUsd: 0, blockedReason: null });
    expect(budget.report().attempts[0]).toMatchObject({ responseModel: 'actual/returned-build', usage: { promptTokens: 6, completionTokens: 4 } });
  });
  it('does not start a provider at all after uncertain accounting is already visible', async () => {
    const forTurn = vi.fn(() => { throw new Error('must not run'); });
    const report = await runConversation({ forTurn, live: true, budgetReport: () => ({ calls: 1, chargedUsd: 0, reservedUsd: 0.01, blockedReason: 'unknown fees', attempts: [] }) });
    expect(forTurn).not.toHaveBeenCalled(); expect(report.liveProof).toBe(false); expect(report.incomplete).toBe(true);
    expect(report.stoppedReason).toBe('unknown fees');
  });
  it('invalid and duplicate CLI arguments have exact exit 2/help and never fetch', async () => {
    const network = vi.spyOn(globalThis, 'fetch');
    const output: string[] = [];
    expect(await main(['--help'], x => output.push(x))).toBe(0);
    const help = output[0];
    for (const args of [['--help', '--live'], ['--live', '--live'], ['--max-usd', '1'], ['--max-calls', '61'], ['--pricing', 'x.json'], ['--output', 'x.json'], ['--live']]) {
      const lines: string[] = [];
      expect(await main(args, x => lines.push(x))).toBe(2);
      expect(lines).toEqual([help]);
    }
    expect(network).not.toHaveBeenCalled(); network.mockRestore();
  });
  it('hashes synthetic records byte-identically on failed owner/policy/ID/replay commands', async () => {
    const port = createSyntheticReminders();
    const context: TurnContext = { userId: SYNTHETIC_USER, runId: 'ind', requestId: 'ind', timezone: 'America/Bogota', language: 'es', referenceTimeIso: '2026-10-11T17:49:00Z', signal: new AbortController().signal, capabilities: new Set() };
    const create = { operation: 'create' as const, input: { content: 'Only record', targetTimeIso: '2026-10-12T14:00:00Z' } };
    await port.execute(create, context, 'first');
    const before = hash(port.snapshot());
    for (const [request, ctx, id] of [
      [{ ...create, input: { ...create.input, advanceMinutes: 10 } }, context, 'unsupported'],
      [{ operation: 'cancel' as const, input: { reminderId: '99999999-9999-4999-8999-999999999999' } }, context, 'missing'],
      [create, { ...context, userId: 'other' }, 'owner'],
      [{ ...create, input: { ...create.input, content: 'Conflict' } }, context, 'first'],
    ] as const) {
      expect(await port.execute(request, ctx, id)).toMatchObject({ status: 'validation_failed' });
      expect(hash(port.snapshot())).toBe(before);
    }
    expect(await port.execute(create, context, 'first')).toMatchObject({ status: 'success' });
    expect(hash(port.snapshot())).toBe(before);
    expect(port.operations.filter(x => x.wrote)).toHaveLength(1);
  });
  it('grades observed data rather than a correct-sounding reply or planned calls', () => {
    const evidence = { before: [], after: [], operations: [], reads: [], reply: 'Preparar reunión 4:00 PM ¿El recordatorio pendiente es para hoy o para mañana?', clarification: { domain: 'reminders', missing: 'today_or_tomorrow' } };
    expect(gradeTurn(0, evidence).some(c => !c.pass)).toBe(true);
    expect(gradeTurn(9, { ...evidence, reply: 'No hay recordatorios.' }).find(c => c.name === 'read list IDs and order')?.pass).toBe(false);
  });
  it('treats contradictory nested and top-level costs as unknown, never silently undercharging', async () => {
    const network = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ model: 'primary', usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.2 }, metadata: { usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } } })));
    const budget = guard(network);
    await budget.fetch(url, init());
    const next = await Promise.allSettled([budget.fetch(url, init('secondary'))]);
    console.log('conflicting-cost', JSON.stringify(budget.report()), 'actual reported top-level USD=0.40');
    expect(budget.report().blockedReason).not.toBeNull();
    expect(next[0]?.status).toBe('rejected');
    expect(network).toHaveBeenCalledTimes(1);
  });
  it('documents the conditional fee/rate assumption: charges above reservations can already exceed .25', async () => {
    const network = vi.fn<typeof fetch>(async () => envelope('primary', { prompt_tokens: 1, completion_tokens: 1, cost: 0.30 }));
    const budget = guard(network);
    await budget.fetch(url, init());
    expect(budget.report()).toMatchObject({ calls: 1, chargedUsd: 0.30, reservedUsd: 0, blockedReason: 'USD limit' });
    await expect(budget.fetch(url, init())).rejects.toThrow('Budget transport: USD limit');
    expect(network).toHaveBeenCalledTimes(1);
  });
  it('documents that additional fees in pricing/usage are not accounted by token-only fallback', async () => {
    const network = vi.fn<typeof fetch>(async () => envelope('primary', { prompt_tokens: 1, completion_tokens: 1, request_fee: 0.20 }));
    const priceWithExtraFee = { primary: { prompt: 1e-6, completion: 2e-6, request_fee: 0.20 }, secondary: rates.secondary };
    const budget = guard(network, priceWithExtraFee);
    await budget.fetch(url, init());
    console.log('fee-assumption', JSON.stringify(budget.report()));
    expect(budget.report()).toMatchObject({ chargedUsd: 3e-6, reservedUsd: 0, blockedReason: null });
  });
  it('does not confuse property order with returned reminder data changes', () => {
    const stored = { id: '22222222-2222-4222-8222-000000000001', content: 'Preparar reunión', sendAt: '2026-10-11T21:00:00Z', recurrence: null, status: 'pending' as const, isAdvanceNotice: false, parentReminderId: null, requiresConfirmation: false, acknowledgedAt: null };
    const { status, ...rest } = stored;
    const normalized = { ...rest, status };
    const checks = gradeTurn(2, { before: [stored], after: [stored], operations: [], reads: [[normalized]], reply: 'Preparar reunión', clarification: null });
    expect(checks.every(c => c.pass)).toBe(true);
  });
  it('chains all 20 through real wire provider/runner/durable checkpoint/synthetic port with unchanged production limits', async () => {
    const a = '22222222-2222-4222-8222-000000000001', b = '22222222-2222-4222-8222-000000000002', c = '22222222-2222-4222-8222-000000000003';
    const plans: (null | { name: string; args: Record<string, string> })[] = [
      { name: 'reminder_create', args: { content: 'Preparar reunión', targetTimeIso: '2026-10-11T21:00:00Z', turnDisposition: 'continue' } },
      { name: 'reminder_create', args: { content: 'Enviar informe', targetTimeIso: '2026-10-12T14:00:00Z' } },
      { name: 'reminder_read', args: { filter: 'today' } }, { name: 'reminder_read', args: { filter: 'tomorrow' } },
      { name: 'reminder_update', args: { reminderId: b, targetTimeIso: '2026-10-12T15:00:00Z' } },
      { name: 'reminder_read', args: { filter: 'today' } },
      { name: 'reminder_update', args: { reminderId: a, targetTimeIso: '2026-10-11T22:00:00Z' } },
      { name: 'reminder_read', args: { filter: 'all_pending' } }, { name: 'reminder_cancel', args: { reminderId: b } },
      { name: 'reminder_read', args: { filter: 'tomorrow' } },
      { name: 'reminder_create', args: { content: 'Comprar pan', targetTimeIso: '2026-10-12T13:00:00Z' } },
      { name: 'reminder_read', args: { filter: 'tomorrow' } }, { name: 'reminder_update', args: { reminderId: c, content: 'Comprar pan integral' } },
      null, null, null, null, { name: 'reminder_cancel', args: { reminderId: c } }, { name: 'reminder_read', args: { filter: 'all_pending' } }, null,
    ];
    let turn = -1, step = 0;
    const captured: unknown[] = [];
    const network = vi.fn<typeof fetch>(async (_url, opts) => {
      const payload = JSON.parse(String(opts?.body)); captured.push(payload); step++;
      const plan = plans[turn];
      const next = turn === 0 && step > 1 ? { name: 'conversation_clarify', args: { domain: 'reminders', missing: 'today_or_tomorrow' } } : plan;
      let call = next;
      if (next && !payload.tools.some((t: { function: { name: string } }) => t.function.name === next.name)) call = { name: 'tools_select', args: { name: next.name } };
      const text = turn === 14 ? 'Se llama Comprar pan integral.' : turn === 16 ? 'Tu palabra es colibrí.' : turn === 19 ? 'Quedó a las 5:00 PM.' : 'Entendido, no cambié nada.';
      const functionCall = call
        ? { name: call.name, arguments: JSON.stringify({ ...(call.name.startsWith('reminder_') ? { turnDisposition: 'finish' } : {}), ...call.args }) }
        : { name: 'conversation_decide', arguments: JSON.stringify({ ready: [], reply: text }) };
      return new Response(JSON.stringify({ id: `ind-${turn}-${step}`, model: 'primary', usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.00002 },
        choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{ id: `call-${turn}-${step}`, type: 'function', function: functionCall }] } }] }));
    });
    const budget = guard(network);
    const provider = source(budget.fetch);
    const report = await runConversation({ forTurn: () => { turn++; step = 0; return provider.forTurn(); }, rates, budgetReport: budget.report });
    console.log('independent20', JSON.stringify({ turns: report.turns.length, passed: report.passedTurns, failed: report.failedTurns, calls: report.budget.calls, degraded: report.degraded, stop: report.stoppedReason, failures: report.turns.filter(t => !t.pass).map(t => ({ n: t.number, notices: t.notices, failed: t.checks.filter(c => !c.pass).map(c => c.name) })) }));
    expect(report.turns).toHaveLength(20); expect(report.incomplete).toBe(false); expect(report.liveProof).toBe(false);
    expect(report.budget.calls).toBeLessThanOrEqual(60); expect(report.limits.maxInputTokens).toBe(2500);
    expect(report.turns.every(t => t.checks.find(c => c.name === 'host reply and checkpoint agree')?.pass)).toBe(true);
    expect(report.passedTurns).toBe(20);
    expect(report.receipts.length).toBeGreaterThan(2);
    expect(captured.length).toBe(network.mock.calls.length);
  });
});

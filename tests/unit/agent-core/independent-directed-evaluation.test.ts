import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual,
    existsSync: vi.fn((p: Parameters<typeof actual.existsSync>[0]) => String(p).split('/').at(-1) === '.env' ? false : actual.existsSync(p)),
    readFileSync: vi.fn(actual.readFileSync), writeFileSync: vi.fn(actual.writeFileSync) };
});
import { main, type runConversation } from '../../../scripts/evals/v2-fluent-conversation.js';
import { createBudgetedTransport } from '../../../scripts/evals/live-evaluation-budget.js';

// S6: real public main/provider/runner/transport; only HTTP is replaced.
const endpoint = 'https://openrouter.ai/api/v1/chat/completions';
const model = 'synthetic/primary';
const rates = { [model]: { prompt: 1e-8, completion: 1e-8 } };
const outputs: string[] = [];
let sequence = 0;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const historical = ['odd/evidence/v2-fluent-conversation.json', 'odd/evidence/v2-fluent-pricing.json'];
const historyHashes = () => historical.map(p => existsSync(p) ? hash(readFileSync(p, 'utf8')) : null);
const wire = (name?: string, args: Record<string, unknown> = {}, usage: unknown = { prompt_tokens: 100, completion_tokens: 20, cost: 0.00001 }) => ({
  id: 'synthetic-generation', model, usage,
  choices: [{ finish_reason: name ? 'tool_calls' : 'stop', message: { role: 'assistant', content: name ? '' : 'No changes.',
    ...(name ? { tool_calls: [{ id: `call-${++sequence}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : {}) } }],
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
type WirePayload = { model: string; provider: { only: string[]; order: string[]; allow_fallbacks: boolean }; max_tokens: number; tools: { function: { name: string } }[]; messages: unknown[] };
type Report = Awaited<ReturnType<typeof runConversation>> & { configuredRoutes: unknown[] };
async function cli(handler: (payload: WirePayload, index: number) => Response, prices = rates) {
  vi.stubEnv('OPENROUTER_API_KEY', 'synthetic-only');
  vi.stubEnv('OPENROUTER_PRIMARY_MODEL', model);
  vi.stubEnv('OPENROUTER_PRIMARY_PROVIDERS', 'synthetic-primary');
  vi.stubEnv('OPENROUTER_SECONDARY_MODEL', 'synthetic/secondary');
  vi.stubEnv('OPENROUTER_LAST_RESORT_MODEL', 'synthetic/last');
  const tag = randomUUID();
  const pricing = `odd/independent-directed-pricing-${tag}.json`;
  const output = `odd/independent-directed-report-${tag}.json`;
  outputs.push(pricing, output);
  writeFileSync(pricing, JSON.stringify({ rates: prices }));
  const before = historyHashes(); const priceHash = hash(readFileSync(pricing, 'utf8'));
  const requests: WirePayload[] = [];
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(String(url)).toBe(endpoint); expect(init?.method).toBe('POST'); expect(init?.redirect).toBe('error');
    const payload: WirePayload = JSON.parse(String(init?.body)); requests.push(payload);
    expect(payload.model).toBe(model);
    expect(payload.provider).toMatchObject({ only: ['synthetic-primary'], order: ['synthetic-primary'], allow_fallbacks: false });
    expect(payload.max_tokens).toBeLessThanOrEqual(2048);
    return handler(payload, requests.length);
  });
  const stdout: string[] = [];
  const exit = await main(['--directed', '--live', '--pricing', pricing, '--output', output], x => stdout.push(x));
  expect(stdout).toEqual(['Evaluation report written.']);
  expect(historyHashes()).toEqual(before); expect(hash(readFileSync(pricing, 'utf8'))).toBe(priceHash);
  const report: Report = JSON.parse(readFileSync(output, 'utf8'));
  expect(report.liveProof).toBe(false);
  expect(report.limits).toMatchObject({ userTurns: 2, maxCalls: 6, maxUsd: 0.02 });
  console.log('directed-cli', JSON.stringify({ exit, stdout, calls: requests.length, turns: report.turns.length,
    passed: report.passedTurns, stop: report.stoppedReason, budget: report.budget, directedProof: report.directedProof }));
  fetch.mockRestore();
  return { exit, report, requests };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const p of outputs.splice(0)) if (existsSync(p)) unlinkSync(p); });

describe('independent S6 directed public CLI and actual transport', () => {
  it('chains exactly two passing mixed turns on primary only, with distinct accounted proof', async () => {
    const result = await cli((_p, n) => response(n === 1
      ? wire('reminder_create', { content: 'Preparar reunión', targetTimeIso: '2026-10-11T21:00:00Z', turnDisposition: 'continue' })
      : n === 2 ? wire('conversation_clarify', { domain: 'reminders', missing: 'today_or_tomorrow' })
      : wire('reminder_create', { content: 'Enviar informe', targetTimeIso: '2026-10-12T14:00:00Z', turnDisposition: 'finish' })));
    expect(result.exit).toBe(0); expect(result.requests).toHaveLength(3);
    expect(result.report).toMatchObject({ directedProof: true, incomplete: false, passedTurns: 2, failedChecks: 0,
      budget: { calls: 3, chargedUsd: 3 * 0.00001, reservedUsd: 0, blockedReason: null } });
    expect(result.report.script).toHaveLength(2); expect(result.report.configuredRoutes).toHaveLength(1);
    expect(result.report.receipts).toHaveLength(2); expect(result.report.finalRecords).toHaveLength(2);
    expect(result.report.turns.every(t => t.checks.find(c => c.name === 'host reply and checkpoint agree')?.pass)).toBe(true);
    const firstScope = result.requests[0]!.tools.map(t => t.function.name);
    expect(firstScope).not.toContain('conversation_clarify');
    expect(result.requests[1]!.tools.map(t => t.function.name)).toContain('conversation_clarify');
    expect(JSON.stringify(result.requests[2]!.messages)).toContain('mañana');
  });
  it('never grants directed proof to an accounted but semantically failed two-turn run', async () => {
    const result = await cli(() => response(wire()));
    // Each of the two rejected prose completions gets one bounded fresh decision request.
    expect(result.exit).toBe(1); expect(result.requests).toHaveLength(4);
    expect(result.requests.length).toBeLessThanOrEqual(6);
    expect(result.report).toMatchObject({ incomplete: false, directedProof: false, passedTurns: 0, stoppedReason: null });
  });
  it.each([401, 429, 500])('stops HTTP %s after one request, with no retry or secondary dispatch', async status => {
    const result = await cli(() => response({ error: { code: status, message: 'synthetic' } }, status));
    expect(result.exit).toBe(1); expect(result.requests).toHaveLength(1);
    expect(result.report.budget).toMatchObject({ calls: 1, blockedReason: 'HTTP error' });
    expect(result.report.budget.reservedUsd).toBeGreaterThan(0);
    expect(result.report.directedProof).toBe(false); expect(result.report.turns).toHaveLength(1);
  });
  it('does not fallback even for a malformed but fully accounted primary response', async () => {
    const result = await cli(() => response({ model, usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.00001 }, choices: [] }));
    expect(result.exit).toBe(1); expect(result.requests).toHaveLength(1);
    expect(result.report.directedProof).toBe(false);
    expect(result.report.budget).toMatchObject({ chargedUsd: 0.00001, reservedUsd: 0 });
  });
  it.each([null, { prompt_tokens: 1, completion_tokens: 1, cost: null }])('locks unknown accounting %j before the second turn', async usage => {
    const result = await cli(() => response(wire(undefined, {}, usage)));
    expect(result.exit).toBe(1); expect(result.requests).toHaveLength(1);
    expect(result.report.directedProof).toBe(false); expect(result.report.turns).toHaveLength(1);
    expect(result.report.budget.reservedUsd).toBeGreaterThan(0);
    expect(result.report.budget.blockedReason).not.toBeNull();
  });
  it('preserves safe rejection diagnostics without executing rejected arguments or retrying unknown spend', async () => {
    const sentinel = 'SENSITIVE_VENDOR_ARGUMENTS_NEVER_LOG';
    const result = await cli(() => response({ model, usage: null, error: { code: 502,
      message: `attempted to call tool 'conversation_clarify' which was not in request.tools ${sentinel}`,
      failed_generation: { name: 'reminder_create', arguments: { content: sentinel } },
    } }));
    expect(result.exit).toBe(1); expect(result.requests).toHaveLength(1);
    expect(result.report.receipts).toEqual([]); expect(result.report.finalRecords).toEqual([]);
    expect(JSON.stringify(result.report)).not.toContain(sentinel);
    expect(result.report.turns[0]!.safeAttempts[0]).toMatchObject({ providerErrorCode: 502,
      rejectedToolName: 'conversation_clarify', failureClass: 'unadvertised_tool_rejection',
      advertisedToolNames: expect.not.arrayContaining(['conversation_clarify']) });
    expect(result.report.budget).toMatchObject({ calls: 1, blockedReason: 'missing usage or provider error' });
  });
  it('retains only the verified first synthetic write and stops unknown usage during continuation', async () => {
    const result = await cli((_p, n) => response(n === 1
      ? wire('reminder_create', { content: 'Preparar reunión', targetTimeIso: '2026-10-11T21:00:00Z', turnDisposition: 'continue' })
      : wire('conversation_clarify', { domain: 'reminders', missing: 'today_or_tomorrow' }, null)));
    expect(result.exit).toBe(1); expect(result.requests).toHaveLength(2);
    expect(result.report.turns).toHaveLength(1); expect(result.report.receipts).toHaveLength(1);
    expect(result.report.finalRecords).toHaveLength(1); expect(result.report.directedProof).toBe(false);
  });
  it('public live mode refuses the second reservation above US$0.02 without dispatching it', async () => {
    const result = await cli(() => response(wire(undefined, {}, { prompt_tokens: 100, completion_tokens: 20, cost: 0.01 })),
      { [model]: { prompt: 0, completion: 0.000005 } });
    expect(result.exit).toBe(1); expect(result.requests).toHaveLength(1);
    expect(result.report.budget).toMatchObject({ calls: 1, chargedUsd: 0.01, reservedUsd: 0, blockedReason: 'USD limit' });
  });
  it('actual CLI transport stops a continuing model at six requests within the first turn', async () => {
    const result = await cli(() => response(wire('reminder_create', {
      content: 'Synthetic extra record', targetTimeIso: '2026-10-11T21:00:00Z', turnDisposition: 'continue',
    })));
    expect(result.exit).toBe(1); expect(result.requests).toHaveLength(6);
    expect(result.report.budget).toMatchObject({ calls: 6, reservedUsd: 0 });
    expect(result.report.stoppedReason).toBe('call limit'); expect(result.report.directedProof).toBe(false);
  });
  it('accepts six simultaneous HTTP reservations, rejects seventh exactly, and never retries', async () => {
    const network = vi.fn<typeof fetch>(async () => response(wire()));
    const budget = createBudgetedTransport({ fetch: network, rates, maxCalls: 6, maxUsd: 0.02 });
    const outcomes = await Promise.allSettled(Array.from({ length: 7 }, () => budget.fetch(endpoint,
      { method: 'POST', body: JSON.stringify({ model, max_tokens: 10 }) })));
    expect(outcomes.filter(x => x.status === 'fulfilled')).toHaveLength(6);
    expect(outcomes.filter(x => x.status === 'rejected')).toMatchObject([{ reason: { message: 'Budget transport: call limit' } }]);
    expect(network).toHaveBeenCalledTimes(6);
    expect(budget.report()).toMatchObject({ calls: 6, reservedUsd: 0, blockedReason: 'call limit' });
  });
  it('atomically reserves exactly .02, rejects .03, and preserves the pending reservations', async () => {
    const settle: ((r: Response) => void)[] = [];
    const network = vi.fn<typeof fetch>(() => new Promise(resolve => settle.push(resolve)));
    const budget = createBudgetedTransport({ fetch: network, rates: { [model]: { prompt: 0, completion: 0.001 } }, maxCalls: 6, maxUsd: 0.02 });
    const send = () => budget.fetch(endpoint, { method: 'POST', body: JSON.stringify({ model, max_tokens: 10 }) });
    const a = send(), b = send();
    await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(2));
    expect(budget.report().reservedUsd).toBe(0.02);
    await expect(send()).rejects.toThrow(/^Budget transport: USD limit$/);
    expect(budget.report().reservedUsd).toBe(0.02);
    settle.forEach(done => done(response(wire(undefined, {}, { cost: 0.01 })))); await Promise.all([a, b]);
    expect(budget.report()).toMatchObject({ chargedUsd: 0.02, reservedUsd: 0, blockedReason: 'USD limit' });
  });
  it('unknown spend permanently locks the exact directed transport without changing its snapshot', async () => {
    const network = vi.fn<typeof fetch>(async () => response(wire(undefined, {}, null)));
    const budget = createBudgetedTransport({ fetch: network, rates, maxCalls: 6, maxUsd: 0.02 });
    const send = () => budget.fetch(endpoint, { method: 'POST', body: JSON.stringify({ model, max_tokens: 10 }) });
    await send(); const before = hash(JSON.stringify(budget.report()));
    await expect(send()).rejects.toThrow(/^Budget transport: missing usage or provider error$/);
    expect(hash(JSON.stringify(budget.report()))).toBe(before); expect(network).toHaveBeenCalledTimes(1);
  });
  it('refuses report overwrite and malformed pricing with exact errors and unchanged files', async () => {
    const tag = randomUUID();
  const pricing = `odd/independent-directed-pricing-${tag}.json`;
    const output = `odd/independent-directed-report-${tag}.json`;
    outputs.push(pricing, output); writeFileSync(pricing, '{malformed'); writeFileSync(output, 'historical-report');
    const fetch = vi.spyOn(globalThis, 'fetch');
    const before = historyHashes(); const priceHash = hash(readFileSync(pricing, 'utf8'));
    const lines: string[] = [];
    const args = ['--directed', '--live', '--pricing', pricing, '--output', output];
    expect(await main(args, x => lines.push(x))).toBe(2);
    expect(lines).toEqual(['Invalid output path; no inference started.']);
    expect(readFileSync(output, 'utf8')).toBe('historical-report');
    unlinkSync(output); lines.length = 0;
    expect(await main(args, x => lines.push(x))).toBe(1); expect(lines).toEqual(['Evaluation report written.']);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({ exception: 'PREFLIGHT_FAILED', incomplete: true,
      liveProof: false, directedProof: false, limits: { userTurns: 2, maxCalls: 6, maxUsd: 0.02 }, turns: [] });
    expect(hash(readFileSync(pricing, 'utf8'))).toBe(priceHash); expect(historyHashes()).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps dry/help and strict flag rejection credential/network/write-free', async () => {
    const read = vi.mocked(readFileSync); read.mockClear();
    const write = vi.mocked(writeFileSync); write.mockClear();
    const fetch = vi.spyOn(globalThis, 'fetch');
    const help: string[] = []; expect(await main(['--help'], x => help.push(x))).toBe(0);
    for (const args of [['--directed','--directed'], ['--directed','--max-calls','7'], ['--directed','--max-usd','.03'],
      ['--help','--directed'], ['--directed','--live'], ['--directed','--pricing','x.json'], ['--directed','--output','x.json']]) {
      const text: string[] = []; expect(await main(args, x => text.push(x))).toBe(2); expect(text).toEqual(help);
    }
    for (const [args, count] of [[[],20], [['--directed'],2]] as const) {
      const text: string[] = []; expect(await main([...args], x => text.push(x))).toBe(0);
      expect(text.join('').split('DRY PLAN — not live evidence')[1]?.trim().split('\n')).toHaveLength(count);
    }
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
});

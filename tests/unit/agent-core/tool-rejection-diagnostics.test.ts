import { describe, expect, it, vi } from 'vitest';
import { OpenRouterProvider, type OpenRouterAttempt } from '../../../packages/ai/src/openrouter-provider.js';
import { ToolSelectionError } from '../../../packages/ai/src/provider-error.js';
import type { CompletionRequest } from '@templelabs/ai';
import * as evaluator from '../../../scripts/evals/v2-fluent-conversation.js';

const routes = [
  { id: 'first', model: 'fixture/first', providers: ['fixture-first'], timeoutMs: 1000 },
  { id: 'second', model: 'fixture/second', providers: ['fixture-second'], timeoutMs: 1000 },
];
const usage = { prompt_tokens: 12, completion_tokens: 3 };
const accounted = { inputTokens: 12, outputTokens: 3 };
const healthy = () => ({ usage, choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }] });
const rejection = (name: string) => `attempted to call tool '${name}' which was not in request.tools`;
const request = (names = ['tools_select', 'reminder_create']): CompletionRequest => ({
  messages: [{ role: 'user', content: 'PRIVATE_USER' }],
  tools: names.map(name => ({ name, description: 'PRIVATE_DESCRIPTION', inputSchema: { type: 'object' } })),
  maxOutputTokens: 100, deadlineMs: Date.now() + 10000, signal: new AbortController().signal,
});
function fixture(raw: unknown, status = 200, observer?: (a: OpenRouterAttempt) => void) {
  const attempts: OpenRouterAttempt[] = [];
  const bodies: Record<string, unknown>[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify(bodies.length === 1 ? raw : healthy()), { status: bodies.length === 1 ? status : 200 });
  });
  const provider = new OpenRouterProvider({ apiKey: 'PRIVATE_KEY', routes, fetch, estimateInputTokens: () => 1, onAttempt: a => {
    attempts.push(structuredClone(a)); observer?.(a);
  } });
  return { provider, fetch, attempts, bodies };
}
function assertPrivate(attempts: unknown) {
  expect(JSON.stringify(attempts)).not.toMatch(/PRIVATE_|failed_generation|Authorization|Bearer|arguments|message|content/);
}

describe('bounded tool rejection diagnostics through the real adapter', () => {
  it.each(['reminder_cancel', 'conversation_clarify', 'A_0-z', 'x'.repeat(64)])('reports only classified %s, with known and unknown accounting', async name => {
    for (const metered of [true, false]) {
      const f = fixture({ error: { code: 502, message: rejection(name), metadata: { failed_generation: 'PRIVATE_ARGS' } },
        ...(metered ? { usage } : {}) });
      const error = await f.provider.complete(request()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ToolSelectionError);
      expect(error).toMatchObject({ toolName: name, accountingComplete: metered,
        usage: metered ? accounted : { inputTokens: 0, outputTokens: 0 } });
      expect(error).not.toHaveProperty('arguments');
      expect(f.attempts).toHaveLength(1);
      expect(f.attempts[0]).toMatchObject({ advertisedToolNames: ['tools_select', 'reminder_create'], advertisedToolsTruncated: false,
        rejectedToolName: name, providerErrorCode: 502, failureClass: 'unadvertised_tool_rejection', usage: metered ? accounted : null });
      expect(f.bodies[0]?.tools).toEqual(request().tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })));
      expect(f.fetch).toHaveBeenCalledOnce(); assertPrivate(f.attempts);
    }
  });
  it.each([
    ['healthy', healthy(), 200],
    ['generic', { error: { code: 502, message: 'PRIVATE_VENDOR' }, usage }, 502],
    ['advertised', { error: { code: 502, message: rejection('tools_select') }, usage }, 200],
    ['multiple', { error: { code: 502, message: `${rejection('a')} ${rejection('b')}` }, usage }, 200],
    ['malformed', { error: { code: 502, message: rejection('bad.name') }, usage }, 200],
    ['too long', { error: { code: 502, message: rejection('x'.repeat(65)) }, usage }, 200],
    ['wrong code', { error: { code: 500, message: rejection('conversation_clarify') }, usage }, 200],
    ['choices', { error: { code: 502, message: rejection('conversation_clarify') }, choices: [], usage }, 200],
  ])('omits rejected names for %s without broadening classification', async (_label, raw, status) => {
    const f = fixture(raw, status);
    const result = await f.provider.complete(request());
    expect(result.usage).toEqual(_label === 'healthy' ? accounted : { inputTokens: 24, outputTokens: 6 });
    expect(f.attempts).toHaveLength(_label === 'healthy' ? 1 : 2);
    for (const a of f.attempts) {
      expect(a).not.toHaveProperty('rejectedToolName');
      expect(a).toMatchObject({ advertisedToolNames: ['tools_select', 'reminder_create'], advertisedToolsTruncated: false });
    }
    assertPrivate(f.attempts);
  });
  it('filters invalid names, preserves actual request order and caps the snapshot at 64', async () => {
    const names = ['z-last', 'x'.repeat(65), ...Array.from({ length: 66 }, (_, i) => `tool_${i}`)];
    const f = fixture(healthy());
    await f.provider.complete(request(names));
    expect(f.attempts[0]).toMatchObject({ advertisedToolNames: ['z-last', ...names.slice(2, 65)], advertisedToolsTruncated: true });
    expect((f.bodies[0]?.tools as unknown[])).toHaveLength(names.length);
    expect(f.attempts[0]).not.toHaveProperty('rejectedToolName');
  });
  it('marks filtering alone as truncation and accepts empty native and text tool sets', async () => {
    const f = fixture(healthy());
    await f.provider.complete(request(['ok', 'x'.repeat(65)]));
    expect(f.attempts[0]).toMatchObject({ advertisedToolNames: ['ok'], advertisedToolsTruncated: true });
    const empty = fixture(healthy());
    await empty.provider.complete(request([]));
    expect(empty.attempts[0]).toMatchObject({ advertisedToolNames: [], advertisedToolsTruncated: false });
    const text = fixture(healthy());
    await text.provider.completeText({ ...request(), validate: value => value });
    expect(text.bodies[0]).not.toHaveProperty('tools');
    expect(text.attempts[0]).toMatchObject({ advertisedToolNames: [], advertisedToolsTruncated: false });
  });
  it.each(['network', 'json', 'generic unmetered'])('retains safe advertised scope and unknown-spend guard on %s', async kind => {
    const f = fixture({ error: { code: 502, message: 'PRIVATE_VENDOR' } }, 502);
    if (kind === 'network') f.fetch.mockRejectedValue(new Error('PRIVATE_NETWORK'));
    if (kind === 'json') f.fetch.mockResolvedValue(new Response('{PRIVATE_JSON'));
    await expect(f.provider.complete(request())).rejects.toMatchObject({ code: 'UNVERIFIED_USAGE', accountingComplete: false });
    expect(f.fetch).toHaveBeenCalledOnce(); expect(f.attempts).toHaveLength(1);
    expect(f.attempts[0]).toMatchObject({ advertisedToolNames: ['tools_select', 'reminder_create'], advertisedToolsTruncated: false, usage: null });
    expect(f.attempts[0]).not.toHaveProperty('rejectedToolName'); assertPrivate(f.attempts);
  });
  it.each(['healthy', 'rejection', 'fallback'])('isolates throwing/mutating observers on %s without changing request, result or recovery', async kind => {
    const raw = kind === 'healthy' ? healthy() : { usage, error: { code: 502, message: kind === 'rejection' ? rejection('conversation_clarify') : 'PRIVATE_VENDOR' } };
    const f = fixture(raw, 200, a => {
      (a.advertisedToolNames as string[]).splice(0, 2, 'mutated');
      (a.requestedProviders as string[])[0] = 'mutated';
      if (a.usage) (a.usage as { inputTokens: number }).inputTokens = 999;
      (a as { rejectedToolName?: string }).rejectedToolName = 'mutated';
      throw new Error('PRIVATE_OBSERVER');
    });
    const result = await f.provider.complete(request()).catch((e: unknown) => e);
    if (kind === 'rejection') expect(result).toMatchObject({ toolName: 'conversation_clarify', usage: accounted });
    else expect(result).toMatchObject({ message: { content: 'Done', toolCalls: [] }, usage: kind === 'healthy' ? accounted : { inputTokens: 24, outputTokens: 6 } });
    expect(f.fetch).toHaveBeenCalledTimes(kind === 'fallback' ? 2 : 1);
    expect(f.attempts).toHaveLength(kind === 'fallback' ? 2 : 1);
    for (const body of f.bodies) expect((body.tools as { function: { name: string } }[]).map(t => t.function.name)).toEqual(['tools_select', 'reminder_create']);
    assertPrivate(f.attempts);
  });
  it('propagates the safe projection through a fake evaluator wire into the actual report', async () => {
    const attempts: unknown[] = [];
    const f = fixture({ error: { code: 502, message: rejection('conversation_clarify'), metadata: { failed_generation: 'PRIVATE_ARGS' } } }, 200,
      a => attempts.push(evaluator.safeAttempt(a)));
    const report = await evaluator.runConversation({ forTurn: () => f.provider, attempts });
    expect(report.turns[0]?.safeAttempts).toHaveLength(1);
    expect(report.turns[0]?.safeAttempts[0]).toMatchObject({ providerErrorCode: 502, rejectedToolName: 'conversation_clarify',
      advertisedToolNames: ['tools_select', 'reminder_create', 'conversation_decide'], advertisedToolsTruncated: false, failureClass: 'unadvertised_tool_rejection', usage: null });
    expect(f.fetch).toHaveBeenCalledOnce(); assertPrivate(report.turns[0]?.safeAttempts);
  });
});

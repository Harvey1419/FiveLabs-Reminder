import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, statSync, readdirSync, rmSync, symlinkSync, realpathSync, writeSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
// The normalizer's calendar dependency imports live DB/Google modules. None are
// needed by these conversation-only cases; stop that import graph here.
vi.mock('../../../src/agent/tools/calendar.js', () => ({ sanitizeCalendarQueryAndScope: () => ({}) }));
vi.mock('../../../src/infrastructure/database/agent-runs.js', () => ({ clearAgentRunsForUser: vi.fn() }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, writeSync: vi.fn(fs.writeSync) };
});
import { callChatCompletion as complete, callMemoryExtraction, finalizeRunnerProviderTrace } from '../../../src/agent/providers/client.js';

import { getStructuredTurnSchema, projectStructuredTurnIntent, stripStructuredNulls } from '../../../src/agent/contracts/foreground-turn-schema.js';
import { expectValid } from '../../support/unit/contract-boundary.js';
import { validateTurnIntent } from '../../../src/agent/contracts/intent-contracts.js';
import { normalizeTurnIntentForRuntime } from '../../../src/agent/orchestration/intent-normalizer.js';

// Test-only views inspect the original completion and captured fetch body.
function callChatCompletion(...args: Parameters<typeof complete>) {
  return complete(...args) as Promise<{ content: string; routeStage?: string; unavailable?: boolean; refused?: boolean;
    attemptDiagnostics: Record<string, unknown> }>;
}
const intent = { actions: [{ domain: 'conversation', action: 'reply', content: 'Hola.' }] };
const options = { returnMessage: true, purpose: 'initial', responseFormat: { type: 'json_schema', json_schema: { name: 'test', strict: true, schema: { type: 'object', properties: {}, additionalProperties: false, required: [] } } } };
const envelope = (content: unknown = JSON.stringify(intent), finish: string | null = 'stop') => ({ id: 'gen-test', provider: 'Groq', choices: [{ finish_reason: finish, message: { content } }] });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const warning = () => vi.mocked(console.warn).mock.calls.map((args) => args.join(' ')).join('\n');

type TraceEvent = {
  type: string; serializedBody?: string; bodyBytes?: number;
  decision?: { content?: unknown }; result?: { valid?: boolean };
  reason?: string; attempt?: number; validation?: string;
  complete?: boolean; missingEvents?: number; events?: number;
};
const phaseFields = ['preparationMs', 'fetchMs', 'parseValidationMs'];

function expectAttemptPhases(diagnostics: Record<string, unknown>, reached = phaseFields) {
  for (const field of phaseFields) {
    expect(diagnostics).toHaveProperty(field);
    if (!reached.includes(field)) {
      expect(diagnostics[field]).toBeNull();
      continue;
    }
    expect(typeof diagnostics[field]).toBe('number');
    expect(Number.isFinite(diagnostics[field])).toBe(true);
    expect(diagnostics[field]).toBeGreaterThanOrEqual(0);
    expect(diagnostics[field]).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
  }
}

function semanticResult(result: Awaited<ReturnType<typeof callChatCompletion>>) {
  expectAttemptPhases(result.attemptDiagnostics);
  // Only local elapsed phases vary across otherwise identical provider attempts.
  const { preparationMs, fetchMs, parseValidationMs, ...measurements } = result.attemptDiagnostics;
  return { ...result, attemptDiagnostics: measurements };
}

function expectRequestMeasurements(diagnostics: Record<string, unknown>, serializedBody: string) {
  const payload = JSON.parse(serializedBody);
  expect(diagnostics).toMatchObject({
    requestBytes: Buffer.byteLength(serializedBody, 'utf8'),
    messagesBytes: Buffer.byteLength(JSON.stringify(payload.messages), 'utf8'),
    schemaBytes: Buffer.byteLength(JSON.stringify(payload.response_format.json_schema.schema), 'utf8'),
    responseFormatBytes: Buffer.byteLength(JSON.stringify(payload.response_format), 'utf8'),
    messageCount: payload.messages.length,
  });
}

function failedAttemptMetadata() {
  const line = vi.mocked(console.warn).mock.calls.map(([line]) => line)
    .find(line => line.includes(' outcome=failed ') && line.includes(' metadata='));
  expect(line).toBeDefined();
  return JSON.parse(line.slice(line.indexOf(' metadata=') + ' metadata='.length));
}

beforeEach(() => {
  vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-protocol-secret');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('synthetic runner provider evidence (offline)', () => {
  let directory: string, argv: string[];
  beforeEach(() => {
    const phone = `hermes-chat.${randomUUID()}`;
    directory = mkdtempSync(join(realpathSync(tmpdir()), `hermes-provider-trace-${phone}-`));
    argv = process.argv;
    process.argv = [argv[0]!, resolve('scripts/dev/interactive-chat.ts')];
    vi.stubEnv('HERMES_CHAT_TEST_PHONE', phone);
    vi.stubEnv('HERMES_CHAT_DISABLE_REMINDER_SCHEDULER', '1');
    vi.stubEnv('HERMES_CHAT_PROVIDER_TRACE_DIR', directory);
  });
  afterEach(() => { finalizeRunnerProviderTrace(); process.argv = argv; rmSync(directory, { recursive: true, force: true }); });
  const events = (directory: string) => readFileSync(join(directory, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as TraceEvent);

  it('captures the exact serialized fetch body and rejected raw decision without changing calls or results', async () => {
    const bodies = [envelope('{"rejected":true}'), envelope()];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(bodies[(fetchMock.mock.calls.length - 1) % 2]));
    const validate = vi.fn(raw => ({ valid: raw === JSON.stringify(intent), errorCode: 'TEST_REJECTION', intent }));
    const messages = [{ role: 'user', content: 'Synthetic prompt 😀' }];
    const opts = { ...options, correlationId: 'synthetic-turn-1', validateStructuredContent: validate };
    vi.stubEnv('HERMES_CHAT_PROVIDER_TRACE_DIR', '');
    const disabled = await callChatCompletion(messages, opts);
    expect(readdirSync(directory)).toEqual([]);
    const baseline = fetchMock.mock.calls.map(([, init]) => ({ body: init!.body as string, headers: init!.headers }));
    vi.stubEnv('HERMES_CHAT_PROVIDER_TRACE_DIR', directory);
    const enabled = await callChatCompletion(messages, opts);
    expect(semanticResult(enabled)).toEqual(semanticResult(disabled));
    expectRequestMeasurements(disabled.attemptDiagnostics, baseline[1]!.body);
    expectRequestMeasurements(enabled.attemptDiagnostics, fetchMock.mock.calls[3]![1]!.body as string);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(validate).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.slice(2).map(([, init]) => ({ body: init!.body as string, headers: init!.headers }))).toEqual(baseline);
    const captured = events(directory);
    expect(captured.filter(e => e.type === 'request').map(e => e.serializedBody)).toEqual(baseline.map(e => e.body));
    expect(captured.filter(e => e.type === 'request').map(e => e.bodyBytes))
      .toEqual(baseline.map(e => Buffer.byteLength(e.body, 'utf8')));
    expect(captured.find(e => e.type === 'response')!.decision!.content).toBe('{"rejected":true}');
    expect(captured.filter(e => e.type === 'validation').map(e => e.result!.valid)).toEqual([false, true]);
    expect(captured.find(e => e.type === 'outcome')!.reason).toBe('invalid_structured_output');
    expect(captured[0]).toMatchObject({ purpose: 'initial', correlationId: 'synthetic-turn-1', provider: ['groq'], attempt: 1,
      bodyBytes: Buffer.byteLength(baseline[0]!.body) });
    finalizeRunnerProviderTrace();
    expect(events(directory).at(-1)).toMatchObject({ type: 'completeness', complete: true });
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, 'events.jsonl')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(directory, 'events.jsonl'), 'utf8')).not.toContain('sk-or-protocol-secret');
  });

  it('bounds oversized evidence and explicitly marks missing bytes while preserving return', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(envelope()));
    const result = await callChatCompletion([{ role: 'user', content: 'x'.repeat(300000) }], options);
    expect(result.content).toBe(JSON.stringify(intent));
    expect(events(directory).find(e => e.type === 'request')).toMatchObject({ complete: false, missing: 'event_byte_limit' });
    expect(statSync(join(directory, 'events.jsonl')).size).toBeLessThan(8 * 1024 * 1024);
  });

  it('preserves the primary empty-response retry with capture enabled', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(envelope(fetchMock.mock.calls.length % 2 ? '' : JSON.stringify(intent))));
    vi.stubEnv('HERMES_CHAT_PROVIDER_TRACE_DIR', '');
    const disabled = await callChatCompletion([], options);
    const baseline = fetchMock.mock.calls.map(([, init]) => ({ body: init!.body as string, headers: init!.headers }));
    vi.stubEnv('HERMES_CHAT_PROVIDER_TRACE_DIR', directory);
    const enabled = await callChatCompletion([], options);
    expect(semanticResult(enabled)).toEqual(semanticResult(disabled));
    expectRequestMeasurements(disabled.attemptDiagnostics, baseline[1]!.body);
    expectRequestMeasurements(enabled.attemptDiagnostics, fetchMock.mock.calls[3]![1]!.body as string);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.slice(2).map(([, init]) => ({ body: init!.body as string, headers: init!.headers }))).toEqual(baseline);
    expect(events(directory).filter(e => e.type === 'request').map(e => e.serializedBody)).toEqual(baseline.map(e => e.body));
    expect(events(directory).filter(e => e.type === 'request').map(e => e.bodyBytes))
      .toEqual(baseline.map(e => Buffer.byteLength(e.body, 'utf8')));
    expect(events(directory).filter(e => e.type === 'request').map(e => e.attempt)).toEqual([1, 2]);
    expect(events(directory).filter(e => e.type === 'outcome').map(e => e.validation)).toEqual(['not_run', 'not_run']);
  });

  it('bounds aggregate bytes independently of the event limit', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(envelope()));
    for (let i = 0; i < 45; i++) await callChatCompletion([{ role: 'user', content: 'x'.repeat(200000) }], options);
    finalizeRunnerProviderTrace();
    const summary = events(directory).at(-1);
    expect(summary!.complete).toBe(false);
    expect(summary!.missingEvents).toBeGreaterThan(0);
    expect(summary!.events).toBeLessThan(1200);
    expect(statSync(join(directory, 'events.jsonl')).size).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(fetchMock).toHaveBeenCalledTimes(45);
  });

  it('refuses non-private or symlink directories without changing provider behavior', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(envelope()));
    chmodSync(directory, 0o755);
    await callChatCompletion([], options);
    expect(readdirSync(directory)).toEqual([]);
    chmodSync(directory, 0o700);
    const link = `${directory}.link`;
    try {
      symlinkSync(directory, link);
      vi.stubEnv('HERMES_CHAT_PROVIDER_TRACE_DIR', link);
      await callChatCompletion([], options);
      expect(readdirSync(directory)).toEqual([]);
    } finally { rmSync(link, { force: true }); }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warning()).toContain('Provider trace incomplete');
  });

  it('reserves a completeness marker when the aggregate event budget is exhausted', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(envelope()));
    for (let i = 0; i < 401; i++) expect((await callChatCompletion([], options)).content).toBe(JSON.stringify(intent));
    finalizeRunnerProviderTrace();
    const captured = events(directory);
    expect(captured).toHaveLength(1201);
    expect(captured.at(-1)).toMatchObject({ type: 'completeness', complete: false, missingEvents: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(401);
    expect(statSync(join(directory, 'events.jsonl')).size).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it('marks credential-bearing evidence omitted, never silently redacted', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(envelope('sk-or-protocol-secret')));
    expect((await callChatCompletion([], options)).content).toBe('sk-or-protocol-secret');
    finalizeRunnerProviderTrace();
    expect(events(directory).find(e => e.type === 'response')).toMatchObject({ complete: false, missing: 'credential_in_evidence' });
    expect(events(directory).at(-1)!.complete).toBe(false);
    expect(readFileSync(join(directory, 'events.jsonl'), 'utf8')).not.toContain('sk-or-protocol-secret');
  });

  it('marks an unfinished provider call incomplete at finalization', async () => {
    let deliver: ((response: Response) => void) | undefined;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(resolveResponse => { deliver = resolveResponse; }));
    const pending = callChatCompletion([], options);
    finalizeRunnerProviderTrace();
    const summary = events(directory).at(-1);
    deliver!(response(envelope()));
    expect((await pending).content).toBe(JSON.stringify(intent));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ complete: false, unfinishedCalls: 1 });
  });

  it('does not retry provider requests on trace IO errors and reports incomplete evidence', async () => {
    vi.mocked(writeSync).mockImplementationOnce(() => { throw new Error('synthetic disk failure'); });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(envelope()));
    expect((await callChatCompletion([], options)).content).toBe(JSON.stringify(intent));
    finalizeRunnerProviderTrace();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events(directory).at(-1)).toMatchObject({ complete: false, ioError: true });
    expect(warning()).toContain('Provider trace incomplete: event_io_error');
  });

  it('does not trace the runner parent or generic entrypoints even with trace environment set', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(envelope()));
    for (const entrypoint of ['scripts/dev/run-chat-validation.ts', 'src/app/server.ts']) {
      process.argv = [argv[0]!, resolve(entrypoint)];
      await callChatCompletion([], options);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readdirSync(directory)).toEqual([]);
  });

  it('refuses existing files/symlinks without extra provider requests or overwriting evidence', async () => {
    symlinkSync('missing-target', join(directory, 'events.jsonl'));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(envelope()));
    expect((await callChatCompletion([], options)).content).toBe(JSON.stringify(intent));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readdirSync(directory)).toEqual(['events.jsonl']);
    expect(warning()).toContain('Provider trace incomplete');
  });
});

describe('foreground provider protocol, not HTTP status alone', () => {
  it.each(['historical', 'current'])('preserves declared %s recap through mocked provider transport and runtime normalization', async mode => {
    const schema = getStructuredTurnSchema();
    const action = (operation: string, fields: Record<string, unknown>) => Object.fromEntries(Object.keys(schema.properties!.actions!.items!.properties!).map(key => [key, key === 'operation' ? operation : fields[key] ?? null]));
    const wire = { responseCapability: 'general', responseLanguage: 'en', actions: [
      action('conversation.recap', { recapMode: mode }),
      ...(mode === 'current' ? [action('task.list', { status: 'all', entityName: 'Work', query: 'Alpha', limit: 3 }), action('reminder.list', { scope: 'all_pending', query: 'Alpha', limit: 2 })] : []),
    ] };
    const responseFormat = { type: 'json_schema', json_schema: { name: 'turn', strict: true, schema } };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(envelope(JSON.stringify(wire))));
    const message = await callChatCompletion([], { ...options, responseFormat });
    const checked = validateTurnIntent(projectStructuredTurnIntent(stripStructuredNulls(JSON.parse(message.content))), { requireResponseCapability: true });
    expectValid(checked);
    const normalized = normalizeTurnIntentForRuntime(checked.intent, {});
    expect(normalized.responseCapability).toBe('general');
    expect(normalized.actions[0]).toEqual({ domain: 'conversation', action: 'recap', recapMode: mode });
    if (mode === 'current') {
      expect(normalized.actions[1]).toMatchObject({ status: 'all', entityName: 'Work', query: 'Alpha', limit: 3 });
      expect(normalized.actions[2]).toMatchObject({ scope: 'all_pending', query: 'Alpha', limit: 2 });
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).response_format.json_schema.schema).toEqual(schema);
  });
  it.each([
    [{ id: 'gen-error', error: { code: 400, message: 'generation failed', metadata: { error_type: 'max_tokens_exceeded' } } }, 'provider_error'],
    [{ ...envelope(), error: { message: 'top-level failure overrides content' } }, 'provider_error'],
    [{ choices: [{ ...envelope().choices[0], error: { message: 'choice-level failure' } }] }, 'provider_error'],
    [{}, 'invalid_response_envelope'], [null, 'invalid_response_envelope'], [[], 'invalid_response_envelope'],
    [{ choices: [] }, 'invalid_response_envelope'],
    [{ choices: [{ message: { content: '' } }] }, 'missing_finish_reason'],
    [{ choices: [{ finish_reason: 'stop' }] }, 'invalid_response_message'],
    [envelope(123), 'invalid_response_content'],
    [envelope([{ type: 'image_url', image_url: 'not text' }]), 'invalid_response_content'],
    [envelope(JSON.stringify(intent), 'length'), 'truncated_structured_output'],
    [envelope('{"actions":[', 'length'), 'truncated_structured_output'],
    [envelope('', 'length'), 'truncated_structured_output'],
    [envelope('', 'error'), 'provider_finish_error'],
    [envelope(JSON.stringify(intent), 'unknown'), 'unexpected_finish_reason'],
  ])('classifies %j as %s and skips the identical Groq retry', async (body, reason) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(body)).mockResolvedValueOnce(response({ ...envelope(), provider: 'BaseTen' }));
    const result = await callChatCompletion([{ role: 'user', content: 'Hola' }], options);
    expect(result.routeStage).toBe('secondary');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warning()).toContain(`reason=${reason}`);
    expect(warning()).not.toContain('reason=empty_content');
    expect(warning()).not.toContain('retry purpose=initial');
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).provider.only).toEqual(['groq']);
  });

  it('treats a non-JSON HTTP-200 body as protocol failure rather than a network exception', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('<html>bad gateway</html>')).mockResolvedValueOnce(response(envelope()));
    await callChatCompletion([], options);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warning()).toContain('reason=invalid_response_json');
    expect(warning()).not.toContain('reason=network_error');
  });

  it('retains the bounded retry only for a genuine complete-but-empty message', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(envelope(''))).mockResolvedValueOnce(response(envelope()));
    const result = await callChatCompletion([], options);
    expect(result.routeStage).toBe('primary');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warning()).toContain('reason=empty_content');
    expect(warning()).toContain('retry purpose=initial');
  });

  it.each([
    [{ ...envelope(), choices: [{ finish_reason: 'stop', message: { content: '', refusal: 'not allowed' } }] }, 200],
    [envelope(JSON.stringify(intent), 'content_filter'), 200],
    [envelope([{ type: 'refusal', refusal: 'not allowed' }]), 200],
    [{ error: { metadata: { error_type: 'content_policy_violation' } } }, 200],
    [{ error: { metadata: { error_type: 'refusal' } } }, 403],
    [{ error: { metadata: { raw: JSON.stringify({ error: { code: 'content_policy_violation' } }) } } }, 400],
  ])('stops on an explicit refusal without evading it through another provider', async (body, status) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(body, status));
    const result = await callChatCompletion([], options);
    expect(result.unavailable).toBe(true);
    expect(result.refused).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warning()).toContain('stopped reason=provider_refusal');
  });

  it('logs metadata and usage without leaking content, reasoning, request payloads or credentials', async () => {
    const body = {
      ...envelope('PRIVATE_CONTENT'), model: 'openai/gpt-oss-120b',
      error: { code: 400, metadata: { error_type: 'invalid_request', raw: JSON.stringify({ error: { message: 'PRIVATE_ERROR_MESSAGE Failed sk-or-protocol-secret', failed_generation: 'PRIVATE_GENERATION' } }) } },
      usage: { prompt_tokens: 100, completion_tokens: 1400, completion_tokens_details: { reasoning_tokens: 1390 } },
      request: { messages: ['PRIVATE_PROMPT'] }, reasoning: 'PRIVATE_REASONING',
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(body)).mockResolvedValueOnce(response(envelope()));
    await callChatCompletion([], options);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warning()).toContain('gen-test');
    expect(warning()).toContain('"reasoningTokens":1390');
    const metadata = failedAttemptMetadata();
    expect(metadata).toMatchObject({ outcome: 'failed', reason: 'provider_error', failureClass: 'provider_error',
      status: 200, errorCode: 400, errorType: 'invalid_request', generationId: 'gen-test',
      promptTokens: 100, completionTokens: 1400, reasoningTokens: 1390 });
    expectAttemptPhases(metadata);
    expectRequestMeasurements(metadata, fetchMock.mock.calls[0]![1]!.body as string);
    for (const field of ['message', 'detail', 'raw', 'failed_generation', 'request', 'reasoning', 'headers']) expect(metadata).not.toHaveProperty(field);
    const logs = [...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.log).mock.calls].flat().join('\n');
    for (const secret of ['PRIVATE_CONTENT', 'PRIVATE_GENERATION', 'PRIVATE_PROMPT', 'PRIVATE_REASONING',
      'PRIVATE_ERROR_MESSAGE', 'Failed', 'sk-or-protocol-secret']) expect(logs).not.toContain(secret);
  });

  it('omits thrown foreground error text and credentials while retaining typed transport diagnostics', async () => {
    const message = 'PRIVATE_TRANSPORT_MESSAGE network sk-or-protocol-secret';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error(message)).mockResolvedValueOnce(response(envelope()));
    await callChatCompletion([], options);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warning()).not.toContain('sk-or-protocol-secret');
    const metadata = failedAttemptMetadata();
    expect(metadata).toMatchObject({ outcome: 'failed', reason: 'network_error', failureClass: 'network_error',
      exceptionClass: 'Error', status: null, errorCode: null, errorType: null, parseValidationMs: null });
    expectAttemptPhases(metadata, ['preparationMs', 'fetchMs']);
    expectRequestMeasurements(metadata, fetchMock.mock.calls[0]![1]!.body as string);
    for (const field of ['message', 'detail', 'error', 'stack', 'headers']) expect(metadata).not.toHaveProperty(field);
    const logs = [...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.log).mock.calls].flat().join('\n');
    for (const secret of [message, 'PRIVATE_TRANSPORT_MESSAGE', 'network sk-or-protocol-secret', 'sk-or-protocol-secret']) expect(logs).not.toContain(secret);
  });

  it('does not impose the foreground finish contract on background memory', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(envelope('<think>hidden</think>{"memories":[]}', null)));
    expect(await callMemoryExtraction([])).toBe('{"memories":[]}');
  });

  it('fails over instead of accepting truncated background memory JSON', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(envelope('[{"topicKey":"profile/work"', 'length')))
      .mockResolvedValueOnce(response({
        ...envelope('[{"topicKey":"profile/work","category":"fact"}]'),
        provider: 'BaseTen',
      }));

    expect(await callMemoryExtraction([])).toBe('[{"topicKey":"profile/work","category":"fact"}]');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).provider.only).toEqual(['groq']);
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string).provider.only).toEqual(['baseten/fp8']);
    expect(warning()).toContain('reason=truncated_memory_output');
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('trigger=truncated_memory_output');
  });
});

import { describe, expect, it } from 'vitest';
import { measureSerializedRequest, rateLimitDiagnostics, safeFailureCode, phaseDuration } from '../../../src/agent/providers/attempt-diagnostics.js';

describe('pure attempt diagnostics', () => {
  it('measures the final UTF-8 serialization, including omitted fields and Unicode', () => {
    const body = JSON.stringify({ messages: [{ role: 'system', content: 'é😀', omitted: undefined },
      { role: 'user', content: 'history and evidence' }], temperature: undefined,
    response_format: { type: 'json_schema', json_schema: { schema: { description: '日本語' } } },
    plugins: [{ id: 'test' }], reasoning: { effort: 'medium', exclude: true } });
    const actual = JSON.parse(body);
    expect(measureSerializedRequest(body)).toEqual({ requestBytes: Buffer.byteLength(body, 'utf8'),
      messagesBytes: Buffer.byteLength(JSON.stringify(actual.messages), 'utf8'),
      schemaBytes: Buffer.byteLength(JSON.stringify(actual.response_format.json_schema.schema), 'utf8'),
      responseFormatBytes: Buffer.byteLength(JSON.stringify(actual.response_format), 'utf8'), messageCount: 2 });
    expect(measureSerializedRequest(body).requestBytes).toBeGreaterThan(body.length);
  });

  it('keeps measurements not reached unknown, including absent components', () => {
    expect(measureSerializedRequest(null)).toEqual({ requestBytes: null, messagesBytes: null,
      schemaBytes: null, responseFormatBytes: null, messageCount: null });
    expect(measureSerializedRequest('{"messages":[]}')).toMatchObject({ messageCount: 0, messagesBytes: 2,
      schemaBytes: null, responseFormatBytes: null });
    expect(phaseDuration(null, 4)).toBeNull();
    expect(phaseDuration(2, 4.5)).toBe(2.5);
    expect(phaseDuration(5, 4)).toBeNull();
  });

  it.each([
    [429, { error: { code: 429, metadata: { provider_name: 'Groq' } } }, 'upstream', 'Groq'],
    [200, { error: { code: 429, metadata: { provider_name: 'Cerebras' } } }, 'upstream', 'Cerebras'],
    [429, { error: { code: 429, metadata: { provider_name: 'OpenRouter' } } }, 'openrouter_platform', 'OpenRouter'],
    [429, { error: { code: 429 } }, 'uncertain', null],
    [429, { error: { code: 429, metadata: { provider_name: 'private-project' } } }, 'uncertain', null],
    [429, { error: { metadata: { provider_name: 'Groq' } } }, 'uncertain', 'Groq'],
    [429, { error: { code: 429, metadata: { provider_name: 'Groq', raw: { error: { code: 400 } } } } }, 'uncertain', 'Groq'],
    [429, { error: { code: 429, metadata: { provider_name: 'OpenRouter', raw: { error: { code: 429 } } } } }, 'uncertain', 'OpenRouter'],
    [200, { choices: [{ error: { code: '429', metadata: { provider_name: 'Baseten', raw: '{"error":{"code":429}}' } } }] }, 'upstream', 'Baseten'],
  ])('classifies observed evidence independently of requested routing: %j %j', (status, data, source, provider) => {
    expect(rateLimitDiagnostics({ status, data })).toMatchObject({ failureClass: 'rate_limit', rateLimitSource: source, observedProvider: provider });
  });

  it.each([200, 429])('keeps contradictory typed codes uncertain at HTTP %i in either nesting direction', status => {
    for (const provider of ['Groq', 'OpenRouter', null, 'private-project']) {
      for (const [outer, inner] of [[400, 429], [429, 400], ['400', 429], [429, '400']]) {
        const data = { error: { code: outer, metadata: { provider_name: provider,
          raw: { error: { code: inner } } } } };
        expect(rateLimitDiagnostics({ status, data, requestedProvider: 'groq', headers: new Headers({
          'X-RateLimit-Limit': '100', 'X-RateLimit-Remaining': '0',
        }) })).toMatchObject({ failureClass: 'rate_limit', rateLimitSource: 'uncertain',
          observedProvider: ['Groq', 'OpenRouter'].includes(provider || '') ? provider : null });
      }
    }
  });

  it.each([200, 429])('checks provider-code conflicts against outer and raw codes at HTTP %i', status => {
    for (const [outer, providerCode, inner] of [[429, 400, 429], [400, 429, null], [null, 400, 429]]) {
      expect(rateLimitDiagnostics({ status, data: { error: { code: outer, metadata: {
        provider_name: 'Groq', provider_code: providerCode, raw: { error: { code: inner } },
      } } } })).toMatchObject({ failureClass: 'rate_limit', rateLimitSource: 'uncertain' });
    }
    expect(rateLimitDiagnostics({ status, headers: new Headers({ 'X-RateLimit-Limit': '100' }),
      data: { error: { code: 429, metadata: { provider_name: 'OpenRouter', provider_code: 400 } } },
    })).toMatchObject({ failureClass: 'rate_limit', rateLimitSource: 'uncertain', observedProvider: 'OpenRouter' });
    expect(rateLimitDiagnostics({ status, data: { error: { code: 'invalid_request_error', metadata: {
      provider_name: 'Groq', raw: { error: { code: 429 } },
    } } } })).toMatchObject({ failureClass: 'rate_limit', rateLimitSource: 'uncertain' });
  });

  it.each([200, 429])('retains upstream provenance for equivalent typed codes at HTTP %i', status => {
    for (const [outer, providerCode, inner] of [[429, 429, 429], ['429', '429', '429'], ['429', 429, '429']]) {
      expect(rateLimitDiagnostics({ status, data: { error: { code: outer, metadata: {
        provider_name: 'Groq', provider_code: providerCode, raw: { error: { code: inner } },
      } } } })).toMatchObject({ failureClass: 'rate_limit', rateLimitSource: 'upstream', errorCode: 429 });
    }
  });

  it('ignores invalid codes without leaking them or treating them as provenance', () => {
    for (const code of ['PRIVATE_USER sk-secret', 'private-project', 99, 600, {}, null]) {
      const diagnostics = rateLimitDiagnostics({ status: 429, data: { error: { code,
        metadata: { provider_name: 'Groq', provider_code: code, raw: { error: { code } } } } } });
      expect(diagnostics).toMatchObject({ rateLimitSource: 'uncertain', errorCode: null });
      expect(JSON.stringify(diagnostics)).not.toMatch(/PRIVATE_USER|sk-secret|private-project/);
      expect(rateLimitDiagnostics({ status: 200, data: { error: { code, metadata: {
        provider_name: 'Groq', raw: { error: { code: '429' } },
      } } } })).toMatchObject({ failureClass: 'rate_limit', rateLimitSource: 'upstream', errorCode: 429 });
    }
  });

  it.each([400, '400', 'invalid_request_error', 'json_validate_failed'])('preserves non-rate-limit classification for safe code %j', code => {
    expect(rateLimitDiagnostics({ status: 200, data: { error: { code, metadata: {
      provider_name: 'Groq', raw: { error: { code } },
    } } } })).toMatchObject({ failureClass: null, rateLimitSource: null, errorCode: safeFailureCode(code) });
  });

  it('does not treat rate-limit headers or requested providers as provenance', () => {
    expect(rateLimitDiagnostics({ status: 429, requestedProvider: 'groq', headers: new Headers({
      'X-RateLimit-Limit': '100', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1900000000',
    }) })).toMatchObject({ rateLimitSource: 'uncertain', observedProvider: null, rateLimitLimit: 100,
      rateLimitRemaining: 0, rateLimitReset: 1900000000 });
  });

  it('validates bounded numeric and HTTP-date Retry-After without scheduling requests', () => {
    const nowMs = Date.parse('Wed, 21 Oct 2015 07:28:00 GMT');
    for (const [value, seconds] of [['12', 12], ['0', 0], ['Wed, 21 Oct 2015 07:28:30 GMT', 30]]) {
      expect(rateLimitDiagnostics({ status: 429, nowMs, headers: new Headers(value === undefined ? {} : { 'Retry-After': String(value) }) }).retryAfterSeconds).toBe(seconds);
    }
    for (const value of ['-1', '1.5', 'Infinity', '999999999999999999', '2026-01-01', 'Wed, 32 Oct 2015 07:28:30 GMT', 'user@example.test']) {
      expect(rateLimitDiagnostics({ status: 429, nowMs, headers: new Headers(value === undefined ? {} : { 'Retry-After': String(value) }) }).retryAfterSeconds).toBeNull();
    }
  });

  it('rejects malformed counters, reset dates and all freeform diagnostic fields', () => {
    const data = { error: { code: 'PRIVATE_USER sk-secret', type: 'private@example.test',
      message: 'PRIVATE_USER', metadata: { provider_name: 'private@example.test', raw: 'sk-secret' } } };
    const diagnostics = rateLimitDiagnostics({ status: 429, data, headers: new Headers({
      'X-RateLimit-Limit': '1.5', 'X-RateLimit-Remaining': '-1', 'X-RateLimit-Reset': '2026-01-01',
      'X-Request-ID': 'PRIVATE_USER', 'Retry-After': 'sk-secret',
    }) });
    expect(diagnostics).toMatchObject({ observedProvider: null, errorCode: null, errorType: null,
      rateLimitLimit: null, rateLimitRemaining: null, rateLimitReset: null, retryAfterSeconds: null });
    expect(JSON.stringify(diagnostics)).not.toMatch(/PRIVATE_USER|sk-secret|private@example/);
    expect(safeFailureCode('json_validate_failed')).toBe('json_validate_failed');
    expect(safeFailureCode('INVALID_PARAMETERS')).toBe('INVALID_PARAMETERS');
    expect(safeFailureCode('private-project')).toBeNull();
  });

  it.each(['1.5', '-1', 'Infinity', '9007199254740992', '4102444801', 'Tue, 32 Oct 2026 00:00:00 GMT'])('rejects malformed or unbounded reset timestamps: %s', value => {
    expect(rateLimitDiagnostics({ headers: new Headers({ 'X-RateLimit-Reset': value }) }).rateLimitReset).toBeNull();
  });

  it('accepts a validated canonical reset date and leaves absent headers unknown', () => {
    expect(rateLimitDiagnostics({ headers: new Headers({ 'X-RateLimit-Reset': 'Wed, 21 Oct 2015 07:28:00 GMT' }) }).rateLimitReset).toBe(1445412480);
    expect(rateLimitDiagnostics()).toMatchObject({ failureClass: null, rateLimitSource: null, retryAfterSeconds: null,
      rateLimitLimit: null, rateLimitRemaining: null, rateLimitReset: null });
  });
});

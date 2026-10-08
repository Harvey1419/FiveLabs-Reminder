/**
 * Production AI gateway.
 *
 * Foreground routing is explicit and latency-bounded:
 *   1. GPT-OSS 120B on Groq
 *   2. GPT-OSS 120B on Cerebras FP16
 *   3. GLM 5.3 Flash on Baseten FP8
 *
 * OpenRouter implicit provider fallbacks are disabled. Hermes owns the route,
 * validates the canonical execute_turn boundary, and never returns to a provider
 * that already failed during the same foreground turn.
 */

import { responseVoice } from '../contracts/response-policy.js';
import { buildRequestPayload } from './request-payload.js';
import { openSync, writeSync, closeSync, lstatSync, realpathSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { measureSerializedRequest, phaseDuration, rateLimitDiagnostics, knownProvider,
  safeCounter, safeFailureCode, safeExceptionClass } from './attempt-diagnostics.js';

// Evidence is deliberately unavailable to the server or runner parent. Only the
// synthetic interactive child can open the runner-created private directory.
const traceEntrypoint = fileURLToPath(new URL('../../../scripts/dev/interactive-chat.js', import.meta.url));
const TRACE_BYTES = 8 * 1024 * 1024;
const TRACE_EVENT_BYTES = 256 * 1024;
const TRACE_EVENTS = 1200;
let runnerTrace = null;

export function finalizeRunnerProviderTrace() {
  const trace = runnerTrace;
  if (!trace || trace.closed) return;
  trace.closed = true;
  process.removeListener('exit', finalizeRunnerProviderTrace);
  try {
    const summary = JSON.stringify({ type: 'completeness', complete: !trace.missing && !trace.ioError && !trace.pending,
      unfinishedCalls: trace.pending, events: trace.events, bytesBeforeSummary: trace.bytes, missingEvents: trace.missing,
      ioError: trace.ioError, limits: { bytes: TRACE_BYTES, eventBytes: TRACE_EVENT_BYTES, events: TRACE_EVENTS },
      responseEnvelope: 'not_captured; raw decision only', headers: 'never_captured' }) + '\n';
    trace.write(summary);
  } catch { console.warn('Provider trace incomplete: finalization_io_error'); }
  finally { try { closeSync(trace.fd); } catch { /* already reported as incomplete */ } }
}

function getRunnerTrace() {
  const directory = process.env.HERMES_CHAT_PROVIDER_TRACE_DIR;
  if (!directory) return null;
  const phone = process.env.HERMES_CHAT_TEST_PHONE;
  if (resolve(process.argv[1] || '') !== traceEntrypoint
    || process.env.HERMES_CHAT_DISABLE_REMINDER_SCHEDULER !== '1'
    || !/^hermes-chat\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(phone || '')) return null;
  if (runnerTrace?.directory === directory) return runnerTrace.closed ? null : runnerTrace;
  if (runnerTrace && !runnerTrace.closed) return null;
  // Remember initialization failures too: trace IO must never cause a retry.
  runnerTrace = { directory, closed: true };
  try {
    const canonicalTmp = realpathSync(tmpdir());
    const stat = lstatSync(directory);
    if (dirname(directory) !== canonicalTmp || realpathSync(directory) !== directory
      || !basename(directory).startsWith(`hermes-provider-trace-${phone}-`)
      || !/^[a-zA-Z0-9.-]+$/.test(basename(directory))
      || !stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700
      || stat.uid !== process.getuid?.()) throw new Error('unsafe_directory');
    const fd = openSync(join(directory, 'events.jsonl'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const trace = { directory, fd, closed: false, events: 0, bytes: 0, missing: 0, ioError: false, calls: 0, pending: 0 };
    trace.write = text => {
      const bytes = Buffer.from(text, 'utf8');
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (!written) throw new Error('short_write');
        offset += written;
      }
      trace.bytes += bytes.length;
    };
    trace.emit = (metadata, type, evidence, apiKey) => {
      if (trace.closed || trace.ioError) { trace.missing++; return; }
      try {
        if (evidence.missing) trace.missing++;
        const serialized = JSON.stringify({ ...metadata, type, complete: !evidence.missing, ...evidence });
        const evidenceBytes = Buffer.byteLength(serialized);
        let line = serialized + '\n';
        const missing = serialized.includes(apiKey) ? 'credential_in_evidence' : evidenceBytes > TRACE_EVENT_BYTES ? 'event_byte_limit' : null;
        if (missing) {
          trace.missing++;
          // Do not silently redact or truncate protocol evidence.
          line = JSON.stringify({ call: metadata.call, type, complete: false, missing, originalBytes: evidenceBytes }) + '\n';
        }
        if (trace.events >= TRACE_EVENTS || trace.bytes + Buffer.byteLength(line) > TRACE_BYTES - 2048) {
          trace.missing++; return;
        }
        trace.write(line);
        trace.events++;
      } catch {
        trace.ioError = true; trace.missing++;
        console.warn('Provider trace incomplete: event_io_error');
      }
    };
    runnerTrace = trace;
    process.once('exit', finalizeRunnerProviderTrace);
    return trace;
  } catch {
    console.warn('Provider trace incomplete: initialization_failed (no evidence file opened)');
    return null;
  }
}

async function callOpenRouterAttempt(messages, model, apiKey, options = {}) {
  const trace = getRunnerTrace();
  const state = { response: false, validation: false };
  if (trace) trace.pending++;
  const metadata = trace ? { call: ++trace.calls, purpose: options.purpose || 'unspecified',
    correlationId: options.correlationId ?? null, model, provider: options.providers || [],
    stage: options.stage || 'direct', attempt: options.attemptNumber || 1 } : null;
  const capture = trace ? (type, evidence) => {
    if (type === 'response') state.response = true;
    if (type === 'validation') state.validation = true;
    trace.emit(metadata, type, evidence, apiKey);
  } : null;
  const result = await performOpenRouterAttempt(messages, model, apiKey, { ...options, capture });
  capture?.('outcome', { ok: result.ok, reason: result.reason ?? null,
    ...(!state.response ? { missing: 'response_decision_unavailable' } : {}),
    terminal: Boolean(result.terminal), response: state.response ? 'captured_or_marked_missing' : 'missing_transport_or_json_failure',
    validation: state.validation ? 'captured_or_marked_missing' : 'not_run' });
  if (trace) trace.pending--;
  return result;
}

function parseProviderList(value, defaults) {
  const configured = value
    ?.split(',')
    .map((provider) => provider.trim())
    .filter(Boolean);
  return configured?.length ? configured : defaults;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const fallbackModelAlias = process.env.OPENROUTER_FALLBACK_MODEL;
const fallbackProvidersAlias = process.env.OPENROUTER_FALLBACK_PROVIDERS;

export const MODEL_CONFIG = Object.freeze({
  openrouter: Object.freeze({
    primary: process.env.OPENROUTER_PRIMARY_MODEL || 'openai/gpt-oss-120b',
    primaryProviders: Object.freeze(parseProviderList(process.env.OPENROUTER_PRIMARY_PROVIDERS, ['groq'])),
    secondary: process.env.OPENROUTER_SECONDARY_MODEL || 'z-ai/glm-5.3-flash',
    secondaryProviders: Object.freeze(parseProviderList(process.env.OPENROUTER_SECONDARY_PROVIDERS, ['baseten/fp8'])),
    strictSecondary: process.env.OPENROUTER_STRICT_SECONDARY_MODEL || 'openai/gpt-oss-120b',
    strictSecondaryProviders: Object.freeze(parseProviderList(
      process.env.OPENROUTER_STRICT_SECONDARY_PROVIDERS,
      ['cerebras/fp16'],
    )),
    lastResort: process.env.OPENROUTER_LAST_RESORT_MODEL || fallbackModelAlias || 'qwen/qwen3.7-flash',
    lastResortProviders: Object.freeze(parseProviderList(
      process.env.OPENROUTER_LAST_RESORT_PROVIDERS || fallbackProvidersAlias,
      ['alibaba'],
    )),
    strictLastResort: process.env.OPENROUTER_STRICT_FALLBACK_MODEL || 'z-ai/glm-5.3-flash',
    strictLastResortProviders: Object.freeze(parseProviderList(
      process.env.OPENROUTER_STRICT_FALLBACK_PROVIDERS,
      ['baseten/fp8'],
    )),
    memoryPrimary: process.env.OPENROUTER_MEMORY_PRIMARY_MODEL || 'openai/gpt-oss-120b',
    memoryPrimaryProviders: Object.freeze(parseProviderList(process.env.OPENROUTER_MEMORY_PRIMARY_PROVIDERS, ['groq'])),
    memorySecondary: process.env.OPENROUTER_MEMORY_SECONDARY_MODEL || 'z-ai/glm-5.3-flash',
    memorySecondaryProviders: Object.freeze(parseProviderList(process.env.OPENROUTER_MEMORY_SECONDARY_PROVIDERS, ['baseten/fp8'])),
  }),
});

export function getOpenRouterApiKey() {
  return process.env.OPENROUTER_API_KEY?.replace(/"/g, '').trim()
    || (process.env.AI_API_KEY?.startsWith('sk-or-') ? process.env.AI_API_KEY.trim() : null);
}

function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function cleanModelText(value) {
  return String(value || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim();
}

function parseErrorEnvelope(rawBody) {
  if (!rawBody) return null;
  try { return JSON.parse(rawBody); } catch { return null; }
}

function providerFailureFields(data) {
  const error = data?.error || data?.choices?.[0]?.error || data;
  const nested = providerErrorObject(error);
  return {
    code: String(nested?.code ?? error?.code ?? '').toLowerCase(),
    type: String(nested?.type ?? error?.type ?? error?.metadata?.error_type ?? '').toLowerCase(),
    param: String(nested?.param ?? error?.param ?? '').toLowerCase(),
    message: String(nested?.message ?? error?.message ?? '').toLowerCase(),
  };
}

function classifyProtocolFailure(data) {
  const fields = providerFailureFields(data);
  const joined = `${fields.code} ${fields.type} ${fields.param} ${fields.message}`;
  if (fields.message.includes('generated json does not match')
    || fields.message.includes('output became abnormal while generating a json response')
    || fields.code.includes('json_validate')
    || fields.type.includes('json_validation')) return 'structured_generation_rejection';
  if (fields.param === 'response_format'
    || fields.message.includes('invalid schema')
    || fields.message.includes('schema produces a constraint')
    || fields.code.includes('invalid_json_schema')
    || fields.type.includes('invalid_json_schema')) return 'schema_rejection';
  if (fields.message.includes('no endpoints found that can handle the requested parameters')) return 'provider_incompatible';
  if (joined.includes('structured_outputs') || joined.includes('structured output')
    || joined.includes('response_format') || joined.includes('require_parameters')) return 'provider_incompatible';
  return 'provider_error';
}

function classifyHttpFailure(status, data = null) {
  if (status === 429) return 'rate_limit';
  if (status === 408 || status === 504) return 'upstream_timeout';
  if (status === 401 || status === 403) return 'authentication_or_permission';
  if (status >= 500) return 'upstream_unavailable';
  if ([400, 404, 409, 415, 422].includes(status) && data) {
    const protocolFailure = classifyProtocolFailure(data);
    if (protocolFailure !== 'provider_error') return protocolFailure;
  }
  return `http_${status}`;
}

function classifyThrownFailure(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || /timed?\s*out/i.test(error?.message || '')) {
    return 'timeout';
  }
  return 'network_error';
}

function compactErrorBody(rawBody, { includeProviderDetails = false, apiKey = null } = {}) {
  if (!rawBody) return '';
  let message = rawBody;
  try {
    const parsed = JSON.parse(rawBody);
    message = parsed?.error?.message || parsed?.message || rawBody;
    if (includeProviderDetails) {
      // OpenRouter's generic wrapper can hide the actual strict-schema rejection.
      // Read only diagnostic fields, never dump headers, requests or failed_generation.
      const metadata = parsed?.error?.metadata;
      let providerBody = metadata?.raw;
      if (typeof providerBody === 'string') {
        try { providerBody = JSON.parse(providerBody); }
        catch { providerBody = { message: providerBody }; }
      }
      const providerError = providerBody?.error || providerBody;
      const details = {};
      for (const [key, value] of Object.entries({
        provider: metadata?.provider_name,
        type: providerError?.type ?? metadata?.error_type ?? parsed?.error?.type,
        code: providerError?.code ?? metadata?.provider_code ?? parsed?.error?.code,
        param: providerError?.param ?? parsed?.error?.param,
        message: providerError?.message ?? parsed?.error?.message ?? parsed?.message,
      })) {
        if (typeof value !== 'string' && typeof value !== 'number') continue;
        const text = String(value);
        details[key] = (apiKey ? text.split(apiKey).join('[REDACTED]') : text)
          .slice(0, key === 'message' ? 800 : 160);
      }
      message = Object.keys(details).length
        ? JSON.stringify(details)
        : 'Provider returned an unrecognized error envelope.';
    }
  } catch {
    // Non-JSON HTTP failures retain the existing bounded plain-text diagnostic.
  }
  const text = includeProviderDetails && apiKey
    ? String(message).split(apiKey).join('[REDACTED]')
    : String(message);
  return text.replace(/\s+/g, ' ').slice(0, includeProviderDetails ? 1600 : 240);
}

function compactProviderFinishDetail(choice, data) {
  const detail = choice?.error?.message
    || choice?.error
    || data?.error?.message
    || data?.error
    || choice?.native_finish_reason
    || '';
  if (!detail) return '';
  return String(typeof detail === 'string' ? detail : JSON.stringify(detail))
    .replace(/\s+/g, ' ')
    .slice(0, 240);
}

function providerErrorObject(error) {
  let raw = error?.metadata?.raw;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = null; }
  }
  return raw?.error || raw || error;
}

function isProviderRefusal(data, choice = {}) {
  const message = choice?.message;
  if (message?.refusal || choice?.finish_reason === 'content_filter') return true;
  if (Array.isArray(message?.content) && message.content.some((part) => part?.type === 'refusal')) return true;
  const error = data?.error || choice?.error;
  const nested = providerErrorObject(error);
  const refusalCodes = new Set(['content_filter', 'content_policy_violation', 'moderation_blocked', 'refusal', 'safety']);
  return [error?.code, error?.type, error?.metadata?.error_type, nested?.code, nested?.type]
    .some((code) => refusalCodes.has(code));
}

function structuredResponseDiagnostic(data, choice, apiKey) {
  // Protocol/usage metadata only: no message content, reasoning or request body.
  const scalar = (value) => typeof value === 'string'
    ? value.split(apiKey).join('[REDACTED]').slice(0, 160)
    : typeof value === 'number' && Number.isFinite(value) ? value : null;
  const usage = data?.usage;
  return JSON.stringify({
    generationId: scalar(data?.id),
    provider: scalar(data?.provider),
    model: scalar(data?.model),
    finishReason: scalar(choice?.finish_reason),
    nativeFinishReason: scalar(choice?.native_finish_reason),
    choicesCount: Array.isArray(data?.choices) ? data.choices.length : null,
    contentChars: extractTextContent(choice?.message?.content).length,
    promptTokens: scalar(usage?.prompt_tokens),
    completionTokens: scalar(usage?.completion_tokens),
    reasoningTokens: scalar(usage?.completion_tokens_details?.reasoning_tokens),
  });
}

// OpenRouter reasoning tokens are a subset of completion tokens, not additive.
// Keep missing counters undefined in the returned usage schema; telemetry uses
// null for unknown so an absent counter is never mistaken for measured zero.
function responseUsage(usage) {
  return {
    promptTokens: usage?.prompt_tokens,
    completionTokens: usage?.completion_tokens,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens,
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens,
  };
}

function successTelemetry(data, { apiKey, correlationId, purpose, stage, model, provider, finishReason, toolCalls, latencyMs }) {
  // Allowlist bounded metadata only. Reject freeform strings and credentials;
  // never serialize the response envelope, messages, output or error details.
  const identifier = (value) => typeof value === 'string'
    && /^[a-zA-Z0-9][a-zA-Z0-9_./: -]{0,159}$/.test(value)
    && !(apiKey && value.includes(apiKey)) ? value : null;
  const counter = safeCounter;
  const usage = responseUsage(data?.usage);
  return {
    outcome: 'success',
    // Correlation can originate in a freeform HTTP header, not a provider enum.
    requestId: typeof correlationId === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(correlationId)
      ? identifier(correlationId) : null,
    generationId: identifier(data?.id),
    purpose: identifier(purpose),
    stage: identifier(stage),
    model: identifier(data?.model) || identifier(model),
    provider: knownProvider(provider),
    finishReason: identifier(finishReason),
    toolCalls: counter(toolCalls),
    promptTokens: counter(usage.promptTokens),
    completionTokens: counter(usage.completionTokens),
    reasoningTokens: counter(usage.reasoningTokens),
    cachedTokens: counter(usage.cachedTokens),
    latencyMs: counter(latencyMs),
  };
}

function unavailableText(language = 'es') {
  return language === 'en'
    ? 'I could not complete that action right now. Please try again in a moment.'
    : 'No pude completar esa acción en este momento. Inténtalo nuevamente en un momento.';
}

function buildUnavailableResponse(returnMessage, reason = 'compatible_routes_exhausted', language = 'es') {
  const unavailable = {
    type: 'chat',
    tool: null,
    params: {},
    intent: 'chat',
    reply: unavailableText(language),
  };
  return returnMessage
    ? { role: 'assistant', content: unavailable.reply, tool_calls: [], unavailable: true, unavailableReason: reason }
    : JSON.stringify(unavailable);
}

function createForegroundProfiles({ strictStructuredOutput = false } = {}) {
  const config = MODEL_CONFIG.openrouter;
  return [
    {
      stage: 'primary',
      model: config.primary,
      providers: config.primaryProviders,
      timeoutMs: positiveNumber(process.env.OPENROUTER_PRIMARY_TIMEOUT_MS, 6000),
      reasoning: {
        effort: process.env.OPENROUTER_PRIMARY_REASONING_EFFORT || 'medium',
        exclude: true,
      },
      parallelToolCalls: undefined,
      // Keep one retry only for a malformed/empty structured response. Provider
      // finish errors skip immediately to the independent fallback below.
      emptyContentRetries: 1,
      supportsStrictStructuredOutputs: true,
    },
    {
      stage: 'secondary',
      model: strictStructuredOutput ? config.strictSecondary : config.secondary,
      providers: strictStructuredOutput ? config.strictSecondaryProviders : config.secondaryProviders,
      timeoutMs: positiveNumber(process.env.OPENROUTER_SECONDARY_TIMEOUT_MS, 3500),
      reasoning: {
        effort: strictStructuredOutput
          ? process.env.OPENROUTER_STRICT_SECONDARY_REASONING_EFFORT || 'medium'
          : process.env.OPENROUTER_SECONDARY_REASONING_EFFORT || 'low',
        exclude: true,
      },
      parallelToolCalls: undefined,
      // Fallback endpoints are not assumed to support tool_choice=required. We
      // send auto but still reject any prose-only response at the Hermes boundary.
      requiredToolChoiceSupported: false,
      supportsStrictStructuredOutputs: true,
    },
    {
      stage: 'last_resort',
      model: strictStructuredOutput ? config.strictLastResort : config.lastResort,
      providers: strictStructuredOutput ? config.strictLastResortProviders : config.lastResortProviders,
      timeoutMs: positiveNumber(
        strictStructuredOutput ? process.env.OPENROUTER_STRICT_FALLBACK_TIMEOUT_MS : process.env.OPENROUTER_LAST_RESORT_TIMEOUT_MS,
        3500,
      ),
      reasoning: strictStructuredOutput ? {
        effort: process.env.OPENROUTER_STRICT_FALLBACK_REASONING_EFFORT || 'low',
        exclude: true,
      } : null,
      parallelToolCalls: undefined,
      requiredToolChoiceSupported: false,
      minCompletionTokens: 2800,
      supportsStrictStructuredOutputs: strictStructuredOutput,
      supportsTemperature: true,
    },
  ];
}

function createBackgroundProfiles() {
  const config = MODEL_CONFIG.openrouter;
  return [
    {
      stage: 'memory_primary',
      model: config.memoryPrimary,
      providers: config.memoryPrimaryProviders,
      timeoutMs: positiveNumber(process.env.OPENROUTER_MEMORY_PRIMARY_TIMEOUT_MS, 9000),
      reasoning: {
        effort: process.env.OPENROUTER_MEMORY_PRIMARY_REASONING_EFFORT || 'low',
        exclude: true,
      },
    },
    {
      stage: 'memory_secondary',
      model: config.memorySecondary,
      providers: config.memorySecondaryProviders,
      timeoutMs: positiveNumber(process.env.OPENROUTER_MEMORY_SECONDARY_TIMEOUT_MS, 15000),
      reasoning: {
        effort: process.env.OPENROUTER_SECONDARY_REASONING_EFFORT || 'minimal',
        exclude: true,
      },
    },
    {
      stage: 'memory_last_resort',
      model: config.lastResort,
      providers: config.lastResortProviders,
      timeoutMs: positiveNumber(process.env.OPENROUTER_LAST_RESORT_TIMEOUT_MS, 20000),
      reasoning: null,
    },
  ];
}

async function performOpenRouterAttempt(messages, model, apiKey, {
  temperature = 0,
  max_tokens = 800,
  timeoutMs = 15000,
  providers = null,
  allowProviderFallbacks = false,
  responseFormat = null,
  tools = null,
  toolChoice = 'auto',
  parallelToolCalls,
  reasoning = null,
  returnMessage = false,
  logPrefix = '[ai-client]',
  purpose = 'unspecified',
  stage = 'direct',
  correlationId = null,
  validateStructuredContent = null,
  capture = null,
} = {}) {
  const startMs = Date.now();
  const preparationStart = performance.now();
  let fetchStart = null;
  let parseStart = null;
  let preparationMs = null;
  let fetchMs = null;
  let measurements = measureSerializedRequest(null);
  let responseStatus = null;
  let responseHeaders = null;
  const requestedProviders = providers?.length ? providers : [];
  const strictForeground = responseFormat?.type === 'json_schema';
  const diagnostics = data => {
    const end = performance.now();
    return { ...measurements, status: responseStatus,
      preparationMs: preparationMs ?? phaseDuration(preparationStart, end),
      fetchMs: fetchMs ?? phaseDuration(fetchStart, end),
      parseValidationMs: phaseDuration(parseStart, end),
      ...rateLimitDiagnostics({ status: responseStatus, data, headers: responseHeaders, nowMs: Date.now() }) };
  };
  const safePrefix = metadata => {
    const category = logPrefix === '[ai-memory]' ? 'ai-memory'
      : logPrefix === '[ai-response]' || logPrefix?.startsWith('[ai-response req=') ? 'ai-response' : 'ai-client';
    return `[${category}${metadata.requestId ? ` req=${metadata.requestId}` : ''}]`;
  };
  const field = value => value === null ? 'unknown' : typeof value === 'number' ? value
    : /^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,159}$/.test(value) ? value : 'unknown';
  const failStructured = (reason, data, choice, { terminal = false, validationCode = null, exceptionClass = null } = {}) => {
    const attemptDiagnostics = diagnostics(data);
    const metadata = { ...successTelemetry(data, { apiKey, correlationId, purpose, stage, model,
      provider: requestedProviders[0], finishReason: ['stop', 'length', 'error', 'tool_calls', 'content_filter'].includes(choice?.finish_reason) ? choice.finish_reason : null,
      toolCalls: null, latencyMs: Date.now() - startMs }),
    ...attemptDiagnostics, outcome: 'failed', reason,
    failureClass: attemptDiagnostics.failureClass || reason, status: responseStatus,
    validationCode: safeFailureCode(validationCode), exceptionClass: safeExceptionClass(exceptionClass) };
    if (logPrefix) {
      console.warn(`${safePrefix(metadata)} attempt purpose=${field(metadata.purpose)} stage=${field(metadata.stage)} model=${field(metadata.model)} provider=${field(metadata.provider)} outcome=failed reason=${reason}${metadata.validationCode ? ` validationCode=${metadata.validationCode}` : ''}${responseStatus !== null ? ` status=${responseStatus}` : ''} latencyMs=${metadata.latencyMs} metadata=${JSON.stringify(metadata)}`);
    }
    return { ok: false, reason, terminal, finishReason: choice?.finish_reason || null,
      ...(responseStatus !== null ? { status: responseStatus } : {}), attemptDiagnostics: metadata };
  };

  try {
    const payload = buildRequestPayload(messages, model, { temperature, max_tokens,
      responseFormat, tools, toolChoice, parallelToolCalls, reasoning,
      providers: requestedProviders, allowProviderFallbacks });
    const serializedBody = JSON.stringify(payload);
    measurements = measureSerializedRequest(serializedBody);
    capture?.('request', { serializedBody, bodyBytes: Buffer.byteLength(serializedBody), encoding: 'utf8',
      transportBoundary: 'fetch_argument; network_delivery_not_asserted' });
    preparationMs = phaseDuration(preparationStart, performance.now());
    fetchStart = performance.now();
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://fivelabs.co',
        'X-Title': 'Hermes Assistant',
      },
      body: serializedBody,
      signal: AbortSignal.timeout(timeoutMs),
    });
    fetchMs = phaseDuration(fetchStart, performance.now());
    parseStart = performance.now();
    responseStatus = res.status;
    responseHeaders = res.headers;

    if (!res.ok) {
      const rawBody = await res.text().catch(() => '');
      capture?.('response', { status: res.status, decision: null,
        missing: 'http_error_decision_unavailable; error envelope not captured (may contain headers)' });
      const errorData = parseErrorEnvelope(rawBody);
      const reason = classifyHttpFailure(res.status, errorData);
      return failStructured(reason, errorData, null, { terminal: strictForeground && isProviderRefusal(errorData) });
    }

    let data;
    try { data = await res.json(); }
    catch (error) {
      if (strictForeground) return failStructured('invalid_response_json', null, null, { exceptionClass: error?.name });
      throw error;
    }
    const choice = data?.choices?.[0] || {};
    capture?.('response', { status: res.status, provider: data?.provider ?? null,
      decision: { content: choice?.message?.content ?? null, tool_calls: choice?.message?.tool_calls ?? null,
        refusal: choice?.message?.refusal ?? null }, finishReason: choice?.finish_reason ?? null,
      ...(data?.error || choice?.error ? { missing: 'provider_error_envelope_not_captured (may contain headers)' } : {}) });
    if (strictForeground) {
      // OpenRouter can return an error-only JSON body with HTTP 200 and no choices.
      // Inspect it BEFORE treating a missing message as an empty completion.
      if (isProviderRefusal(data, choice)) return failStructured('provider_refusal', data, choice, { terminal: true });
      if (data?.error || choice?.error) return failStructured(classifyProtocolFailure(data), data, choice);
      if (!data || typeof data !== 'object' || Array.isArray(data)
        || !Array.isArray(data.choices) || data.choices.length === 0
        || !choice || typeof choice !== 'object' || Array.isArray(choice)) {
        return failStructured('invalid_response_envelope', data, choice);
      }
      if (choice.finish_reason === 'error') return failStructured('provider_finish_error', data, choice);
      // A truncated but parseable prefix may contain only part of the requested batch.
      if (choice.finish_reason === 'length') return failStructured('truncated_structured_output', data, choice);
      if (!choice.finish_reason) return failStructured('missing_finish_reason', data, choice);
      if (choice.finish_reason !== 'stop') return failStructured('unexpected_finish_reason', data, choice);
      if (!choice.message || typeof choice.message !== 'object' || Array.isArray(choice.message)) {
        return failStructured('invalid_response_message', data, choice);
      }
      const content = choice.message.content;
      if (content !== null && content !== undefined && typeof content !== 'string'
        && !(Array.isArray(content) && content.every((part) => part?.type === 'text' && typeof part.text === 'string'))) {
        return failStructured('invalid_response_content', data, choice);
      }
    }
    const responseMessage = choice.message || {};
    // Strict JSON is protocol data: prose cleanup would mutate string values
    // or turn an invalid envelope into an apparently valid decision.
    const text = extractTextContent(responseMessage.content);
    const raw = responseFormat?.type === 'json_schema' ? text.trim() : cleanModelText(text);
    const toolCalls = Array.isArray(responseMessage.tool_calls) ? responseMessage.tool_calls : [];
    const finishReason = choice.finish_reason || null;
    const actualProvider = data.provider || requestedProviders[0] || 'default';
    const usage = data.usage || {};

    if (finishReason === 'error') {
      return failStructured('provider_finish_error', data, choice);
    }

    // Memory extraction is a JSON protocol even though it intentionally stays
    // compatible with providers that do not support strict response schemas.
    // Never hand a known-truncated JSON prefix to the parser as a success;
    // route to the next independent background provider instead.
    if (purpose === 'memory' && finishReason === 'length') {
      return failStructured('truncated_memory_output', data, choice);
    }

    if (tools?.length && toolChoice === 'required' && toolCalls.length === 0) {
      return failStructured('required_tool_missing', data, choice);
    }

    if (!raw && toolCalls.length === 0) {
      const reason = finishReason === 'length' ? 'empty_length' : 'empty_content';
      return failStructured(reason, data, choice);
    }

    let validatedStructuredIntent = null;
    if (strictForeground && typeof validateStructuredContent === 'function') {
      let validation;
      try { validation = validateStructuredContent(raw); }
      catch { validation = { valid: false }; }
      capture?.('validation', { result: validation ?? null });
      if (!validation?.valid) return failStructured('invalid_structured_output', data, choice, { validationCode: validation?.errorCode || 'UNKNOWN' });
      validatedStructuredIntent = validation.intent || null;
    }

    const attemptDiagnostics = diagnostics(data);
    if (logPrefix) {
      const metadata = successTelemetry(data, {
        apiKey, correlationId, purpose, stage, model, provider: actualProvider,
        finishReason, toolCalls: toolCalls.length, latencyMs: Date.now() - startMs,
      });
      Object.assign(metadata, attemptDiagnostics);
      // Preserve legacy counters on one line without interpolating raw prefixes
      // or freeform metadata into the key=value fields.
      const prefix = safePrefix(metadata);
      console.log(`${prefix} attempt purpose=${field(metadata.purpose)} stage=${field(metadata.stage)} model=${field(metadata.model)} provider=${field(metadata.provider)} outcome=success finishReason=${field(metadata.finishReason)} toolCalls=${field(metadata.toolCalls)} promptTokens=${field(metadata.promptTokens)} completionTokens=${field(metadata.completionTokens)} latencyMs=${field(metadata.latencyMs)} metadata=${JSON.stringify(metadata)}`);
    }

    if (returnMessage) {
      return {
        ok: true,
        attemptDiagnostics,
        value: {
          role: 'assistant',
          content: raw,
          tool_calls: toolCalls,
          finishReason,
          model,
          provider: actualProvider,
          routeStage: stage,
          ...(validatedStructuredIntent ? { structuredIntent: validatedStructuredIntent } : {}),
          generationId: typeof data.id === 'string' ? data.id : null,
          usage: responseUsage(usage),
          attemptDiagnostics,
        },
      };
    }
    return { ok: true, value: raw, attemptDiagnostics };
  } catch (error) {
    const reason = classifyThrownFailure(error);
    return failStructured(reason, null, null, { exceptionClass: error?.name });
  }
}

function requiredDecisionMissing(attempt, { requestedToolChoice, tools, returnMessage }) {
  if (requestedToolChoice !== 'required' || !tools?.length || !attempt?.ok || !returnMessage) return false;
  const toolCalls = attempt.value?.tool_calls;
  return !Array.isArray(toolCalls) || toolCalls.length === 0;
}

async function runOpenRouterChain(messages, profiles, {
  apiKey,
  purpose,
  temperature,
  maxTokens,
  responseFormat,
  tools,
  toolChoice,
  returnMessage,
  logPrefix,
  validateStructuredContent,
  correlationId,
}) {
  let previousFailure = 'initial_request';
  let lastAttemptDiagnostics = null;

  for (const profile of profiles) {
    const unsupportedStrictRoute = purpose === 'initial'
      && responseFormat?.type === 'json_schema' && responseFormat.json_schema?.strict === true
      && profile.supportsStrictStructuredOutputs !== true;
    if (unsupportedStrictRoute) {
      if (logPrefix) console.warn(`${logPrefix} route purpose=${purpose} stage=${profile.stage} model=${profile.model} provider=${profile.providers.join(',')} outcome=skipped reason=unsupported_structured_outputs`);
      if (previousFailure === 'initial_request') previousFailure = 'unsupported_structured_outputs';
      continue;
    }
    if (logPrefix && previousFailure !== 'initial_request') {
      console.log(`${logPrefix} route purpose=${purpose} stage=${profile.stage} model=${profile.model} provider=${profile.providers.join(',')} trigger=${previousFailure}`);
    }

    const hasRequiredNamedTool = toolChoice === 'required'
      && profile.requiredToolName
      && tools?.some((item) => item?.function?.name === profile.requiredToolName);
    const effectiveToolChoice = hasRequiredNamedTool
      ? { type: 'function', function: { name: profile.requiredToolName } }
      : toolChoice === 'required' && profile.requiredToolChoiceSupported === false
        ? 'auto'
        : toolChoice;
    let attempt;
    const maxAttempts = 1 + (profile.emptyContentRetries || 0);

    for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
      attempt = await callOpenRouterAttempt(messages, profile.model, apiKey, {
        temperature: profile.supportsTemperature === false ? undefined : temperature,
        max_tokens: tools?.length ? Math.max(maxTokens, profile.minCompletionTokens || 0) : maxTokens,
        timeoutMs: profile.timeoutMs,
        providers: profile.providers,
        allowProviderFallbacks: false,
        responseFormat,
        tools,
        toolChoice: effectiveToolChoice,
        parallelToolCalls: profile.parallelToolCalls,
        reasoning: profile.reasoning,
        returnMessage,
        logPrefix,
        purpose,
        stage: profile.stage,
        validateStructuredContent,
        correlationId,
        attemptNumber,
      });
      lastAttemptDiagnostics = attempt.attemptDiagnostics;

      // Providers that only accept auto still have to return execute_turn. Prose
      // cannot terminate the chain when the caller requested a structured turn.
      if (requiredDecisionMissing(attempt, {
        requestedToolChoice: toolChoice,
        tools,
        returnMessage,
      })) {
        if (logPrefix) console.warn(`${logPrefix} attempt purpose=${purpose} stage=${profile.stage} outcome=failed reason=required_tool_missing_after_auto_fallback`);
        attempt = { ok: false, reason: 'required_tool_missing', attemptDiagnostics: lastAttemptDiagnostics };
      }

      // Only malformed/empty structured responses get a same-provider retry.
      // Upstream finish errors are already authoritative provider failures and
      // move immediately to an independent provider to keep foreground latency bounded.
      const retryableStructuredMiss = attempt.reason === 'empty_content'
        || attempt.reason === 'required_tool_missing';
      if (attempt.ok || !retryableStructuredMiss || attemptNumber === maxAttempts) break;
      if (logPrefix) console.warn(`${logPrefix} retry purpose=${purpose} stage=${profile.stage} reason=${attempt.reason} attempt=${attemptNumber + 1}`);
    }

    if (attempt.terminal) {
      if (logPrefix) console.warn(`${logPrefix} route purpose=${purpose} stopped reason=provider_refusal`);
      // Do not evade an explicit safety refusal through an independent model.
      return returnMessage
        ? { role: 'assistant', content: '', tool_calls: [], unavailable: true, refused: true, attemptDiagnostics: lastAttemptDiagnostics }
        : JSON.stringify({ type: 'chat', reply: 'No puedo completar esa solicitud. No ejecuté ninguna acción.' });
    }
    if (attempt.ok) return attempt.value;
    previousFailure = attempt.reason;
  }

  if (logPrefix) console.warn(`${logPrefix} route purpose=${purpose} exhausted reason=${previousFailure}`);
  return returnMessage ? { chainExhausted: true, unavailableReason: previousFailure, attemptDiagnostics: lastAttemptDiagnostics } : null;
}

export async function callChatCompletion(messages, {
  temperature = 0.0,
  max_tokens = 800,
  correlationId = null,
  tools = null,
  toolChoice = 'auto',
  returnMessage = false,
  purpose = 'initial',
  startStage = null,
  responseFormat: requestedResponseFormat = null,
  validateStructuredContent = null,
  language = 'es',
} = {}) {
  const openrouterKey = getOpenRouterApiKey();
  const nativeToolMode = Array.isArray(tools);
  const safeCorrelationId = typeof correlationId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(correlationId) ? correlationId : null;
  const logPrefix = safeCorrelationId ? `[ai-client req=${safeCorrelationId}]` : '[ai-client]';

  if (!openrouterKey) {
    console.error(`${logPrefix} OPENROUTER_API_KEY is not configured.`);
    return buildUnavailableResponse(returnMessage, 'missing_credentials', language);
  }

  const strictStructuredOutput = requestedResponseFormat?.type === 'json_schema'
    && requestedResponseFormat.json_schema?.strict === true;
  const foregroundProfiles = createForegroundProfiles({ strictStructuredOutput });
  const requestedStartIndex = startStage
    ? foregroundProfiles.findIndex((profile) => profile.stage === startStage)
    : 0;
  const profiles = requestedStartIndex > 0
    ? foregroundProfiles.slice(requestedStartIndex)
    : foregroundProfiles;

  // Optional proactive advice must not delay a verified operational reply.
  const boundedProfiles = purpose === 'next_best_action'
    ? profiles.slice(0, 1).map(profile => ({ ...profile, timeoutMs: 2000, emptyContentRetries: 0,
      reasoning: profile.reasoning ? { ...profile.reasoning, effort: 'low' } : null }))
    : ['policy_compilation', 'memory_admission'].includes(purpose)
      ? profiles.slice(0, 2).map(profile => ({ ...profile, timeoutMs: Math.min(profile.timeoutMs, 3000), emptyContentRetries: 0,
        reasoning: profile.reasoning ? { ...profile.reasoning, effort: 'low' } : null }))
      : profiles;
  const result = await runOpenRouterChain(messages, boundedProfiles, {
    apiKey: openrouterKey,
    purpose,
    temperature,
    maxTokens: max_tokens,
    responseFormat: requestedResponseFormat || (nativeToolMode ? null : { type: 'json_object' }),
    tools: requestedResponseFormat ? null : tools,
    toolChoice: requestedResponseFormat ? 'none' : toolChoice,
    returnMessage,
    logPrefix,
    validateStructuredContent,
    correlationId,
  });

  if (result?.chainExhausted) {
    return { ...buildUnavailableResponse(returnMessage, result.unavailableReason, language), attemptDiagnostics: result.attemptDiagnostics };
  }
  return result || buildUnavailableResponse(returnMessage, 'compatible_routes_exhausted', language);
}

export async function callResponseSynthesis({
  facts,
  excludedClauses = [],
  language = 'es',
  correlationId = null,
} = {}) {
  const openrouterKey = getOpenRouterApiKey();
  if (!openrouterKey || !Array.isArray(facts) || facts.length === 0) return null;
  if (!Array.isArray(excludedClauses) || excludedClauses.length === 0) return null;

  const isEnglish = language === 'en';
  const areaByTool = {
    manage_reminder: 'reminders',
    manage_task: 'tasks and projects',
    manage_entity: 'projects and lists',
    manage_google_calendar: 'calendar',
    get_unified_agenda: 'personal agenda',
    manage_memory: 'personal memory',
    manage_subscription: 'Hermes subscription',
  };
  const availableAreas = [...new Set(facts.map((fact) => areaByTool[fact.tool]).filter(Boolean))];
  const messages = [
    {
      role: 'system',
      content: isEnglish
        ? `Write one tiny conversational fragment before verified assistant cards. Return JSON only: {"before":"","after":""}. Address only the excluded part. Never restate, reinterpret or claim the result of an action. Never mention internal tools or schemas. "after" must be empty. Each field is at most 160 characters.`
        : `Escribe en ${responseVoice(language)} un fragmento conversacional mínimo antes de cards verificadas del asistente. Devuelve solo JSON: {"before":"","after":""}. Atiende únicamente la parte excluida. Nunca repitas, reinterpretes ni afirmes el resultado de una acción. Nunca menciones herramientas ni esquemas internos. "after" debe quedar vacío. Cada campo admite máximo 160 caracteres.`,
    },
    {
      role: 'user',
      content: JSON.stringify({
        availableAreas,
        excludedClauses: excludedClauses.map((item) => ({
          text: item.quote || item.text || item.sourceQuote || '',
          reason: item.reason || 'out_of_scope',
        })),
      }),
    },
  ];
  const safeCorrelationId = typeof correlationId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(correlationId) ? correlationId : null;
  const logPrefix = safeCorrelationId ? `[ai-response req=${safeCorrelationId}]` : '[ai-response]';
  const profiles = createForegroundProfiles({ strictStructuredOutput: false }).map((profile) => ({
    ...profile,
    reasoning: profile.reasoning ? { ...profile.reasoning, effort: 'low' } : null,
    emptyContentRetries: Math.min(profile.emptyContentRetries || 0, 1),
  }));
  const result = await runOpenRouterChain(messages, profiles, {
    apiKey: openrouterKey,
    purpose: 'response_synthesis',
    temperature: 0.2,
    maxTokens: 180,
    responseFormat: { type: 'json_object' },
    tools: null,
    toolChoice: 'none',
    returnMessage: false,
    logPrefix,
    correlationId,
  });

  try {
    const parsed = JSON.parse(result || '{}');
    const compact = (value) => typeof value === 'string'
      ? value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
      : '';
    return { before: compact(parsed.before || parsed.after), after: '' };
  } catch {
    return null;
  }
}

export async function callOpenRouterChat(messages, model, apiKey, options = {}) {
  const attempt = await callOpenRouterAttempt(messages, model, apiKey, options);
  return attempt.ok ? attempt.value : null;
}

export async function callMemoryExtraction(messages, {
  temperature = 0.1,
  max_tokens = 600,
  timeoutMs = 9000,
} = {}) {
  const openrouterKey = getOpenRouterApiKey();
  if (!openrouterKey) {
    console.warn('[ai-memory] OPENROUTER_API_KEY is not configured.');
    return null;
  }

  const profiles = createBackgroundProfiles().map((profile) => ({
    ...profile,
    timeoutMs: profile.stage === 'memory_primary' ? timeoutMs : profile.timeoutMs,
  }));

  return runOpenRouterChain(messages, profiles, {
    apiKey: openrouterKey,
    purpose: 'memory',
    temperature,
    maxTokens: max_tokens,
    responseFormat: null,
    tools: null,
    toolChoice: 'auto',
    returnMessage: false,
    logPrefix: '[ai-memory]',
  });
}

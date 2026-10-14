import { safeCounter, knownProvider } from './provider-attempt-diagnostics.js';

interface ProviderError extends Record<string, unknown> {
  metadata?: { raw?: unknown; error_type?: unknown };
}
interface ProviderChoice { error?: ProviderError; message?: { refusal?: unknown; content?: unknown }; finish_reason?: unknown }
interface ProviderUsage { prompt_tokens?: unknown; completion_tokens?: unknown; completion_tokens_details?: { reasoning_tokens?: unknown }; prompt_tokens_details?: { cached_tokens?: unknown } }
interface ProviderEnvelope { error?: ProviderError; choices?: ProviderChoice[]; usage?: ProviderUsage; id?: unknown; model?: unknown; provider?: unknown }
export interface GatewayTelemetryInput { apiKey: string | null; correlationId: unknown; purpose: unknown; stage: unknown; model: unknown; provider: unknown; finishReason: unknown; toolCalls: unknown; latencyMs: unknown }
export type GatewayProtocolFailure = 'structured_generation_rejection' | 'schema_rejection' | 'provider_incompatible' | 'provider_error';

export function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

export function cleanModelText(value: unknown): string {
  return String(value || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim();
}

export function parseErrorEnvelope(rawBody: string | null | undefined): unknown {
  if (!rawBody) return null;
  try { return JSON.parse(rawBody); } catch { return null; }
}

export function providerFailureFields(data: unknown) {
  const envelope = data as ProviderEnvelope | null | undefined;
  const error = (envelope?.error || envelope?.choices?.[0]?.error || data) as ProviderError | null | undefined;
  const nested = providerErrorObject(error);
  return {
    code: String(nested?.code ?? error?.code ?? '').toLowerCase(),
    type: String(nested?.type ?? error?.type ?? error?.metadata?.error_type ?? '').toLowerCase(),
    param: String(nested?.param ?? error?.param ?? '').toLowerCase(),
    message: String(nested?.message ?? error?.message ?? '').toLowerCase(),
  };
}

export function classifyProtocolFailure(data: unknown): GatewayProtocolFailure {
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

export function classifyHttpFailure(status: number, data: unknown = null): string {
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

export function classifyThrownFailure(input: unknown): string {
  const error = input as { name?: unknown; message?: string } | null | undefined;
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || /timed?\s*out/i.test(error?.message || '')) {
    return 'timeout';
  }
  return 'network_error';
}

export function providerErrorObject(input: unknown): ProviderError | null | undefined {
  const error = input as ProviderError | null | undefined;
  let raw = error?.metadata?.raw;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = null; }
  }
  return ((raw as { error?: unknown } | null | undefined)?.error || raw || error) as ProviderError | null | undefined;
}

export function isProviderRefusal(input: unknown, choiceInput: unknown = {}): boolean {
  const data = input as ProviderEnvelope | null | undefined;
  const choice = choiceInput as ProviderChoice | null | undefined;
  const message = choice?.message;
  if (message?.refusal || choice?.finish_reason === 'content_filter') return true;
  if (Array.isArray(message?.content) && message.content.some((part) => part?.type === 'refusal')) return true;
  const error = data?.error || choice?.error;
  const nested = providerErrorObject(error);
  const refusalCodes = new Set(['content_filter', 'content_policy_violation', 'moderation_blocked', 'refusal', 'safety']);
  return [error?.code, error?.type, error?.metadata?.error_type, nested?.code, nested?.type]
    .some((code) => refusalCodes.has(code as string));
}

export function responseUsage(input: unknown) {
  const usage = input as ProviderUsage | null | undefined;
  return {
    promptTokens: usage?.prompt_tokens,
    completionTokens: usage?.completion_tokens,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens,
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens,
  };
}

export function successTelemetry(input: unknown, { apiKey, correlationId, purpose, stage, model, provider, finishReason, toolCalls, latencyMs }: GatewayTelemetryInput) {
  // Allowlist bounded metadata only. Reject freeform strings and credentials;
  // never serialize the response envelope, messages, output or error details.
  const data = input as ProviderEnvelope | null | undefined;
  const identifier = (value: unknown) => typeof value === 'string'
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


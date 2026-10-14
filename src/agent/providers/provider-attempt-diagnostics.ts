export interface RequestMeasurements {
  requestBytes: number | null; messagesBytes: number | null; schemaBytes: number | null;
  responseFormatBytes: number | null; messageCount: number | null;
}
interface DiagnosticError extends Record<string, unknown> {
  metadata?: { raw?: unknown; provider_code?: unknown; provider_name?: unknown; error_type?: unknown };
}
interface DiagnosticEnvelope { error?: DiagnosticError; choices?: { error?: DiagnosticError }[]; provider?: unknown }
export interface RateLimitInput extends Record<string, unknown> {
  status?: unknown; data?: unknown; headers?: { get?: (name: string) => unknown } | null; nowMs?: unknown;
}
export interface RateLimitDiagnostics {
  failureClass: 'rate_limit' | null; rateLimitSource: 'upstream' | 'openrouter_platform' | 'uncertain' | null;
  observedProvider: string | null; errorCode: string | number | null; errorType: string | number | null;
  errorParam: string | null; retryAfterSeconds: number | null;
  rateLimitLimit: number | null; rateLimitRemaining: number | null; rateLimitReset: number | null;
}

// Ordinary telemetry contains measurements and closed vocabularies only.
// Components overlap the total; UTF-8 bytes are not token estimates.
export function measureSerializedRequest(serializedBody: unknown): RequestMeasurements {
  const unknown = { requestBytes: null, messagesBytes: null, schemaBytes: null,
    responseFormatBytes: null, messageCount: null };
  if (typeof serializedBody !== 'string') return unknown;
  const payload = JSON.parse(serializedBody) as { messages?: unknown; response_format?: { json_schema?: { schema?: unknown } } };
  const bytes = (value: unknown): number | null => value === undefined ? null : Buffer.byteLength(JSON.stringify(value), 'utf8');
  return {
    requestBytes: Buffer.byteLength(serializedBody, 'utf8'),
    messagesBytes: bytes(payload.messages),
    schemaBytes: bytes(payload.response_format?.json_schema?.schema),
    responseFormatBytes: bytes(payload.response_format),
    messageCount: Array.isArray(payload.messages) ? payload.messages.length : null,
  };
}

export function phaseDuration(start: unknown, end: unknown): number | null {
  return Number.isFinite(start) && Number.isFinite(end) && (end as number) >= (start as number) ? (end as number) - (start as number) : null;
}

export function safeCounter(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

const PROVIDERS = new Set(['groq', 'cerebras', 'cerebras/fp16', 'baseten', 'baseten/fp8',
  'alibaba', 'openrouter', 'openai', 'anthropic', 'google', 'google-vertex', 'amazon-bedrock',
  'deepinfra', 'fireworks', 'together', 'sambanova', 'novita', 'siliconflow', 'nebius']);

export function knownProvider(value: unknown): string | null {
  return typeof value === 'string' && PROVIDERS.has(value.toLowerCase()) ? value : null;
}

const FAILURE_CODES = new Set(['invalid_request_error', 'invalid_request', 'invalid_parameter',
  'invalid_json_schema', 'json_validate_failed', 'json_validation_failed', 'json_validation',
  'rate_limit_exceeded', 'rate_limit_error', 'content_filter', 'content_policy_violation',
  'moderation_blocked', 'refusal', 'safety', 'INVALID_PARAMETERS', 'UNKNOWN',
  'UNTRUSTED_ATTACHMENT_ACTION', 'INVALID_RESPONSE_CAPABILITY', 'INVALID_LEARNING_CANDIDATES',
  'TURN_ACTION_LIMIT', 'UNSUPPORTED_DOMAIN', 'UNSUPPORTED_ACTION', 'INVALID_ENTITY_CATEGORY',
  'INVALID_SUBSCRIPTION_SCOPE', 'INVALID_TASK_STATUS', 'INVALID_KNOWLEDGE_REFS',
  'INVALID_RETURN_FIELDS', 'INVALID_RECAP', 'INVALID_EVIDENCE_REFS', 'MISSING_CONTENT',
  'MISSING_SCHEDULE', 'INVALID_CONTEXT_REFERENCE', 'MISSING_TARGET', 'MISSING_TITLE',
  'INVALID_RECURRENCE', 'INVALID_TURN_CONTEXT', 'INVALID_APPROVAL_DECISION',
  'INVALID_APPROVAL_RELATION', 'INVALID_APPROVAL_CHOICE', 'MISSING_SELECTED_CALL_IDS',
  'INVALID_CONTINUATION_DECISION', 'INVALID_CONTINUATION_RELATION', 'INVALID_ACTION_INPUT',
  'CONFLICTING_ACTION_INPUT']);

export function safeFailureCode(value: unknown): string | number | null {
  if (Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599) return value as number;
  if (typeof value !== 'string') return null;
  if (/^[1-5]\d{2}$/.test(value)) return Number(value);
  return FAILURE_CODES.has(value) ? value : null;
}

export function safeExceptionClass(value: unknown): string | null {
  return ['Error', 'TypeError', 'SyntaxError', 'RangeError', 'TimeoutError', 'AbortError', 'DOMException'].includes(value as string) ? value as string : null;
}

function boundedHeaderInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): number | null {
  if (typeof value !== 'string' || !/^\d{1,16}$/.test(value)) return null;
  const number = Number(value);
  return safeCounter(number) !== null && number <= max ? number : null;
}

// Accept canonical IMF-fixdate only; Date.parse alone normalizes invalid dates.
function httpDate(value: unknown): number | null {
  if (typeof value !== 'string' || !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms >= 0 && ms <= 4102444800000
    && new Date(ms).toUTCString() === value ? ms : null;
}

function retryAfter(value: unknown, nowMs: unknown): number | null {
  const numeric = boundedHeaderInteger(value, 604800);
  if (numeric !== null) return numeric;
  const date = httpDate(value);
  if (date === null || !Number.isFinite(nowMs)) return null;
  const seconds = Math.max(0, Math.ceil((date - (nowMs as number)) / 1000));
  return seconds <= 604800 ? seconds : null;
}

function nestedError(error: DiagnosticError | undefined): DiagnosticError | undefined {
  let raw = error?.metadata?.raw;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = null; }
  }
  return ((raw as { error?: unknown } | null | undefined)?.error || raw || error) as DiagnosticError | undefined;
}

export function rateLimitDiagnostics({ status = null, data = null, headers = null, nowMs = null }: RateLimitInput = {}): RateLimitDiagnostics {
  const envelope = data as DiagnosticEnvelope | null | undefined;
  const error = envelope?.error || envelope?.choices?.[0]?.error;
  const nested = nestedError(error);
  const codes = [nested !== error ? nested?.code : null, error?.metadata?.provider_code, error?.code].map(safeFailureCode);
  const observedProvider = knownProvider(error?.metadata?.provider_name ?? envelope?.provider);
  const rateLimited = status === 429 || codes.includes(429);
  // Neither requested routing nor generic gateway headers prove the source.
  const providerCode = codes.find(code => code !== null) ?? null;
  // Compare every allowlisted code after canonicalizing numeric strings.
  // Contradictory outer/upstream evidence cannot establish provenance.
  const conflictingCodes = new Set(codes.filter(code => code !== null)).size > 1;
  const platform = observedProvider?.toLowerCase() === 'openrouter';
  const rateLimitSource = !rateLimited ? null : observedProvider && providerCode === 429
    && !conflictingCodes
    && !(platform && nested !== error)
    ? platform ? 'openrouter_platform' : 'upstream'
    : 'uncertain';
  const header = (name: string): unknown => headers?.get?.(name) ?? null;
  const reset = header('X-RateLimit-Reset');
  return {
    failureClass: rateLimited ? 'rate_limit' : null,
    rateLimitSource,
    observedProvider,
    errorCode: providerCode,
    errorType: safeFailureCode(nested?.type ?? error?.type ?? error?.metadata?.error_type),
    errorParam: ['response_format', 'tools', 'tool_choice', 'max_tokens', 'temperature', 'reasoning'].includes((nested?.param ?? error?.param) as string)
      ? (nested?.param ?? error?.param) as string : null,
    retryAfterSeconds: retryAfter(header('Retry-After'), nowMs),
    rateLimitLimit: boundedHeaderInteger(header('X-RateLimit-Limit')),
    rateLimitRemaining: boundedHeaderInteger(header('X-RateLimit-Remaining')),
    rateLimitReset: boundedHeaderInteger(reset, 4102444800) ?? (httpDate(reset) === null ? null : httpDate(reset)! / 1000),
  };
}

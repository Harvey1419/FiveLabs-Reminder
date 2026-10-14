import { buildRequestPayload, type GatewayRequestOptions } from './gateway-request-payload.js';
import { measureSerializedRequest, phaseDuration, rateLimitDiagnostics, safeFailureCode, safeExceptionClass } from './provider-attempt-diagnostics.js';
import { extractTextContent, cleanModelText, parseErrorEnvelope, classifyProtocolFailure, classifyHttpFailure, classifyThrownFailure, isProviderRefusal, responseUsage, successTelemetry } from './gateway-response-contracts.js';

export interface AttemptResponseMessage extends Record<string, unknown> { content?: unknown; tool_calls?: unknown; refusal?: unknown }
interface AttemptChoice extends Record<string, unknown> { message?: AttemptResponseMessage | null; finish_reason?: string | null }
interface AttemptEnvelope extends Record<string, unknown> { choices?: AttemptChoice[]; provider?: unknown; usage?: unknown; id?: unknown }
export interface StructuredValidation { valid?: unknown; intent?: unknown; errorCode?: unknown }
export interface GatewayAttemptOptions extends Omit<GatewayRequestOptions, 'responseFormat'> {
  responseFormat?: GatewayRequestOptions['responseFormat'];
  timeoutMs?: number; returnMessage?: boolean; logPrefix?: string | null; purpose?: string; stage?: string;
  correlationId?: unknown; validateStructuredContent?: ((raw: string) => StructuredValidation | null | undefined) | null | undefined;
  capture?: ((type: string, evidence: Record<string, unknown>) => void) | null; attemptNumber?: number;
}
export interface GatewayAssistantMessage {
  role: 'assistant'; content: string; tool_calls: unknown[]; finishReason: string | null;
  model: string; provider: unknown; routeStage: string; structuredIntent?: unknown;
  generationId: string | null; usage: ReturnType<typeof responseUsage>; attemptDiagnostics: Record<string, unknown>;
}
export type GatewayAttemptResult =
  | { ok: true; value: string | GatewayAssistantMessage; attemptDiagnostics: Record<string, unknown>; reason?: never; terminal?: never }
  | { ok: false; reason: string; terminal?: boolean; finishReason?: string | null; status?: number; attemptDiagnostics: Record<string, unknown> };
export interface GatewayAttemptDependencies {
  fetch: typeof globalThis.fetch; now(): number; monotonicNow(): number;
  logger: Pick<Console, 'log' | 'warn'>;
}

/** Transport and clocks are host capabilities; response acceptance retains the existing protocol guards. */
export function createGatewayAttempt({ fetch, now, monotonicNow, logger }: GatewayAttemptDependencies) {
  async function performOpenRouterAttempt(messages: readonly unknown[], model: string, apiKey: string, {
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
  }: GatewayAttemptOptions = {}): Promise<GatewayAttemptResult> {
    const startMs = now();
    const preparationStart = monotonicNow();
    let fetchStart: number | null = null;
    let parseStart: number | null = null;
    let preparationMs: number | null = null;
    let fetchMs: number | null = null;
    let measurements = measureSerializedRequest(null);
    let responseStatus: number | null = null;
    let responseHeaders: Headers | null = null;
    const requestedProviders = providers?.length ? providers : [];
    const strictForeground = responseFormat?.type === 'json_schema';
    const diagnostics = (data: unknown) => {
      const end = monotonicNow();
      return { ...measurements, status: responseStatus,
        preparationMs: preparationMs ?? phaseDuration(preparationStart, end),
        fetchMs: fetchMs ?? phaseDuration(fetchStart, end),
        parseValidationMs: phaseDuration(parseStart, end),
        ...rateLimitDiagnostics({ status: responseStatus, data, headers: responseHeaders, nowMs: now() }) };
    };
    const safePrefix = (metadata: { requestId?: unknown }) => {
      const category = logPrefix === '[ai-memory]' ? 'ai-memory'
        : logPrefix === '[ai-response]' || logPrefix?.startsWith('[ai-response req=') ? 'ai-response' : 'ai-client';
      return `[${category}${metadata.requestId ? ` req=${metadata.requestId}` : ''}]`;
    };
    const field = (value: unknown): unknown => value === null ? 'unknown' : typeof value === 'number' ? value
      : /^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,159}$/.test(value as string) ? value : 'unknown';
    const failStructured = (reason: string, data: unknown, choice: AttemptChoice | null, { terminal = false, validationCode = null, exceptionClass = null }: { terminal?: boolean; validationCode?: unknown; exceptionClass?: unknown } = {}): GatewayAttemptResult => {
      const attemptDiagnostics = diagnostics(data);
      const metadata = { ...successTelemetry(data, { apiKey, correlationId, purpose, stage, model,
        provider: requestedProviders[0], finishReason: ['stop', 'length', 'error', 'tool_calls', 'content_filter'].includes(choice?.finish_reason as string) ? choice!.finish_reason : null,
        toolCalls: null, latencyMs: now() - startMs }),
      ...attemptDiagnostics, outcome: 'failed', reason,
      failureClass: attemptDiagnostics.failureClass || reason, status: responseStatus,
      validationCode: safeFailureCode(validationCode), exceptionClass: safeExceptionClass(exceptionClass) };
      if (logPrefix) {
        logger.warn(`${safePrefix(metadata)} attempt purpose=${field(metadata.purpose)} stage=${field(metadata.stage)} model=${field(metadata.model)} provider=${field(metadata.provider)} outcome=failed reason=${reason}${metadata.validationCode ? ` validationCode=${metadata.validationCode}` : ''}${responseStatus !== null ? ` status=${responseStatus}` : ''} latencyMs=${metadata.latencyMs} metadata=${JSON.stringify(metadata)}`);
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
      preparationMs = phaseDuration(preparationStart, monotonicNow());
      fetchStart = monotonicNow();
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
      fetchMs = phaseDuration(fetchStart, monotonicNow());
      parseStart = monotonicNow();
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

      let data: AttemptEnvelope | null;
      try { data = await res.json() as AttemptEnvelope | null; }
      catch (error) {
        if (strictForeground) return failStructured('invalid_response_json', null, null, { exceptionClass: (error as { name?: unknown } | null | undefined)?.name });
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
      const actualProvider = data!.provider || requestedProviders[0] || 'default';
      const usage = data!.usage || {};

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

      let validatedStructuredIntent: unknown = null;
      if (strictForeground && typeof validateStructuredContent === 'function') {
        let validation: StructuredValidation | null | undefined;
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
          finishReason, toolCalls: toolCalls.length, latencyMs: now() - startMs,
        });
        Object.assign(metadata, attemptDiagnostics);
        // Preserve legacy counters on one line without interpolating raw prefixes
        // or freeform metadata into the key=value fields.
        const prefix = safePrefix(metadata);
        logger.log(`${prefix} attempt purpose=${field(metadata.purpose)} stage=${field(metadata.stage)} model=${field(metadata.model)} provider=${field(metadata.provider)} outcome=success finishReason=${field(metadata.finishReason)} toolCalls=${field(metadata.toolCalls)} promptTokens=${field(metadata.promptTokens)} completionTokens=${field(metadata.completionTokens)} latencyMs=${field(metadata.latencyMs)} metadata=${JSON.stringify(metadata)}`);
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
            generationId: typeof data!.id === 'string' ? data!.id : null,
            usage: responseUsage(usage),
            attemptDiagnostics,
          },
        };
      }
      return { ok: true, value: raw, attemptDiagnostics };
    } catch (error) {
      const reason = classifyThrownFailure(error);
      return failStructured(reason, null, null, { exceptionClass: (error as { name?: unknown } | null | undefined)?.name });
    }
  }

  return { performOpenRouterAttempt };
}

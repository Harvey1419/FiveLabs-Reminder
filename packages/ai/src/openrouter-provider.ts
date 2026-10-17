import { aiTranscriptSchema, mediaAttachmentSchema, type AIResponse, type JsonObject } from '@templelabs/contracts';
import { AIProviderError, ToolSelectionError, ToolArgumentsError } from './provider-error.js';
import type { AIProvider, CompletionRequest, StructuredAIProvider, StructuredCompletionRequest, StructuredCompletionResult, TextAIProvider, TextCompletionRequest, TextCompletionResult, MediaAIProvider, MediaCompletionRequest } from './index.js';
import { decodeOpenRouterResponse, openRouterPayload, reportedOpenRouterUsage, decodeStructuredOpenRouterResponse, structuredOpenRouterPayload, decodeTextOpenRouterResponse, textOpenRouterPayload, mediaOpenRouterPayload, type OpenRouterRoute } from './openrouter-protocol.js';

export type GatewayFailureCode = 'UNSUPPORTED_CAPABILITY' | 'INVALID_REQUEST' | 'MISSING_CREDENTIALS' | 'GATEWAY_ABORTED' | 'GATEWAY_DEADLINE'
  | 'GATEWAY_BUDGET' | 'UNVERIFIED_USAGE' | 'AUTHENTICATION_FAILED' | 'ROUTES_EXHAUSTED';
export class GatewayError extends AIProviderError {
  constructor(code: GatewayFailureCode, usage?: AIResponse['usage'], accountingComplete = true) { super(code, usage, accountingComplete); this.name = 'GatewayError'; }
}
export interface OpenRouterAttempt {
  readonly route: string; readonly model: string; readonly requestedProviders: readonly string[];
  readonly provider: string | null; readonly generationId: string | null;
  readonly inputEstimate: number; readonly usage: AIResponse['usage'] | null;
  readonly status: number | null; readonly outcome: 'response' | 'transport_unknown';
  readonly providerErrorCode?: number;
  /** Bounded names from this attempt's wire payload, never execution authority. */
  readonly advertisedToolNames?: readonly string[];
  readonly advertisedToolsTruncated?: boolean;
  /** Present only for an explicit whole-decision tool schema rejection. */
  readonly rejectedToolName?: string;
  /** Safe internal evidence only; never a retry decision or proof of zero spend. */
  readonly failureClass?: 'unadvertised_tool_rejection' | 'tool_arguments_rejection' | 'provider_error' | 'missing_usage'
    | 'invalid_response' | 'transport_uncertainty' | 'authentication' | 'rate_limit';
}
export interface OpenRouterProviderOptions {
  readonly apiKey: string; readonly routes: readonly OpenRouterRoute[];
  readonly fetch?: typeof globalThis.fetch; readonly now?: () => number;
  readonly estimateInputTokens?: (payload: unknown) => number;
  readonly onAttempt?: (attempt: OpenRouterAttempt) => void;
}
function advertisedToolSnapshot(payload: Record<string, unknown>): Pick<OpenRouterAttempt, 'advertisedToolNames' | 'advertisedToolsTruncated'> {
  const advertisedToolNames: string[] = [];
  let advertisedToolsTruncated = false;
  for (const tool of Array.isArray(payload.tools) ? payload.tools : []) {
    const fn = tool !== null && typeof tool === 'object' ? (tool as Record<string, unknown>).function : null;
    const name = fn !== null && typeof fn === 'object' ? (fn as Record<string, unknown>).name : null;
    if (typeof name === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(name) && advertisedToolNames.length < 64) advertisedToolNames.push(name);
    else advertisedToolsTruncated = true;
  }
  return { advertisedToolNames, advertisedToolsTruncated };
}
/** Also races adapters that ignore AbortSignal; no subsequent route starts after host cancellation. */
async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new GatewayError('GATEWAY_ABORTED'));
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) { aborted(); signal.removeEventListener('abort', aborted); return; }
    Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

/** Shared bounded native/structured adapter. Domain schemas, UI and environment access belong to the host. */
export class OpenRouterProvider implements StructuredAIProvider, TextAIProvider, MediaAIProvider {
  readonly capabilities: AIProvider['capabilities'];
  readonly mediaCapabilities: MediaAIProvider['mediaCapabilities'];
  private readonly failedRoutes = new Set<string>();
  private readonly routes: readonly OpenRouterRoute[];
  readonly #apiKey: string;
  private readonly transport: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly estimateInputTokens: (payload: unknown) => number;
  private readonly onAttempt: OpenRouterProviderOptions['onAttempt'];
  constructor(options: OpenRouterProviderOptions) {
    if (!options.apiKey.trim() || /[\r\n]/.test(options.apiKey)) throw new GatewayError('MISSING_CREDENTIALS');
    if (!options.routes.length || options.routes.length > 3) throw new GatewayError('INVALID_REQUEST');
    const seenProviders = new Set<string>();
    for (const route of options.routes) {
      if (!/^[\w.-]{1,80}$/.test(route.id) || !/^[\w./:-]{1,160}$/.test(route.model)
        || !Number.isSafeInteger(route.timeoutMs) || route.timeoutMs < 1 || !route.providers.length
        || (route.minOutputTokens !== undefined && (!Number.isSafeInteger(route.minOutputTokens) || route.minOutputTokens < 1))
        || (route.maxOutputTokens !== undefined && (!Number.isSafeInteger(route.maxOutputTokens) || route.maxOutputTokens < 1
          || (route.minOutputTokens !== undefined && route.minOutputTokens > route.maxOutputTokens)))
        || (route.structuredOutput !== undefined && typeof route.structuredOutput !== 'boolean')
        || (route.media !== undefined && (!Array.isArray(route.media) || route.media.some(kind => !['image', 'pdf'].includes(kind)) || new Set(route.media).size !== route.media.length))
        || (route.temperature !== undefined && (!Number.isFinite(route.temperature) || route.temperature < 0 || route.temperature > 2))
        || (route.reasoning && (!/^[\w-]{1,40}$/.test(route.reasoning.effort) || typeof route.reasoning.exclude !== 'boolean'))) throw new GatewayError('INVALID_REQUEST');
      for (const provider of route.providers) {
        if (!/^[\w./:-]{1,160}$/.test(provider) || seenProviders.has(provider)) throw new GatewayError('INVALID_REQUEST');
        seenProviders.add(provider);
      }
    }
    if (new Set(options.routes.map(route => route.id)).size !== options.routes.length) throw new GatewayError('INVALID_REQUEST');
    this.capabilities = Object.freeze({ toolCalling: true, structuredOutput: options.routes.some(route => route.structuredOutput === true) });
    this.mediaCapabilities = Object.freeze({ image: options.routes.some(route => route.media?.includes('image')),
      pdf: options.routes.some(route => route.media?.includes('pdf')) });
    this.routes = structuredClone(options.routes); this.#apiKey = options.apiKey.trim();
    this.estimateInputTokens = options.estimateInputTokens ?? (value => new TextEncoder().encode(JSON.stringify(value)).length + 256);
    this.onAttempt = options.onAttempt;
    this.transport = options.fetch ?? globalThis.fetch; this.now = options.now ?? Date.now;
  }
  forTurn(): OpenRouterProvider {
    return new OpenRouterProvider({ apiKey: this.#apiKey, routes: this.routes, fetch: this.transport, now: this.now,
      estimateInputTokens: this.estimateInputTokens, ...(this.onAttempt ? { onAttempt: this.onAttempt } : {}) });
  }
  /** Same route payload used by the wire guard, including schemas and framing. */
  estimateNativeInput(request: Pick<CompletionRequest, 'messages' | 'tools'>): number {
    const complete = { ...request, maxOutputTokens: 1024, deadlineMs: 0, signal: new AbortController().signal };
    return Math.max(...this.routes.map(route => this.estimateInputTokens(openRouterPayload(complete, route, 1024))));
  }
  private report(attempt: OpenRouterAttempt): void {
    try { this.onAttempt?.(structuredClone(attempt)); } catch { /* Telemetry cannot retry inference or effects. */ }
  }
  complete(request: CompletionRequest): Promise<AIResponse> {
    return this.generate(request, openRouterPayload, decodeOpenRouterResponse);
  }
  completeText(request: TextCompletionRequest): Promise<TextCompletionResult> {
    const captured = { ...request, validate: request.validate };
    return this.generate({ ...request, tools: [] },
      (req, route, tokens) => textOpenRouterPayload({ ...captured, messages: req.messages }, route, tokens),
      raw => decodeTextOpenRouterResponse(raw, captured.validate));
  }
  completeMedia(request: MediaCompletionRequest): Promise<TextCompletionResult> {
    const captured = { ...request, attachment: mediaAttachmentSchema.parse(request.attachment), validate: request.validate };
    if (!this.mediaCapabilities[captured.attachment.kind]) return Promise.reject(new GatewayError('UNSUPPORTED_CAPABILITY'));
    return this.generate({ ...request, messages: [{ role: 'user', content: captured.prompt }], tools: [] },
      (_req, route, tokens) => mediaOpenRouterPayload(captured, route, tokens),
      raw => decodeTextOpenRouterResponse(raw, captured.validate),
      route => route.media?.includes(captured.attachment.kind) === true);
  }
  completeStructured(request: StructuredCompletionRequest): Promise<StructuredCompletionResult> {
    if (!this.capabilities.structuredOutput) return Promise.reject(new GatewayError('UNSUPPORTED_CAPABILITY'));
    // Detach the schema and capture the validator before any asynchronous transport work.
    const structured = { ...request, output: structuredClone(request.output), validate: request.validate };
    return this.generate({ ...request, tools: [] },
      (_request, route, tokens) => structuredOpenRouterPayload({ ...structured, messages: _request.messages }, route, tokens),
      raw => decodeStructuredOpenRouterResponse(raw, structured.validate),
      route => route.structuredOutput === true);
  }
  private async generate<T extends { readonly usage: AIResponse['usage'] }>(request: CompletionRequest,
    payloadFor: (request: CompletionRequest, route: OpenRouterRoute, tokens: number) => JsonObject,
    decode: (raw: unknown) => T, accepts: (route: OpenRouterRoute) => boolean = () => true): Promise<T> {
    if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 || !Number.isFinite(request.deadlineMs)
      || (request.maxInputTokens !== undefined && (!Number.isSafeInteger(request.maxInputTokens) || request.maxInputTokens < 1))
      || (request.maxTotalTokens !== undefined && (!Number.isSafeInteger(request.maxTotalTokens) || request.maxTotalTokens < 1))) throw new GatewayError('INVALID_REQUEST');
    if (request.spendLimit && [request.spendLimit.maxUsd, request.spendLimit.inputUsdPerMillion, request.spendLimit.outputUsdPerMillion].some(value => !Number.isFinite(value) || value < 0)) throw new GatewayError('INVALID_REQUEST');
    request = { ...request, messages: aiTranscriptSchema.parse(request.messages), tools: structuredClone(request.tools),
      ...(request.spendLimit ? { spendLimit: structuredClone(request.spendLimit) } : {}) };
    const usage = { inputTokens: 0, outputTokens: 0 };
    const fail: (code: GatewayFailureCode, complete?: boolean) => never = (code, complete = true) => { throw new GatewayError(code, usage, complete); };
    for (const route of this.routes) {
      if (this.failedRoutes.has(route.id) || !accepts(route)) continue;
      if (request.signal.aborted) fail('GATEWAY_ABORTED');
      const remainingMs = Math.floor(request.deadlineMs - this.now());
      if (remainingMs < 1) fail('GATEWAY_DEADLINE');
      const output = Math.min(request.maxOutputTokens - usage.outputTokens, route.maxOutputTokens ?? Infinity);
      if (output < 1 || (request.maxInputTokens !== undefined && usage.inputTokens >= request.maxInputTokens)
        || (request.maxTotalTokens !== undefined && usage.inputTokens + usage.outputTokens >= request.maxTotalTokens)) fail('GATEWAY_BUDGET');
      if (route.minOutputTokens !== undefined && output < route.minOutputTokens) continue;
      const body = JSON.stringify(payloadFor(request, route, output));
      // Conservative reservation, not provider tokenization. Includes schemas and wire overhead.
      const inputEstimate = this.estimateInputTokens(JSON.parse(body));
      if (!Number.isSafeInteger(inputEstimate) || inputEstimate < 0) fail('INVALID_REQUEST');
      const totalRemaining = request.maxTotalTokens === undefined ? Infinity : request.maxTotalTokens - usage.inputTokens - usage.outputTokens;
      if ((request.maxInputTokens !== undefined && usage.inputTokens + inputEstimate > request.maxInputTokens) || inputEstimate >= totalRemaining) fail('GATEWAY_BUDGET');
      const payload = JSON.parse(body) as Record<string, unknown>;
      payload.max_tokens = Math.min(output, totalRemaining - inputEstimate);
      if (route.minOutputTokens !== undefined && Number(payload.max_tokens) < route.minOutputTokens) continue;
      const estimatedSpend = request.spendLimit ? ((usage.inputTokens + inputEstimate) * request.spendLimit.inputUsdPerMillion
        + (usage.outputTokens + Number(payload.max_tokens)) * request.spendLimit.outputUsdPerMillion) / 1e6 : 0;
      if (request.spendLimit && estimatedSpend > request.spendLimit.maxUsd) fail('GATEWAY_BUDGET');
      const advertisedTools = advertisedToolSnapshot(payload);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(route.timeoutMs, remainingMs, 2147483647));
      const signal = AbortSignal.any([request.signal, controller.signal]);
      let response: Response;
      let raw: unknown;
      try {
        response = await abortable(() => this.transport('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.#apiKey}`,
            'HTTP-Referer': 'https://fivelabs.co', 'X-Title': 'Hermes Assistant' },
          body: JSON.stringify(payload), signal,
        }), signal);
        raw = await abortable(() => response.json() as Promise<unknown>, signal);
      } catch {
        this.report({ route: route.id, model: route.model, requestedProviders: route.providers, provider: null,
          generationId: null, inputEstimate, usage: null, status: null, outcome: 'transport_unknown',
          failureClass: 'transport_uncertainty', ...advertisedTools });
        if (request.signal.aborted) fail('GATEWAY_ABORTED', false);
        if (this.now() >= request.deadlineMs) fail('GATEWAY_DEADLINE', false);
        // Unknown inference spend must not be silently represented by zero or retried.
        fail('UNVERIFIED_USAGE', false);
      } finally { clearTimeout(timer); }
      const metadata = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      const rejection = metadata.error !== null && typeof metadata.error === 'object'
        ? metadata.error as Record<string, unknown> : null;
      // A pre-generation 429 error envelope is an explicit rejected request, not
      // an interrupted completion. Never extend this exception to missing usage
      // on success, a generated ID/choices, transport errors, or generic 5xx.
      const rejectedBeforeGeneration = response.status === 429 && rejection?.code === 429
        && !Object.hasOwn(metadata, 'id') && !Object.hasOwn(metadata, 'choices')
        && (metadata.usage === undefined || metadata.usage === null);
      const attemptUsage = reportedOpenRouterUsage(raw)
        ?? (rejectedBeforeGeneration ? { inputTokens: 0, outputTokens: 0 } : null);
      const safeLabel = (value: unknown): string | null => typeof value === 'string' && /^[\w./:-]{1,200}$/.test(value) ? value : null;
      // Categories describe observed evidence, not recovery permission. Prefer an
      // explicit envelope to missing usage; only the existing auth/429 branches
      // receive HTTP-specific labels. A generic 502 says nothing about safe spend.
      let failureClass: OpenRouterAttempt['failureClass'] = response.status === 401 || response.status === 403
        ? 'authentication' : rejectedBeforeGeneration ? 'rate_limit' : rejection ? 'provider_error'
          : !attemptUsage ? 'missing_usage' : !response.ok ? 'provider_error' : undefined;
      let rejectedToolName: string | undefined;
      try {
        if (attemptUsage) {
          usage.inputTokens += attemptUsage.inputTokens; usage.outputTokens += attemptUsage.outputTokens;
        }
        if (request.signal.aborted) fail('GATEWAY_ABORTED', attemptUsage !== null);
        if (this.now() >= request.deadlineMs) fail('GATEWAY_DEADLINE', attemptUsage !== null);
        if (response.status === 401 || response.status === 403) fail('AUTHENTICATION_FAILED', attemptUsage !== null);
        // Groq can wrap an explicit whole-decision tool validation rejection in
        // HTTP 200. Never execute failed_generation or infer zero inference spend.
        // This narrow protocol classification is not user-text intent routing.
        if (payloadFor === openRouterPayload && rejection?.code === 502 && !Object.hasOwn(metadata, 'choices')
          && typeof rejection.message === 'string') {
          const matches = [...rejection.message.matchAll(/\battempted\s+to\s+call\s+tool\s+(['"])([a-zA-Z0-9_-]{1,64})\1\s+which\s+was\s+not\s+in\s+request\.tools\b/gi)];
          const name = matches.length === 1 ? matches[0]?.[2] : null;
          if (name && !request.tools.some(tool => tool.name === name)) {
            failureClass = 'unadvertised_tool_rejection';
            rejectedToolName = name;
            throw new ToolSelectionError(name, usage, attemptUsage !== null);
          }
          const argumentMatches = [...rejection.message.matchAll(/\bparameters\s+for\s+tool\s+['"]?([a-zA-Z0-9_-]{1,64})['"]?\s+did\s+not\s+match\s+schema\b/gi)];
          const argumentTool = argumentMatches.length === 1 ? argumentMatches[0]?.[1] : null;
          if (argumentTool && request.tools.some(tool => tool.name === argumentTool)) {
            failureClass = 'tool_arguments_rejection';
            rejectedToolName = argumentTool;
            throw new ToolArgumentsError(argumentTool, usage, attemptUsage !== null);
          }
        }
        if (!attemptUsage) fail('UNVERIFIED_USAGE', false);
        if (usage.outputTokens > request.maxOutputTokens || (request.maxInputTokens !== undefined && usage.inputTokens > request.maxInputTokens)
          || (request.maxTotalTokens !== undefined && usage.inputTokens + usage.outputTokens > request.maxTotalTokens)) fail('GATEWAY_BUDGET');
        const reportedSpend = request.spendLimit ? (usage.inputTokens * request.spendLimit.inputUsdPerMillion
          + usage.outputTokens * request.spendLimit.outputUsdPerMillion) / 1e6 : 0;
        if (request.spendLimit && reportedSpend > request.spendLimit.maxUsd) fail('GATEWAY_BUDGET');
        if (!response.ok) { this.failedRoutes.add(route.id); continue; }
        let decoded: T;
        try { decoded = decode(raw); }
        catch {
          failureClass ??= 'invalid_response';
          this.failedRoutes.add(route.id); continue;
        }
        // Local validation may consume time or observe cancellation too.
        if (request.signal.aborted) fail('GATEWAY_ABORTED');
        if (this.now() >= request.deadlineMs) fail('GATEWAY_DEADLINE');
        return { ...decoded, usage };
      } finally {
        // Report once, after decoding, including throw/continue exits. report()
        // detaches the event and swallows telemetry failures as before.
        this.report({ route: route.id, model: safeLabel(metadata.model) ?? route.model, requestedProviders: route.providers,
          provider: typeof metadata.provider === 'string' && /^[\w ./:()-]{1,200}$/.test(metadata.provider) && metadata.provider.trim()
            ? metadata.provider : null, generationId: safeLabel(metadata.id), inputEstimate,
          usage: attemptUsage, status: response.status, outcome: 'response',
          ...(typeof rejection?.code === 'number' ? { providerErrorCode: rejection.code } : {}),
          ...(failureClass ? { failureClass } : {}), ...advertisedTools,
          ...(rejectedToolName ? { rejectedToolName } : {}) });
      }
    }
    return fail('ROUTES_EXHAUSTED');
  }
}

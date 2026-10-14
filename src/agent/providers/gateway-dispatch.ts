import { buildResponseSynthesisMessages, normalizeResponseSynthesis, type ResponseSynthesisInput } from './response-synthesis-presentation.js';
import type { GatewayRouteProfile } from './gateway-routing.js';
import type { GatewayAttemptOptions, GatewayAttemptResult } from './gateway-attempt.js';
import type { GatewayChainOptions, GatewayChainResult } from './gateway-chain.js';
import type { GatewayRequestOptions } from './gateway-request-payload.js';

export interface GatewayDispatchDependencies {
  getOpenRouterApiKey(): string | null;
  createForegroundProfiles(options: { strictStructuredOutput: boolean }): GatewayRouteProfile[];
  createBackgroundProfiles(): GatewayRouteProfile[];
  runOpenRouterChain(messages: readonly unknown[], profiles: readonly GatewayRouteProfile[], options: GatewayChainOptions): Promise<GatewayChainResult>;
  callOpenRouterAttempt(messages: readonly unknown[], model: string, apiKey: string, options: GatewayAttemptOptions): Promise<GatewayAttemptResult>;
  logger: Pick<Console, 'error' | 'warn'>;
}
export interface ChatCompletionOptions extends GatewayRequestOptions {
  correlationId?: unknown; returnMessage?: boolean; purpose?: string; startStage?: string | null;
  validateStructuredContent?: GatewayAttemptOptions['validateStructuredContent']; language?: string;
}
export interface MemoryExtractionOptions { temperature?: number; max_tokens?: number; timeoutMs?: number }
export interface ResponseSynthesisCallOptions extends ResponseSynthesisInput { correlationId?: unknown }
export interface GatewayUnavailableMessage { role: 'assistant'; content: string; tool_calls: never[]; unavailable: true; unavailableReason: string }
export type GatewayDispatchResult = GatewayChainResult | GatewayUnavailableMessage | { attemptDiagnostics: Record<string, unknown> | null | undefined; [key: string]: unknown };

/** Public gateway operations preserve host routes and purpose-specific request budgets. */
export function createGatewayDispatch({ getOpenRouterApiKey, createForegroundProfiles, createBackgroundProfiles, runOpenRouterChain, callOpenRouterAttempt, logger }: GatewayDispatchDependencies) {
  function unavailableText(language = 'es'): string {
    return language === 'en'
      ? 'I could not complete that action right now. Please try again in a moment.'
      : 'No pude completar esa acción en este momento. Inténtalo nuevamente en un momento.';
  }

  function buildUnavailableResponse(returnMessage: boolean, reason = 'compatible_routes_exhausted', language = 'es'): string | GatewayUnavailableMessage {
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

  async function callChatCompletion(messages: readonly unknown[], {
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
  }: ChatCompletionOptions = {}): Promise<GatewayDispatchResult> {
    const openrouterKey = getOpenRouterApiKey();
    const nativeToolMode = Array.isArray(tools);
    const safeCorrelationId = typeof correlationId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(correlationId) ? correlationId : null;
    const logPrefix = safeCorrelationId ? `[ai-client req=${safeCorrelationId}]` : '[ai-client]';

    if (!openrouterKey) {
      logger.error(`${logPrefix} OPENROUTER_API_KEY is not configured.`);
      return buildUnavailableResponse(returnMessage, 'missing_credentials', language);
    }

    const strictStructuredOutput = requestedResponseFormat?.type === 'json_schema'
      && (requestedResponseFormat.json_schema as { strict?: unknown } | undefined)?.strict === true;
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

    const exhausted = result as { chainExhausted?: unknown; unavailableReason?: string; attemptDiagnostics?: Record<string, unknown> | null } | null;
    if (exhausted?.chainExhausted) {
      return { ...(buildUnavailableResponse(returnMessage, exhausted.unavailableReason, language) as unknown as Record<string, unknown>), attemptDiagnostics: exhausted.attemptDiagnostics };
    }
    return result || buildUnavailableResponse(returnMessage, 'compatible_routes_exhausted', language);
  }

  async function callResponseSynthesis({ facts, excludedClauses = [], language = 'es', correlationId = null }: ResponseSynthesisCallOptions = {}): Promise<{ before: string; after: string } | null> {
    const openrouterKey = getOpenRouterApiKey();
    if (!openrouterKey) return null;
    const messages = buildResponseSynthesisMessages({ facts, excludedClauses, language } as ResponseSynthesisInput);
    if (!messages) return null;
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
      const parsed = JSON.parse((result || '{}') as string);
      return normalizeResponseSynthesis(parsed);
    } catch {
      return null;
    }
  }

  async function callOpenRouterChat(messages: readonly unknown[], model: string, apiKey: string, options: GatewayAttemptOptions = {}): Promise<string | import('./gateway-attempt.js').GatewayAssistantMessage | null> {
    const attempt = await callOpenRouterAttempt(messages, model, apiKey, options);
    return attempt.ok ? attempt.value : null;
  }

  async function callMemoryExtraction(messages: readonly unknown[], {
    temperature = 0.1,
    max_tokens = 600,
    timeoutMs = 9000,
  }: MemoryExtractionOptions = {}): Promise<GatewayChainResult> {
    const openrouterKey = getOpenRouterApiKey();
    if (!openrouterKey) {
      logger.warn('[ai-memory] OPENROUTER_API_KEY is not configured.');
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
  return { callChatCompletion, callResponseSynthesis, callOpenRouterChat, callMemoryExtraction };
}

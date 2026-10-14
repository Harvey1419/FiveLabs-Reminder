import type { GatewayRequestOptions } from './gateway-request-payload.js';
import type { GatewayRouteProfile } from './gateway-routing.js';
import type { GatewayAttemptOptions, GatewayAttemptResult, GatewayAssistantMessage } from './gateway-attempt.js';

export interface GatewayChainProfile extends GatewayRouteProfile { requiredToolName?: string }
export interface GatewayChainOptions {
  apiKey: string; purpose: string; temperature: number | undefined; maxTokens: number;
  responseFormat: GatewayRequestOptions['responseFormat']; tools: readonly unknown[] | null;
  toolChoice: unknown; returnMessage: boolean; logPrefix: string | null;
  validateStructuredContent?: GatewayAttemptOptions['validateStructuredContent']; correlationId?: unknown;
}
export type GatewayChainResult = string | GatewayAssistantMessage | null
  | { role: 'assistant'; content: ''; tool_calls: never[]; unavailable: true; refused: true; attemptDiagnostics: Record<string, unknown> | null }
  | { chainExhausted: true; unavailableReason: string; attemptDiagnostics: Record<string, unknown> | null };
export interface GatewayChainDependencies {
  callOpenRouterAttempt(messages: readonly unknown[], model: string, apiKey: string, options: GatewayAttemptOptions): Promise<GatewayAttemptResult>;
  logger: Pick<Console, 'log' | 'warn'>;
}
export function createGatewayChain({ callOpenRouterAttempt, logger }: GatewayChainDependencies) {
  function requiredDecisionMissing(attempt: GatewayAttemptResult, { requestedToolChoice, tools, returnMessage }: { requestedToolChoice: unknown; tools: readonly unknown[] | null; returnMessage: boolean }): boolean {
    if (requestedToolChoice !== 'required' || !tools?.length || !attempt?.ok || !returnMessage) return false;
    const toolCalls = typeof attempt.value === 'string' ? undefined : attempt.value?.tool_calls;
    return !Array.isArray(toolCalls) || toolCalls.length === 0;
  }

  async function runOpenRouterChain(messages: readonly unknown[], profiles: readonly GatewayChainProfile[], {
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
  }: GatewayChainOptions): Promise<GatewayChainResult> {
    let previousFailure = 'initial_request';
    let lastAttemptDiagnostics: Record<string, unknown> | null = null;

    for (const profile of profiles) {
      const unsupportedStrictRoute = purpose === 'initial'
        && responseFormat?.type === 'json_schema' && (responseFormat.json_schema as { strict?: unknown } | undefined)?.strict === true
        && profile.supportsStrictStructuredOutputs !== true;
      if (unsupportedStrictRoute) {
        if (logPrefix) logger.warn(`${logPrefix} route purpose=${purpose} stage=${profile.stage} model=${profile.model} provider=${profile.providers.join(',')} outcome=skipped reason=unsupported_structured_outputs`);
        if (previousFailure === 'initial_request') previousFailure = 'unsupported_structured_outputs';
        continue;
      }
      if (logPrefix && previousFailure !== 'initial_request') {
        logger.log(`${logPrefix} route purpose=${purpose} stage=${profile.stage} model=${profile.model} provider=${profile.providers.join(',')} trigger=${previousFailure}`);
      }

      const hasRequiredNamedTool = toolChoice === 'required'
        && profile.requiredToolName
        && tools?.some((item) => (item as { function?: { name?: unknown } } | null | undefined)?.function?.name === profile.requiredToolName);
      const effectiveToolChoice = hasRequiredNamedTool
        ? { type: 'function', function: { name: profile.requiredToolName } }
        : toolChoice === 'required' && profile.requiredToolChoiceSupported === false
          ? 'auto'
          : toolChoice;
      let attempt: GatewayAttemptResult | undefined;
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
          if (logPrefix) logger.warn(`${logPrefix} attempt purpose=${purpose} stage=${profile.stage} outcome=failed reason=required_tool_missing_after_auto_fallback`);
          attempt = { ok: false, reason: 'required_tool_missing', attemptDiagnostics: lastAttemptDiagnostics };
        }

        // Only malformed/empty structured responses get a same-provider retry.
        // Upstream finish errors are already authoritative provider failures and
        // move immediately to an independent provider to keep foreground latency bounded.
        const retryableStructuredMiss = attempt.reason === 'empty_content'
          || attempt.reason === 'required_tool_missing';
        if (attempt.ok || !retryableStructuredMiss || attemptNumber === maxAttempts) break;
        if (logPrefix) logger.warn(`${logPrefix} retry purpose=${purpose} stage=${profile.stage} reason=${attempt.reason} attempt=${attemptNumber + 1}`);
      }

      if (attempt!.terminal) {
        if (logPrefix) logger.warn(`${logPrefix} route purpose=${purpose} stopped reason=provider_refusal`);
        // Do not evade an explicit safety refusal through an independent model.
        return returnMessage
          ? { role: 'assistant', content: '', tool_calls: [], unavailable: true, refused: true, attemptDiagnostics: lastAttemptDiagnostics }
          : JSON.stringify({ type: 'chat', reply: 'No puedo completar esa solicitud. No ejecuté ninguna acción.' });
      }
      if (attempt!.ok) return attempt!.value;
      previousFailure = attempt!.reason!;
    }

    if (logPrefix) logger.warn(`${logPrefix} route purpose=${purpose} exhausted reason=${previousFailure}`);
    return returnMessage ? { chainExhausted: true, unavailableReason: previousFailure, attemptDiagnostics: lastAttemptDiagnostics } : null;
  }

  return { runOpenRouterChain };
}

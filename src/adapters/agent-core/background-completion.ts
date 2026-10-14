import { aiResponseSchema, aiTranscriptSchema, jsonObjectSchema, type JsonObject } from '@templelabs/contracts';
import type { StructuredAIProvider, TextAIProvider, CompletionRequest } from '@templelabs/ai';
import type { BackgroundPurpose } from './configured-ai-provider.js';

export interface BackgroundCompletionScope {
  readonly purpose: BackgroundPurpose; readonly deadlineMs: number; readonly signal: AbortSignal;
  readonly maxOutputTokens: number; readonly now?: () => number;
  readonly maxInputTokens?: number; readonly maxTotalTokens?: number; readonly spendLimit?: CompletionRequest['spendLimit'];
}
export interface LegacyBackgroundCompletionOptions {
  readonly purpose: string; readonly max_tokens: number; readonly tools: null; readonly returnMessage: true;
  readonly responseFormat: { readonly type: 'json_schema'; readonly json_schema: { readonly name: string; readonly strict: true; readonly schema: JsonObject } };
  readonly validateStructuredContent: (text: string) => { readonly valid: boolean };
}
function capture(scope: BackgroundCompletionScope) {
  const { deadlineMs, signal, maxOutputTokens } = scope, now = scope.now ?? Date.now;
  if (!Number.isFinite(deadlineMs) || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) throw new Error('INVALID_BACKGROUND_SCOPE');
  const assertFresh = () => { signal.throwIfAborted(); const clock = now(); if (!Number.isFinite(clock) || clock >= deadlineMs) throw new Error('BACKGROUND_DEADLINE'); };
  return { assertFresh, request: { deadlineMs, signal, maxOutputTokens,
    ...(scope.maxInputTokens !== undefined ? { maxInputTokens: scope.maxInputTokens } : {}),
    ...(scope.maxTotalTokens !== undefined ? { maxTotalTokens: scope.maxTotalTokens } : {}),
    ...(scope.spendLimit ? { spendLimit: structuredClone(scope.spendLimit) } : {}) } };
}
/** Inject into existing pure compilers/admission/advice functions; never persist or execute their output here. */
export function createBackgroundCompletion(provider: StructuredAIProvider, scope: BackgroundCompletionScope) {
  provider = provider.forTurn?.() ?? provider;
  const purpose = scope.purpose, captured = capture(scope);
  if (!['policy_compilation', 'memory_admission', 'next_best_action'].includes(purpose)) throw new Error('INVALID_BACKGROUND_PURPOSE');
  return async (messages: unknown, options: LegacyBackgroundCompletionOptions) => {
    captured.assertFresh();
    if (options.purpose !== purpose || options.tools !== null || options.returnMessage !== true
      || options.responseFormat?.type !== 'json_schema' || options.responseFormat.json_schema?.strict !== true
      || !Number.isSafeInteger(options.max_tokens) || options.max_tokens < 1 || typeof options.validateStructuredContent !== 'function') throw new Error('INVALID_BACKGROUND_REQUEST');
    const output = structuredClone(options.responseFormat.json_schema), validate = options.validateStructuredContent;
    const parse = (value: JsonObject) => {
      const checked = validate(JSON.stringify(value));
      if (!checked || checked.valid !== true) throw new Error('INVALID_BACKGROUND_DECISION');
      return jsonObjectSchema.parse(value);
    };
    const result = await provider.completeStructured({ ...captured.request, messages: aiTranscriptSchema.parse(messages),
      maxOutputTokens: Math.min(options.max_tokens, captured.request.maxOutputTokens), output, validate: parse });
    captured.assertFresh(); aiResponseSchema.shape.usage.parse(result.usage);
    if (result.status === 'refused' && result.data === null) return { content: '', unavailable: true as const };
    if (result.status !== 'success') throw new Error('INVALID_BACKGROUND_RESULT');
    return { content: JSON.stringify(parse(jsonObjectSchema.parse(result.data))), unavailable: false as const };
  };
}
/** Extraction yields proposals only. Existing grounding and semantic admission still precede every save. */
export function createMemoryExtractionCompletion(provider: TextAIProvider, scope: BackgroundCompletionScope) {
  if (scope.purpose !== 'memory') throw new Error('INVALID_BACKGROUND_PURPOSE');
  provider = provider.forTurn?.() ?? provider;
  const captured = capture(scope);
  const validate = (text: string) => {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.length > 16) throw new Error('INVALID_MEMORY_PROPOSALS');
    parsed.forEach(value => jsonObjectSchema.parse(value));
    return JSON.stringify(parsed);
  };
  return async (messages: unknown): Promise<string | null> => {
    captured.assertFresh();
    const result = await provider.completeText({ ...captured.request, messages: aiTranscriptSchema.parse(messages), validate });
    captured.assertFresh(); aiResponseSchema.shape.usage.parse(result.usage);
    if (result.status === 'refused' && result.text === null) return null;
    if (result.status !== 'success') throw new Error('INVALID_BACKGROUND_RESULT');
    return validate(result.text);
  };
}

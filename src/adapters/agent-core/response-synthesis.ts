import { aiResponseSchema, jsonObjectSchema } from '@templelabs/contracts';
import type { TextAIProvider, TextCompletionRequest } from '@templelabs/ai';
import { buildResponseSynthesisMessages, normalizeResponseSynthesis, type ResponseSynthesisInput } from '../../agent/providers/client.js';

/** Optional prefix only. Deterministic verified cards and execution authority remain outside synthesis. */
export async function synthesizeExcludedFraming(provider: TextAIProvider,
  request: Omit<TextCompletionRequest, 'messages' | 'validate' | 'responseFormat'>,
  input: ResponseSynthesisInput, now: () => number = Date.now) {
  const messages = buildResponseSynthesisMessages(structuredClone(input));
  if (!messages) return null;
  if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1) throw new Error('INVALID_SYNTHESIS_BUDGET');
  const captured = { ...request, maxOutputTokens: Math.min(request.maxOutputTokens, 180) };
  const fresh = () => { captured.signal.throwIfAborted(); const clock = now();
    if (!Number.isFinite(clock) || !Number.isFinite(captured.deadlineMs) || clock >= captured.deadlineMs) throw new Error('SYNTHESIS_DEADLINE'); };
  const parse = (text: string) => {
    const parsed = jsonObjectSchema.parse(JSON.parse(text));
    if (['before', 'after'].some(key => parsed[key] !== undefined && typeof parsed[key] !== 'string')) throw new Error('INVALID_SYNTHESIS');
    return normalizeResponseSynthesis(parsed);
  };
  fresh(); provider = provider.forTurn?.() ?? provider;
  const result = await provider.completeText({ ...captured, messages, responseFormat: 'json_object',
    validate: text => JSON.stringify(parse(text)) });
  fresh(); const usage = aiResponseSchema.shape.usage.parse(result.usage);
  if (usage.outputTokens > captured.maxOutputTokens) throw new Error('SYNTHESIS_BUDGET_EXCEEDED');
  if (result.status === 'refused' && result.text === null) return null;
  if (result.status !== 'success') throw new Error('INVALID_SYNTHESIS_RESULT');
  return { ...parse(result.text), usage: result.usage, grantsExecution: false as const };
}

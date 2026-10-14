import { z } from 'zod';
import { estimateBoundedInput } from '@templelabs/ai';
import { jsonObjectSchema, type MemoryRequest, type MemoryRecord, type TurnContext } from '@templelabs/contracts';
import { createMemoryForgettingSelector } from '../../agent/orchestration/memory-forgetting-selection.js';
import type { ObservedTargetCompletion } from '../../agent/orchestration/observed-target-resolution.js';
import { createMemoryAdmission } from '../../features/memory/memory-admission.js';
import { createConfiguredBackgroundAIProvider } from './configured-ai-provider.js';
import { MemoryEmbeddingClient } from './memory-embedding-client.js';
import { createConfiguredEmbeddingProvider } from './configured-endpoint-providers.js';
function memorySelectionCompletion(context: TurnContext, phase: string): ObservedTargetCompletion {
  const provider = createConfiguredBackgroundAIProvider('memory_admission', { estimateInputTokens: estimateBoundedInput,
    onAttempt: attempt => { try { console.info('[agent-core-v2] memory_admission_attempt', JSON.stringify({ runId: context.runId, requestId: context.requestId, phase, ...attempt })); } catch { /* Observability never retries a write. */ } } });
  return async (messages, options) => {
    const format = z.object({ json_schema: z.object({ name: z.string(), schema: jsonObjectSchema }) }).parse(options.responseFormat);
    const result = await provider.completeStructured({ messages, output: format.json_schema,
      maxInputTokens: 1800, maxTotalTokens: 3000, maxOutputTokens: 1024, deadlineMs: Date.now() + 6000, signal: context.signal,
      validate: value => z.strictObject({ positions: z.array(z.number().int().positive()).max(5) }).parse(value) });
    try { console.info('[agent-core-v2] memory_admission_usage', JSON.stringify({ runId: context.runId, requestId: context.requestId, phase, usage: result.usage })); } catch { /* Not delivery authority. */ }
    return result.status === 'success' ? { content: JSON.stringify(result.data) } : { unavailable: true };
  };
}
export async function admitExplicitMemory(text: string, request: Extract<MemoryRequest, { operation: 'save' }>, context: TurnContext): Promise<boolean> {
  const admission = createMemoryAdmission(() => memorySelectionCompletion(context, 'memory_save_admission'));
  const candidates = await admission.validateMemoryCandidates({ userText: text, candidates: [{ content: request.input.content,
    category: request.input.category, evidence: text.slice(request.input.evidenceStart, request.input.evidenceEnd) }], throwOnError: true });
  return candidates.length === 1;
}
export async function verifyMemoryForget(text: string, records: readonly MemoryRecord[], targetId: string, context: TurnContext, displayed: readonly MemoryRecord[] = []): Promise<boolean> {
  const selector = createMemoryForgettingSelector(() => memorySelectionCompletion(context, 'memory_forget_scope'));
  const ids = await selector({ query: text, candidates: records.slice(0, 5).map(record => ({ id: record.id,
    content: record.id === targetId ? record.content : record.content.slice(0, 80), ...(record.topicKey ? { topic_key: record.topicKey } : {}) })), displayedCandidates: displayed.map(record => ({ id: record.id, content: record.status === 'forgotten' ? '[forgotten memory]' : record.content })), language: context.language });
  return ids?.includes(targetId) === true;
}
export async function embedExplicitMemory(text: string, context: TurnContext): Promise<readonly number[] | null> {
  try {
    const client = new MemoryEmbeddingClient(createConfiguredEmbeddingProvider(), { deadlineMs: Date.now() + 6000, signal: context.signal, maxInputTokens: 1800 });
    const result = await client.embedOne(text);
    try { console.info('[agent-core-v2] memory_embedding_usage', JSON.stringify({ runId: context.runId, requestId: context.requestId, usage: result.usage })); } catch { /* No write authority. */ }
    return result.vector;
  } catch { context.signal.throwIfAborted(); return null; }
}

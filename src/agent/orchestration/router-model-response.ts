interface RawToolCall { id?: unknown; name?: unknown; arguments?: unknown; function?: { name?: unknown; arguments?: unknown } }
interface ConsumedModelResponse extends Record<string, unknown> { tool_calls?: RawToolCall[]; content?: unknown }
export interface NormalizedToolCall { id: unknown; name: unknown; arguments: unknown }
export interface NormalizedModelResponse extends Record<string, unknown> {
  content: string; toolCalls: NormalizedToolCall[]; unavailable: boolean;
  unavailableReason?: unknown; refused?: boolean; structuredIntent?: unknown;
  generationId?: unknown; usage?: unknown; model?: unknown; provider?: unknown; routeStage?: unknown;
}

/** Normalizes provider response shape without granting validation or execution authority to metadata. */
export function normalizeModelResponse(input: unknown): NormalizedModelResponse {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { content: typeof input === 'string' ? input.trim() : '', toolCalls: [], unavailable: false };
  }
  const modelResponse = input as ConsumedModelResponse;
  const toolCalls = (modelResponse.tool_calls || []).map((toolCall, index) => ({
    id: toolCall.id || `call_${index + 1}`,
    name: toolCall.function?.name || toolCall.name,
    arguments: toolCall.function?.arguments ?? toolCall.arguments ?? '{}',
  })).filter((call) => Boolean(call.name));
  return {
    content: typeof modelResponse.content === 'string' ? modelResponse.content.trim() : '',
    toolCalls,
    unavailable: modelResponse.unavailable === true,
    unavailableReason: modelResponse.unavailableReason || null,
    refused: modelResponse.refused === true,
    structuredIntent: modelResponse.structuredIntent || null,
    // Observability only: these fields never participate in intent validation or
    // execution authority. Preserve usage verbatim, including missing counters.
    ...(Object.hasOwn(modelResponse, 'generationId') ? { generationId: modelResponse.generationId } : {}),
    ...(Object.hasOwn(modelResponse, 'usage') ? { usage: modelResponse.usage } : {}),
    ...(Object.hasOwn(modelResponse, 'model') ? { model: modelResponse.model } : {}),
    ...(Object.hasOwn(modelResponse, 'provider') ? { provider: modelResponse.provider } : {}),
    ...(Object.hasOwn(modelResponse, 'routeStage') ? { routeStage: modelResponse.routeStage } : {}),
  };
}


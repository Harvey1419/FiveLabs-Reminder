import { aiResponseSchema, aiTranscriptSchema, jsonObjectSchema, toolCallSchema, mediaAttachmentSchema,
  type AIResponse, type JsonObject } from '@templelabs/contracts';
import type { CompletionRequest, StructuredCompletionRequest, StructuredCompletionResult, TextCompletionRequest, TextCompletionResult, MediaCompletionRequest } from './index.js';

export interface OpenRouterRoute {
  readonly id: string; readonly model: string; readonly providers: readonly string[];
  readonly timeoutMs: number; readonly structuredOutput?: boolean; readonly reasoning?: { readonly effort: string; readonly exclude: boolean };
  readonly temperature?: number; readonly minOutputTokens?: number; readonly maxOutputTokens?: number;
  readonly media?: readonly ('image' | 'pdf')[];
}

export function decodeTextOpenRouterResponse(raw: unknown, validate: TextCompletionRequest['validate']): TextCompletionResult {
  const result = decodeOpenRouterResponse(raw);
  if (result.stopReason === 'refused') return { status: 'refused', text: null, usage: result.usage };
  if (result.stopReason !== 'completed' || result.message.toolCalls.length) throw new Error('Incomplete auxiliary text');
  const text: unknown = validate(result.message.content);
  if (text instanceof Promise) { void text.catch(() => {}); throw new Error('Text validator must be synchronous'); }
  if (typeof text !== 'string' || !text.trim() || text.length > 100000) throw new Error('Invalid auxiliary validation result');
  return { status: 'success', text, usage: result.usage };
}
export function textOpenRouterPayload(request: TextCompletionRequest, route: OpenRouterRoute, tokens: number): JsonObject {
  if (typeof request.validate !== 'function' || request.responseFormat !== undefined && request.responseFormat !== 'json_object') throw new Error('Invalid text contract');
  return jsonObjectSchema.parse({ ...openRouterPayload({ ...request, tools: [] }, route, tokens),
    ...(request.responseFormat ? { response_format: { type: request.responseFormat } } : {}) });
}
export function mediaOpenRouterPayload(request: MediaCompletionRequest, route: OpenRouterRoute, tokens: number): JsonObject {
  const attachment = mediaAttachmentSchema.parse(request.attachment);
  if (typeof request.prompt !== 'string' || !request.prompt.trim() || request.prompt.length > 24000 || typeof request.validate !== 'function') throw new Error('Invalid media contract');
  const data = `data:${attachment.mimeType};base64,${attachment.dataBase64}`;
  return jsonObjectSchema.parse({ ...openRouterPayload({ ...request, messages: [{ role: 'user', content: request.prompt }], tools: [] }, route, tokens),
    messages: [{ role: 'user', content: [{ type: 'text', text: request.prompt }, attachment.kind === 'image'
      ? { type: 'image_url', image_url: { url: data } }
      : { type: 'file', file: { filename: attachment.filename, file_data: data } }] }],
    // Never silently add page-based OCR charges outside the host token reservation.
    ...(attachment.kind === 'pdf' ? { plugins: [{ id: 'file-parser', pdf: { engine: 'native' } }] } : {}),
  });
}
export interface ProviderUsage { readonly inputTokens: number; readonly outputTokens: number }
function object(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
}
export function reportedOpenRouterUsage(raw: unknown): ProviderUsage | null {
  const usage = object(object(raw)?.usage);
  const input = usage?.prompt_tokens; const output = usage?.completion_tokens;
  return typeof input === 'number' && Number.isSafeInteger(input) && input >= 0
    && typeof output === 'number' && Number.isSafeInteger(output) && output >= 0
    ? { inputTokens: input, outputTokens: output } : null;
}
/** Closed tool pairs translate together. Host operation IDs never become provider-specific identifiers. */
export function openRouterPayload(request: CompletionRequest, route: OpenRouterRoute, outputTokens: number): JsonObject {
  const history = aiTranscriptSchema.parse(request.messages);
  const callIds = new Map<string, string>();
  const messages = history.map(message => {
    if (message.role === 'assistant') return { role: message.role, content: message.content,
      ...(message.toolCalls.length ? { tool_calls: message.toolCalls.map(call => {
        const id = `call_${callIds.size}`; callIds.set(call.id, id);
        return { id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } };
      }) } : {}) };
    if (message.role === 'tool') {
      const id = callIds.get(message.toolCallId);
      if (!id) throw new Error('Invalid tool pairing');
      return { role: 'tool', tool_call_id: id, content: JSON.stringify(message.content) };
    }
    return { role: message.role, content: message.content };
  });
  if (new Set(request.tools.map(tool => tool.name)).size !== request.tools.length) throw new Error('Duplicate tools');
  for (const tool of request.tools) {
    toolCallSchema.shape.name.parse(tool.name); jsonObjectSchema.parse(tool.inputSchema);
  }
  return jsonObjectSchema.parse({ model: route.model, messages, max_tokens: outputTokens, stream: false,
    ...(route.temperature !== undefined ? { temperature: route.temperature } : {}),
    ...(route.reasoning ? { reasoning: route.reasoning } : {}),
    ...(request.tools.length ? { tools: request.tools.map(tool => ({ type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })), tool_choice: 'auto' } : {}),
    provider: { order: [...route.providers], only: [...route.providers], allow_fallbacks: false, require_parameters: true },
  });
}
export function decodeOpenRouterResponse(raw: unknown): AIResponse {
  const data = object(raw); const choices = data?.choices;
  if (data?.error || !Array.isArray(choices) || choices.length !== 1) throw new Error('Invalid response envelope');
  const choice = object(choices[0]); const message = object(choice?.message);
  const usage = reportedOpenRouterUsage(raw);
  if (!choice || choice.error || !message || message.role !== 'assistant' || !usage) throw new Error('Invalid response message');
  if (typeof message.refusal === 'string' && message.refusal || choice.finish_reason === 'content_filter') {
    return aiResponseSchema.parse({ message: { role: 'assistant', content: '', toolCalls: [] }, stopReason: 'refused', usage });
  }
  const rawCalls = message.tool_calls;
  if (rawCalls !== undefined && rawCalls !== null && !Array.isArray(rawCalls)) throw new Error('Invalid calls');
  const calls = Array.isArray(rawCalls) ? rawCalls : [];
  if (calls.length > 10) throw new Error('Oversized call batch');
  let content = '';
  if (typeof message.content === 'string') content = message.content;
  else if (Array.isArray(message.content) && message.content.every(part => object(part)?.type === 'text' && typeof object(part)?.text === 'string')) {
    content = message.content.map(part => object(part)!.text).join('\n');
  } else if (message.content !== undefined && message.content !== null) throw new Error('Invalid content');
  if (content.length > 100000) throw new Error('Oversized content');
  const finish = choice.finish_reason;
  // A parseable truncated call batch is not a complete decision.
  if (finish === 'length' && calls.length) throw new Error('Truncated calls');
  if (!['stop', 'tool_calls', 'length'].includes(String(finish))
    || (calls.length > 0 && finish !== 'tool_calls') || (finish === 'tool_calls' && !calls.length)) throw new Error('Invalid finish reason');
  if (!content.trim() && !calls.length && finish !== 'length') throw new Error('Empty completion');
  const toolCalls = calls.map(rawCall => {
    const call = object(rawCall); const fn = object(call?.function);
    if (!call || typeof call.id !== 'string' || call.id.length > 128 || call.type !== 'function' || !fn
      || typeof fn.name !== 'string' || fn.name.length > 64 || typeof fn.arguments !== 'string' || fn.arguments.length > 100000) throw new Error('Invalid function call');
    return toolCallSchema.parse({ id: call.id, name: fn.name, arguments: jsonObjectSchema.parse(JSON.parse(fn.arguments)) });
  });
  return aiResponseSchema.parse({ message: { role: 'assistant', content, toolCalls },
    stopReason: toolCalls.length ? 'tool_calls' : finish === 'length' ? 'length' : 'completed', usage });
}

/** Strict JSON is protocol data: never strip think tags or repair prose inside its string values. */
export function decodeStructuredOpenRouterResponse(raw: unknown, validate: StructuredCompletionRequest['validate']): StructuredCompletionResult {
  const data = object(raw); const choices = data?.choices;
  if (data?.error || !Array.isArray(choices) || choices.length !== 1) throw new Error('Invalid structured envelope');
  const choice = object(choices[0]); const message = object(choice?.message);
  const usage = reportedOpenRouterUsage(raw);
  if (!choice || choice.error || !message || message.role !== 'assistant' || !usage) throw new Error('Invalid structured message');
  if (choice.finish_reason === 'content_filter' || (typeof message.refusal === 'string' && message.refusal)) {
    return { status: 'refused', data: null, usage };
  }
  if (choice.finish_reason !== 'stop' || (message.tool_calls !== undefined && message.tool_calls !== null
    && (!Array.isArray(message.tool_calls) || message.tool_calls.length))) throw new Error('Invalid structured finish');
  const content = typeof message.content === 'string' ? message.content
    : Array.isArray(message.content) && message.content.every(part => object(part)?.type === 'text' && typeof object(part)?.text === 'string')
      ? message.content.map(part => object(part)!.text).join('\n') : null;
  if (!content || content.length > 100000) throw new Error('Invalid structured content');
  const parsed = jsonObjectSchema.parse(JSON.parse(content));
  const validated = validate(structuredClone(parsed));
  if (validated instanceof Promise) { void validated.catch(() => {}); throw new Error('Validator must be synchronous'); }
  if (!object(validated) || ![Object.prototype, null].includes(Object.getPrototypeOf(validated))) throw new Error('Validator must return a synchronous plain JSON object');
  return { status: 'success', data: jsonObjectSchema.parse(validated), usage };
}

export function structuredOpenRouterPayload(request: StructuredCompletionRequest, route: OpenRouterRoute, outputTokens: number): JsonObject {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(request.output.name) || typeof request.validate !== 'function') throw new Error('Invalid structured contract');
  const schema = jsonObjectSchema.parse(request.output.schema);
  if (schema.type !== 'object' || schema.additionalProperties !== false) throw new Error('Strict output needs a closed object schema');
  return jsonObjectSchema.parse({
    ...openRouterPayload({ ...request, tools: [] }, route, outputTokens),
    response_format: { type: 'json_schema', json_schema: { name: request.output.name, strict: true, schema } },
  });
}

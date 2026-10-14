import { z } from 'zod';

const identifier = z.string().min(1);
export const jsonObjectSchema = z.record(z.string(), z.json());
export type JsonObject = z.infer<typeof jsonObjectSchema>;

export const toolCallSchema = z.strictObject({
  id: identifier,
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  arguments: jsonObjectSchema,
});
export type ToolCall = z.infer<typeof toolCallSchema>;

export const assistantMessageSchema = z.strictObject({
  role: z.literal('assistant'),
  content: z.string(),
  toolCalls: z.array(toolCallSchema),
});
export const aiMessageSchema = z.discriminatedUnion('role', [
  z.strictObject({ role: z.literal('system'), content: z.string() }),
  z.strictObject({ role: z.literal('user'), content: z.string() }),
  assistantMessageSchema,
  z.strictObject({
    role: z.literal('tool'), toolCallId: identifier,
    content: z.json(), isError: z.boolean(),
  }),
]);
export type AIMessage = z.infer<typeof aiMessageSchema>;

/** Provider-neutral history. Adapters translate tool roles to their wire protocol. */
export const aiTranscriptSchema = z.array(aiMessageSchema).min(1).superRefine((messages, ctx) => {
  const pending = new Set<string>();
  const seen = new Set<string>();
  for (const [index, message] of messages.entries()) {
    const issue = (description: string) => ctx.addIssue({ code: 'custom', path: [index], message: description });
    if (message.role === 'tool') {
      if (!pending.delete(message.toolCallId)) issue('Tool result has no pending matching call');
      continue;
    }
    if (pending.size > 0) issue('Tool results must follow the requesting assistant before other messages');
    if (message.role === 'assistant') {
      for (const call of message.toolCalls) {
        if (seen.has(call.id)) issue('Tool call IDs must be unique in a transcript');
        seen.add(call.id);
        pending.add(call.id);
      }
    }
  }
  if (pending.size > 0) ctx.addIssue({ code: 'custom', message: 'Unresolved tool calls cannot be sent for continuation' });
});

export const aiResponseSchema = z.strictObject({
  message: assistantMessageSchema,
  stopReason: z.enum(['completed', 'tool_calls', 'refused', 'length']),
  usage: z.strictObject({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
}).superRefine((response, ctx) => {
  const calls = response.message.toolCalls;
  if ((response.stopReason === 'tool_calls') !== (calls.length > 0)) {
    ctx.addIssue({ code: 'custom', message: 'Stop reason must agree with tool calls' });
  }
  if (new Set(calls.map(call => call.id)).size !== calls.length) {
    ctx.addIssue({ code: 'custom', message: 'Tool call IDs must be unique in a response' });
  }
});
export type AIResponse = z.infer<typeof aiResponseSchema>;

export interface ToolSpecification {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

export interface TurnContext {
  readonly userId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly timezone: string;
  readonly language: 'es' | 'en';
  readonly referenceTimeIso: string;
  readonly capabilities: ReadonlySet<string>;
  readonly signal: AbortSignal;
}

export type EngineVersion = 'legacy' | 'v2';


import {
  aiTranscriptSchema, reminderOperationalSummarySchema, reminderToolNameSchema,
  productivityOperationalSummarySchema, productivityToolNameSchema,
  type AIMessage, type ReminderOperationalSummary, type ProductivityOperationalSummary, type ToolCall,
} from '@templelabs/contracts';
import { canonicalArguments } from './context-manager.js';

type Operation = ProductivityOperationalSummary['recentConfirmed'][number];
type PendingOperation = ProductivityOperationalSummary['pending'][number];
const waiting = new Set(['approval_required', 'clarification_required', 'indeterminate']);

/** Derive protocol state from host-owned history, not prose or model-authored summaries.
 * Completed matching arguments resolve clarification/approval context, never an unknown effect.
 * Supersession is descriptive only: the host still authorizes each subsequent write.
 */
function summarizeOperations(history: readonly AIMessage[], omittedMessages: number,
  userId: string, scope: 'reminders' | 'productivity'): ProductivityOperationalSummary {
  aiTranscriptSchema.parse(history);
  if (!Number.isSafeInteger(omittedMessages) || omittedMessages < 1 || omittedMessages > history.length) {
    throw new Error('Invalid summary boundary');
  }
  const calls = new Map<string, { call: ToolCall; index: number }>();
  const pending = new Map<string, PendingOperation>();
  const confirmed: Operation[] = [];
  for (const [index, message] of history.entries()) {
    if (message.role === 'assistant') for (const call of message.toolCalls) calls.set(call.id, { call, index });
    if (message.role !== 'tool') continue;
    const source = calls.get(message.toolCallId);
    if (!source) throw new Error('Missing operation source');
    const name = scope === 'reminders' ? reminderToolNameSchema.safeParse(source.call.name)
      : productivityToolNameSchema.safeParse(source.call.name);
    const content = message.content;
    if (!name.success || content === null || typeof content !== 'object' || Array.isArray(content)) continue;
    const status = content.status;
    if (typeof status !== 'string') continue;
    let questions: string[] = [];
    if (typeof content.observation === 'string' || (content.observation !== null && typeof content.observation === 'object')) {
      try {
        const observation: unknown = typeof content.observation === 'string' ? JSON.parse(content.observation) : content.observation;
        if (observation !== null && typeof observation === 'object' && 'questions' in observation
          && Array.isArray(observation.questions) && observation.questions.length <= 3
          && observation.questions.every(question => typeof question === 'string' && question.length <= 500)) {
          questions = observation.questions as string[];
        }
      } catch { /* Free-form observations never become summary prose. */ }
    }
    const key = `${name.data}:${canonicalArguments(source.call.arguments)}`;
    if ((status === 'success' || status === 'partial') && !message.isError) {
      if (status === 'success') {
        for (const [callId, operation] of pending) {
          if ((operation.status === 'approval_required' || operation.status === 'clarification_required') && `${operation.toolName}:${canonicalArguments(operation.arguments)}` === key) pending.delete(callId);
        }
      }
      if (status === 'partial' && source.index < omittedMessages) pending.set(source.call.id, {
        callId: source.call.id, toolName: name.data, arguments: source.call.arguments, status, questions,
      });
      if (source.index < omittedMessages && !name.data.endsWith('_read') && name.data !== 'calendar_connect') confirmed.push({
        callId: source.call.id, toolName: name.data, arguments: source.call.arguments, status,
      });
    } else if (waiting.has(status) && source.index < omittedMessages) {
      pending.set(source.call.id, { callId: source.call.id, toolName: name.data,
        arguments: source.call.arguments, status: status as Operation['status'], questions });
    }
  }
  return productivityOperationalSummarySchema.parse({ version: 1, userId,
    provenance: 'host_owned_tool_transcript', freshness: 'historical', grantsAuthorization: false,
    omittedMessages, pending: [...pending.values()], recentConfirmed: confirmed.slice(-5) });
}

export function summarizeReminderOperations(history: readonly AIMessage[], omittedMessages: number,
  userId: string): ReminderOperationalSummary {
  return reminderOperationalSummarySchema.parse(summarizeOperations(history, omittedMessages, userId, 'reminders'));
}
export function summarizeProductivityOperations(history: readonly AIMessage[], omittedMessages: number,
  userId: string): ProductivityOperationalSummary {
  return summarizeOperations(history, omittedMessages, userId, 'productivity');
}

export class ContextLimitError extends Error {
  constructor() { super('Conversation requires compaction: recent turns exceed the context limit'); this.name = 'ContextLimitError'; }
}

export interface PreparedReminderContext {
  readonly messages: AIMessage[];
  readonly omittedMessages: number;
}
/** Try complete turn boundaries, retaining as much dialogue as fits. Default callers keep three turns;
 * bounded productivity may summarize earlier turns while retaining the entire active turn.
 * Each candidate includes its own operational summary in the budget calculation.
 * If essential context still exceeds token budget, return it for the caller's limit handling.
 */
function prepareOperationalContext(history: readonly AIMessage[], userId: string,
  systemContent: string, maxMessages: number, fitsBudget: (messages: readonly AIMessage[]) => boolean,
  summarize: (history: readonly AIMessage[], omitted: number, userId: string) => ProductivityOperationalSummary,
  minimumRecentTurns = 3, preferRecent = false): PreparedReminderContext {
  aiTranscriptSchema.parse(history);
  if (!Number.isSafeInteger(maxMessages) || maxMessages < 1
    || !Number.isSafeInteger(minimumRecentTurns) || minimumRecentTurns < 1) throw new Error('Invalid context limits');
  if (history.some(message => message.role === 'system')) throw new Error('History cannot include system messages');
  const starts = history.flatMap((message, index) => message.role === 'user' ? [index] : []);
  const candidates = [0, ...starts.slice(1, Math.max(1, starts.length - minimumRecentTurns + 1))];
  if (preferRecent) candidates.reverse();
  let minimum: PreparedReminderContext | undefined;
  for (const start of candidates) {
    const recent = history.slice(start);
    if (recent.length > maxMessages) continue;
    const summary = start ? summarize(history, start, userId) : null;
    const system: AIMessage = { role: 'system', content: systemContent
      + (summary ? `\n${JSON.stringify({ operationalSummary: summary })}` : '') };
    const messages = aiTranscriptSchema.parse([system, ...recent]);
    minimum = { messages, omittedMessages: start };
    if (fitsBudget(messages)) return structuredClone(minimum);
  }
  if (!minimum) throw new ContextLimitError();
  return structuredClone(minimum);
}

export function prepareReminderContext(history: readonly AIMessage[], userId: string, systemContent: string,
  maxMessages: number, fitsBudget: (messages: readonly AIMessage[]) => boolean): PreparedReminderContext {
  return prepareOperationalContext(history, userId, systemContent, maxMessages, fitsBudget, summarizeReminderOperations);
}
export function prepareProductivityContext(history: readonly AIMessage[], userId: string, systemContent: string,
  maxMessages: number, fitsBudget: (messages: readonly AIMessage[]) => boolean, minimumRecentTurns = 3, preferRecent = false,
  includeHistoricalConfirmed = true): PreparedReminderContext {
  return prepareOperationalContext(history, userId, systemContent, maxMessages, fitsBudget, (source, omitted, owner) => {
    const summary = summarizeProductivityOperations(source, omitted, owner);
    return includeHistoricalConfirmed ? summary : { ...summary, recentConfirmed: [] };
  }, minimumRecentTurns, preferRecent);
}

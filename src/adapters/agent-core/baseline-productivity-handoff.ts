import { z } from 'zod';
import { productivityConversationSchema, taskRecordSchema, reminderRecordSchema, calendarEventSchema,
  type ProductivityConversation, type TaskRecord, type ReminderRecord, type CalendarEvent, type TurnContext } from '@templelabs/contracts';
import type { InboundStoredTurn, InboundCheckpointClient } from './inbound-checkpoint-reader.js';
import { normalizeLegacyReminderRecord } from './legacy-reminders.js';

const object = z.record(z.string(), z.unknown());
export interface BaselineHandoffSource {
  hasActiveRun(context: TurnContext): Promise<boolean>;
  readTask(id: string, context: TurnContext): Promise<TaskRecord | null>;
  readReminder(id: string, context: TurnContext): Promise<ReminderRecord | null>;
  readEvent(id: string, context: TurnContext, raw: unknown): Promise<CalendarEvent | null>;
}
/** Only queue-owned, completed baseline state is eligible. Prose is dialogue, never a receipt.
 * A null result leaves pending/unsupported references with the baseline before V2 admission. */
export async function handoffBaselineProductivity(prior: InboundStoredTurn, context: TurnContext,
  threadId: string, history: readonly unknown[], source: BaselineHandoffSource): Promise<ProductivityConversation | null> {
  if (prior.status !== 'completed' || prior.thread_id !== threadId) throw new Error('Invalid baseline handoff anchor');
  // Legacy administrative closures have no transferable conversation checkpoint.
  if (!prior.response) return null;
  context.signal.throwIfAborted();
  if (prior.response.intent === 'action_unconfirmed') return null;
  if (Array.isArray(prior.response.executionFacts) && prior.response.executionFacts.some(value => {
    const fact = object.safeParse(value);
    return !fact.success || ['unknown', 'partial_success'].includes(String(fact.data.outcome));
  })) return null;
  if (await source.hasActiveRun(context)) return null;
  const entities = object.parse(prior.response.entities ?? {});
  const clarification = object.parse(entities._conversationState ?? {});
  if (clarification.pendingIntent || (Array.isArray(clarification.pendingClarifications) && clarification.pendingClarifications.length)) return null;
  const memory = object.parse(entities._workingMemory ?? clarification.workingMemory ?? {});
  if (memory.infraFault === true) return null;
  const items = z.array(z.object({ internalId: z.string().optional(), id: z.string().optional(),
    type: z.string(), position: z.number().int().positive().optional(), raw: z.unknown().optional() }).passthrough())
    .max(50).parse(memory.items ?? []);
  if (items.length >= 50 && typeof memory.notificationReminderId === 'string' && !items.some(item => (item.internalId ?? item.id) === memory.notificationReminderId)) return null;
  if (typeof memory.notificationReminderId === 'string' && !items.some(item => (item.internalId ?? item.id) === memory.notificationReminderId)) {
    items.push({ id: memory.notificationReminderId, type: 'reminder' });
  }
  const tasks: TaskRecord[] = [], reminders: ReminderRecord[] = [], events: CalendarEvent[] = [];
  const referenceOrder: NonNullable<ProductivityConversation['referenceOrder']> = [];
  for (const [index, item] of items.entries()) {
    context.signal.throwIfAborted();
    const id = item.internalId ?? item.id;
    if (!id) return null;
    const domain = item.type === 'task' ? 'tasks' : item.type === 'reminder' ? 'reminders'
      : ['calendar', 'calendar_event', 'event'].includes(item.type) ? 'calendar' : null;
    if (!domain) return null;
    const record = domain === 'tasks' ? await source.readTask(id, context)
      : domain === 'reminders' ? await source.readReminder(id, context) : await source.readEvent(id, context, item.raw);
    if (!record || record.id !== id || referenceOrder.some(reference => reference.domain === domain && reference.id === id)) return null;
    if (domain === 'tasks') tasks.push(taskRecordSchema.parse(record));
    else if (domain === 'reminders') reminders.push(reminderRecordSchema.parse(record));
    else events.push(calendarEventSchema.parse(record));
    referenceOrder.push({ domain, id, position: item.position ?? index + 1 });
  }
  const dialogue = z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }))
    .parse(history).map(message => message.role === 'assistant' ? { ...message, toolCalls: [] } : message);
  // The certified final response wins over a missing/stale history tail; no invented user turn.
  if (typeof prior.response.confirmation === 'string' && dialogue.at(-1)?.content !== prior.response.confirmation) {
    dialogue.push({ role: 'assistant', content: prior.response.confirmation, toolCalls: [] });
  }
  context.signal.throwIfAborted();
  return productivityConversationSchema.parse({ userId: context.userId, history: dialogue,
    tasks, reminders, events, referenceOrder, handledRequestIds: [prior.message_id] });
}

/** Bounded, owner-filtered reads. No run expiry updates or replay of baseline actions. */
export function createBaselineHandoffSource(client: InboundCheckpointClient,
  readEvent: BaselineHandoffSource['readEvent']): BaselineHandoffSource {
  const read = async (table: string, columns: string, id: string, context: TurnContext) => {
    z.uuid().parse(id);
    const result = await client.from(table).select(columns).eq('id', id).eq('user_id', context.userId)
      .limit(1).abortSignal(AbortSignal.any([context.signal, AbortSignal.timeout(15000)])).maybeSingle();
    if (result.error) throw new Error('HANDOFF_STORAGE_UNAVAILABLE');
    if (!result.data) return null;
    const row = object.parse(result.data);
    if (row.id !== id || row.user_id !== context.userId) throw new Error('HANDOFF_OWNER_MISMATCH');
    return row;
  };
  return {
    async hasActiveRun(context) {
      const result = await client.from('agent_runs').select('id,user_id,status').eq('user_id', context.userId)
        .in('status', ['waiting_for_input', 'waiting_for_approval', 'running']).limit(1)
        .abortSignal(AbortSignal.any([context.signal, AbortSignal.timeout(15000)])).maybeSingle();
      if (result.error) throw new Error('HANDOFF_STORAGE_UNAVAILABLE');
      return result.data !== null;
    },
    async readTask(id, context) {
      const row = await read('tasks', 'id,user_id,title,description,priority,status,due_date,entity_id', id, context);
      return row ? taskRecordSchema.parse({ id: row.id, title: row.title ?? null, description: row.description ?? null,
        priority: row.priority ?? null, status: row.status ?? null, dueDateIso: row.due_date ?? null,
        entityId: row.entity_id ?? null, entityName: null }) : null;
    },
    async readReminder(id, context) {
      const row = await read('reminders', 'id,user_id,content,send_at,recurrence_rule,source,parent_reminder_id,requires_confirmation,acknowledged_at', id, context);
      return row ? reminderRecordSchema.parse(normalizeLegacyReminderRecord(row)) : null;
    },
    readEvent,
  };
}

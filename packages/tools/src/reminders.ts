import {
  reminderCreateInputSchema, reminderCreateToolInputSchema, reminderReadInputSchema, reminderUpdateInputSchema,
  reminderCancelInputSchema, reminderAcknowledgeInputSchema, reminderResultSchema,
  type ReminderRequest, type ReminderResult, type TurnContext,
} from '@templelabs/contracts';
import type { ToolOutcome } from './index.js';
import { defineTool } from './define-tool.js';
import { nextLocalClock, relativeLocalDayClock } from './local-clock.js';

export interface ReminderDomainPort {
  execute(request: ReminderRequest, context: TurnContext, operationId: string): Promise<ToolOutcome<ReminderResult>>;
}

export function createReminderTools(port: ReminderDomainPort) {
  return [
    defineTool({
      name: 'reminder_create', effect: 'write', requiredCapability: 'reminders.create',
      description: 'Create one reminder; report only returned results. delayMinutes: in N minutes. relativeDayTime: today/tomorrow, local24h (9 AM=9,9 PM=21); preserve clock when only day is answered. unqualifiedLocalTime: undated without AM/PM, earliest future half-day. targetTimeIso: absolute dates. Omit advanceMinutes unless requested; recurrence/notices follow backend entitlements.',
      inputSchema: reminderCreateToolInputSchema, outputSchema: reminderResultSchema,
      handler: async (input, context, operationId) => {
        const { delayMinutes, unqualifiedLocalTime, relativeDayTime, ...fields } = input;
        let targetTimeIso: string;
        try { targetTimeIso = relativeDayTime ? relativeLocalDayClock(relativeDayTime, context.referenceTimeIso, context.timezone)
          : unqualifiedLocalTime ? nextLocalClock(unqualifiedLocalTime, context.referenceTimeIso, context.timezone)
            : fields.targetTimeIso ?? new Date(Date.parse(context.referenceTimeIso) + delayMinutes! * 60000).toISOString(); }
        catch { return { status: 'validation_failed' as const, code: 'INVALID_LOCAL_TIME', observation: 'No write dispatched. Check the clock, timezone and temporal anchor.' }; }
        return port.execute({ operation: 'create', input: reminderCreateInputSchema.parse({ ...fields, targetTimeIso }) }, context, operationId);
      },
    }),
    defineTool({
      name: 'reminder_read', effect: 'read', requiredCapability: 'reminders.read',
      description: 'Read owned reminders using filter ("today", "tomorrow", "all_pending") and optional query. Results are bounded. Use returned IDs for subsequent changes.',
      inputSchema: reminderReadInputSchema, outputSchema: reminderResultSchema,
      handler: (input, context, operationId) => port.execute({ operation: 'read', input }, context, operationId),
    }),
    defineTool({
      name: 'reminder_update', effect: 'write', requiredCapability: 'reminders.update',
      description: 'Update one owned reminder by its observed UUID. Supply only requested changes; null recurrence removes recurrence. Delivery policy changes preserve the principal/advance-notice relationship.',
      inputSchema: reminderUpdateInputSchema, outputSchema: reminderResultSchema,
      handler: (input, context, operationId) => port.execute({ operation: 'update', input }, context, operationId),
    }),
    defineTool({ name: 'reminder_cancel', effect: 'destructive', requiredCapability: 'reminders.cancel',
      description: 'Cancel the observed owned reminder explicitly requested by the user. A recurring target cancels its active routine and linked notices. Does not acknowledge completion or erase history.',
      inputSchema: reminderCancelInputSchema, outputSchema: reminderResultSchema,
      handler: (input, context, operationId) => port.execute({ operation: 'cancel', input }, context, operationId),
    }),
    defineTool({
      name: 'reminder_acknowledge', effect: 'write', requiredCapability: 'reminders.acknowledge',
      description: 'Acknowledge the specified owned reminder after the user confirms completion. Use an observed UUID; acknowledgement is distinct from cancellation or editing its time.',
      inputSchema: reminderAcknowledgeInputSchema, outputSchema: reminderResultSchema,
      handler: (input, context, operationId) => port.execute({ operation: 'acknowledge', input }, context, operationId),
    }),
  ] as const;
}

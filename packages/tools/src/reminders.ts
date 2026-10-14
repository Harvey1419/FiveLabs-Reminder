import {
  reminderCreateInputSchema, reminderCreateToolInputSchema, reminderReadInputSchema, reminderUpdateInputSchema,
  reminderCancelInputSchema, reminderAcknowledgeInputSchema, reminderResultSchema,
  type ReminderRequest, type ReminderResult, type TurnContext,
} from '@templelabs/contracts';
import type { ToolOutcome } from './index.js';
import { defineTool } from './define-tool.js';

export interface ReminderDomainPort {
  execute(request: ReminderRequest, context: TurnContext, operationId: string): Promise<ToolOutcome<ReminderResult>>;
}

export function createReminderTools(port: ReminderDomainPort) {
  return [
    defineTool({
      name: 'reminder_create', effect: 'write', requiredCapability: 'reminders.create',
      description: 'For in N minutes use delayMinutes; the host computes the instant. Use targetTimeIso for explicit dates, never both. Omit advanceMinutes when no advance notice is requested; if present it must be positive, never zero. Create one reminder at an explicit ISO instant. Preserve the user timezone when resolving its time. Recurrence and notification policies follow backend entitlements. Report only returned results.',
      inputSchema: reminderCreateToolInputSchema, outputSchema: reminderResultSchema,
      handler: (input, context, operationId) => {
        const { delayMinutes, ...fields } = input;
        const targetTimeIso = fields.targetTimeIso ?? new Date(Date.parse(context.referenceTimeIso) + delayMinutes! * 60000).toISOString();
        return port.execute({ operation: 'create', input: reminderCreateInputSchema.parse({ ...fields, targetTimeIso }) }, context, operationId);
      },
    }),
    defineTool({
      name: 'reminder_read', effect: 'read', requiredCapability: 'reminders.read',
      description: 'Read owned reminders using an optional date scope and literal content search. Results are bounded, not a complete historical inventory. Use returned IDs for subsequent changes.',
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

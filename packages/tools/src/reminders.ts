import {
  reminderCreateInputSchema, reminderReadInputSchema, reminderUpdateInputSchema,
  reminderAcknowledgeInputSchema, reminderResultSchema,
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
      description: 'Create one reminder at an explicit ISO instant. Preserve the user timezone when resolving its time. Recurrence and notification policies follow backend entitlements. Report only returned results.',
      inputSchema: reminderCreateInputSchema, outputSchema: reminderResultSchema,
      handler: (input, context, operationId) => port.execute({ operation: 'create', input }, context, operationId),
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
    defineTool({
      name: 'reminder_acknowledge', effect: 'write', requiredCapability: 'reminders.acknowledge',
      description: 'Acknowledge the specified owned reminder after the user confirms completion. Use an observed UUID; acknowledgement is distinct from cancellation or editing its time.',
      inputSchema: reminderAcknowledgeInputSchema, outputSchema: reminderResultSchema,
      handler: (input, context, operationId) => port.execute({ operation: 'acknowledge', input }, context, operationId),
    }),
  ] as const;
}

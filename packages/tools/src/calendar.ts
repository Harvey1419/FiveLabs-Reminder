import {
  calendarCreateInputSchema, calendarReadInputSchema, calendarConnectInputSchema, calendarResultSchema,
  type CalendarRequest, type CalendarResult, type TurnContext,
} from '@templelabs/contracts';
import type { ToolOutcome } from './index.js';
import { defineTool } from './define-tool.js';

export interface CalendarDomainPort {
  execute(request: CalendarRequest, context: TurnContext, operationId: string): Promise<ToolOutcome<CalendarResult>>;
}

export function createCalendarTools(port: CalendarDomainPort) {
  return [
    defineTool({
      name: 'calendar_read', effect: 'read', requiredCapability: 'calendar.read',
      description: 'Read owned Google Calendar events in a bounded date scope or the next event. All-day dates are civil dates; timed events have explicit ISO instants.',
      inputSchema: calendarReadInputSchema, outputSchema: calendarResultSchema,
      handler: (input, context, operationId) => port.execute({ operation: 'read', input }, context, operationId),
    }),
    defineTool({
      name: 'calendar_create', effect: 'write', requiredCapability: 'calendar.create',
      description: 'Create a timed or all-day event in the authenticated user calendar. Timed intervals require explicit start/end ISO instants; all-day end date is exclusive. Optional WhatsApp reminder is a separate effect.',
      inputSchema: calendarCreateInputSchema, outputSchema: calendarResultSchema,
      handler: (input, context, operationId) => port.execute({ operation: 'create', input }, context, operationId),
    }),
    defineTool({
      name: 'calendar_connect', effect: 'read', requiredCapability: 'calendar.connect',
      description: 'Check the authenticated user Google Calendar connection or return its authorization link. The user completes authorization themselves.',
      inputSchema: calendarConnectInputSchema, outputSchema: calendarResultSchema,
      handler: (input, context, operationId) => port.execute({ operation: 'connect', input }, context, operationId),
    }),
  ] as const;
}

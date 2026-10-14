import type { CalendarRequest, TurnContext } from '@templelabs/contracts';
import { definedFields, domainInput, domainResult, type ProductivityService, type ProductivityUser } from '../productivity-domain.js';
import { executeCalendarTool } from './operations/calendar.js';

export type CalendarServiceHandler = (...args: Parameters<typeof executeCalendarTool>) => Promise<unknown>;
export function calendarParameters(request: CalendarRequest) {
  switch (request.operation) {
    case 'connect': return { action: 'get_connect_link' };
    case 'read': {
      const scope = request.input.scope;
      const isDate = scope && /^\d{4}-\d{2}-\d{2}$/.test(scope);
      return definedFields({ action: scope === 'next_event' ? 'next_event' : 'list_events', scope: isDate ? 'explicit_date' : scope,
        date: isDate ? scope : undefined, query: request.input.query });
    }
    case 'delete': return { action: 'delete_event', target: request.input.eventId, lookupDate: request.input.lookupDate };
    case 'update': {
      const { eventId, lookupDate, startIso, endIso, startDate, endDateExclusive, description, ...changes } = request.input;
      return definedFields({ action: 'update_event', target: eventId, lookupDate, ...changes,
        ...(description !== undefined ? { description: description ?? '' } : {}), startDateTime: startIso, endDateTime: endIso,
        startDate, endDate: endDateExclusive, ...(startDate !== undefined || endDateExclusive !== undefined ? { allDay: true } : {}) });
    }
    case 'create': {
      const input = request.input;
      const common = { action: 'create_event', summary: input.summary, description: input.description, recurrence: input.recurrence };
      return input.kind === 'all_day' ? definedFields({ ...common, allDay: true, startDate: input.startDate, endDate: input.endDateExclusive })
        : definedFields({ ...common, allDay: false, startDateTime: input.startIso, endDateTime: input.endIso,
          addGoogleMeet: input.addGoogleMeet, advanceMinutes: input.advanceMinutes });
    }
  }
}
export function createCalendarService(authenticatedUser: ProductivityUser, execute: CalendarServiceHandler = executeCalendarTool): ProductivityService<CalendarRequest> {
  const user = { ...authenticatedUser };
  return { async execute(request: CalendarRequest, context: TurnContext) {
    const input = await domainInput(user, context);
    const params = calendarParameters(request);
    return domainResult(await execute({ ...input, action: params.action, params }));
  } };
}

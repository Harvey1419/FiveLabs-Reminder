import {
  calendarResultSchema, type CalendarEvent, type CalendarRequest, type CalendarResult,
  type JsonObject,
} from '@templelabs/contracts';
import type { CalendarDomainPort, ToolOutcome } from '@templelabs/tools';
import type { LegacyToolUser } from '../../agent/tools/index.js';
import {
  checkLegacyContext, definedJson, failedOutcome, legacyDomainInvoker, legacyEnvelopeSchema,
  nullableString, objectSchema, presentation, type LegacyExecutor,
} from './legacy-domain.js';

function params(request: CalendarRequest): JsonObject {
  switch (request.operation) {
    case 'connect': return { action: 'get_connect_link' };
    case 'read': {
      const scope = request.input.scope;
      const isDate = scope && /^\d{4}-\d{2}-\d{2}$/.test(scope);
      return definedJson({ action: scope === 'next_event' ? 'next_event' : 'list_events',
        scope: isDate ? 'explicit_date' : scope, date: isDate ? scope : undefined, query: request.input.query });
    }
    case 'create': {
      const input = request.input;
      const common = { action: 'create_event', summary: input.summary, description: input.description, recurrence: input.recurrence };
      return input.kind === 'all_day'
        ? definedJson({ ...common, allDay: true, startDate: input.startDate, endDate: input.endDateExclusive })
        : definedJson({ ...common, allDay: false, startDateTime: input.startIso, endDateTime: input.endIso,
          addGoogleMeet: input.addGoogleMeet, advanceMinutes: input.advanceMinutes });
    }
  }
}
function normalizeEvent(value: unknown): CalendarEvent {
  const event = objectSchema.parse(value);
  const common = { id: nullableString(event.id) ?? '', summary: nullableString(event.summary) ?? '' };
  if (event.isAllDay === true || event.type === 'all_day') {
    return { ...common, kind: 'all_day', startDate: nullableString(event.localDate ?? event.start) ?? '',
      endDateExclusive: nullableString(event.endDateExclusive ?? event.end) };
  }
  return { ...common, kind: 'timed', startIso: nullableString(event.startIso ?? event.start) ?? '',
    endIso: nullableString(event.endIso ?? event.end), meetLink: nullableString(event.meetLink) };
}

export function createLegacyCalendarPort(user: LegacyToolUser, execute?: LegacyExecutor): CalendarDomainPort {
  const userId = user.id;
  const invoke = legacyDomainInvoker(user, execute);
  return {
    async execute(request, context, operationId): Promise<ToolOutcome<CalendarResult>> {
      const invalid = checkLegacyContext(userId, context);
      if (invalid) return invalid;
      const raw = legacyEnvelopeSchema.parse(await invoke('manage_google_calendar', params(request), context));
      const expected = request.operation === 'create' ? ['google_event_created']
        : request.operation === 'read' ? ['google_events_listed'] : ['already_connected', 'google_auth_link_generated'];
      if (raw.success && !expected.includes(raw.action)) throw new Error('Unexpected calendar action');
      const hasEffects = raw.success || raw.partialSuccess === true;
      const detail = !Array.isArray(raw.data) && raw.data != null ? objectSchema.parse(raw.data) : {};
      let rows: unknown[] = [];
      if (hasEffects && request.operation === 'create') rows = [raw.data];
      if (hasEffects && request.operation === 'read') {
        if (Array.isArray(raw.data)) rows = raw.data;
        else if (Array.isArray(detail.events)) rows = detail.events;
        else throw new Error('Missing calendar list evidence');
      }
      const events = rows.slice(0, 50).map(normalizeEvent);
      const companionRequested = request.operation === 'create' && request.input.kind === 'timed'
        && request.input.advanceMinutes !== undefined;
      const companion = !companionRequested ? 'not_requested' : detail.reminderCreated === true ? 'confirmed' : 'unconfirmed';
      const complete = raw.success && raw.complete !== false && !raw.partialSuccess && companion !== 'unconfirmed';
      const issues = hasEffects && companion === 'unconfirmed'
        ? [{ code: 'COMPANION_OUTCOME_UNVERIFIED', reason: 'The event was created; its requested WhatsApp reminder was not confirmed.' }] : [];
      const data = calendarResultSchema.parse({
        operation: request.operation, events, complete,
        coverage: request.operation === 'read' ? 'bounded_list' : 'operation',
        connection: raw.action === 'already_connected' ? 'connected'
          : raw.errorCode === 'AUTH_REQUIRED' || raw.action === 'google_auth_link_generated' ? 'authorization_required' : null,
        companion, issues, presentation: presentation(raw),
      });
      if (raw.action === 'google_auth_link_generated' && !data.presentation.cta) throw new Error('Missing authorization link');
      const observation = JSON.stringify({ operation: data.operation, complete, coverage: data.coverage,
        returnedCount: events.length, events: events.slice(0, 5), connection: data.connection, companion, issues });
      if (!hasEffects) return failedOutcome(raw, data, observation, request.operation === 'create' ? 'write' : 'read', operationId);
      return { status: complete ? 'success' : 'partial', data, observation,
        receipt: { userId: context.userId, operationId, toolName: `calendar_${request.operation}`, resourceIds: events.map(event => event.id) } };
    },
  };
}

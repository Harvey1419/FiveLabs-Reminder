import {
  calendarResultSchema, type CalendarEvent, type CalendarRequest, type CalendarResult,
} from '@templelabs/contracts';
import type { CalendarDomainPort, ToolOutcome } from '@templelabs/tools';
import { createCalendarService } from '../../features/calendar/productivity-service.js';
import type { ProductivityService, ProductivityUser } from '../../features/productivity-domain.js';
import {
  checkDomainContext, failedOutcome, domainEnvelopeSchema,
  nullableString, objectSchema, presentation,
} from './domain-outcome.js';

function normalizeEvent(value: unknown): CalendarEvent {
  const event = objectSchema.parse(value);
  const common = { id: nullableString(event.id) ?? '', summary: nullableString(event.summary) ?? '' };
  if (event.isAllDay === true || event.type === 'all_day' || event.kind === 'all_day') {
    return { ...common, kind: 'all_day', startDate: nullableString(event.startDate ?? event.localDate ?? event.start) ?? '',
      endDateExclusive: nullableString(event.endDateExclusive ?? event.end) };
  }
  return { ...common, kind: 'timed', startIso: nullableString(event.startIso ?? event.start) ?? '',
    endIso: nullableString(event.endIso ?? event.end), meetLink: nullableString(event.meetLink) };
}

export function createCalendarDomainPort(user: ProductivityUser, service: ProductivityService<CalendarRequest> = createCalendarService(user)): CalendarDomainPort {
  const userId = user.id;
  return {
    async execute(request, context, operationId): Promise<ToolOutcome<CalendarResult>> {
      const invalid = checkDomainContext(userId, context);
      if (invalid) return invalid;
      let ownedTarget: CalendarEvent | undefined;
      if (request.operation === 'update' || request.operation === 'delete') {
        const read = domainEnvelopeSchema.parse(await service.execute({ operation: 'read', input: { scope: request.input.lookupDate } }, context));
        if (!read.success || read.action !== 'google_events_listed') return { status: 'failed', code: 'REFERENCE_UNAVAILABLE', observation: 'The event could not be verified in the authenticated calendar; no mutation was attempted.' };
        const data = Array.isArray(read.data) ? read.data : objectSchema.parse(read.data).events;
        if (!Array.isArray(data)) throw new Error('Missing owner-bound calendar read');
        ownedTarget = data.map(normalizeEvent).find(event => event.id === request.input.eventId);
        if (!ownedTarget) return { status: 'failed', code: 'NOT_FOUND', observation: 'The event is absent from the authenticated date scope; no mutation was attempted.' };
      }
      const raw = domainEnvelopeSchema.parse(await service.execute(request, context));
      const expected = request.operation === 'create' ? ['google_event_created']
        : request.operation === 'read' ? ['google_events_listed'] : request.operation === 'update' ? ['google_event_updated']
          : request.operation === 'delete' ? ['google_event_deleted'] : ['already_connected', 'google_auth_link_generated'];
      if (raw.success && !expected.includes(raw.action)) throw new Error('Unexpected calendar action');
      const hasEffects = raw.success || raw.partialSuccess === true;
      const detail = !Array.isArray(raw.data) && raw.data != null ? objectSchema.parse(raw.data) : {};
      let rows: unknown[] = [];
      if (hasEffects && (request.operation === 'create' || request.operation === 'update')) rows = [raw.data];
      if (hasEffects && request.operation === 'read') {
        if (Array.isArray(raw.data)) rows = raw.data;
        else if (Array.isArray(detail.events)) rows = detail.events;
        else throw new Error('Missing calendar list evidence');
      }
      if (hasEffects && request.operation === 'delete') {
        if (detail.eventId !== request.input.eventId || detail.deleted !== true || !ownedTarget) throw new Error('Missing calendar deletion receipt');
        rows = [ownedTarget];
      }
      const events = rows.slice(0, 50).map(normalizeEvent);
      if (hasEffects && request.operation === 'update' && (events.length !== 1 || events[0]?.id !== request.input.eventId)) throw new Error('Calendar target identity mismatch');
      const companionRequested = request.operation === 'create' && request.input.kind === 'timed'
        && request.input.advanceMinutes !== undefined;
      const cleanupUnverified = hasEffects && (raw.partialSuccess === true || detail.companionRescheduleFailed === true);
      const companion = cleanupUnverified ? 'unconfirmed' : !companionRequested ? 'not_requested' : detail.reminderCreated === true ? 'confirmed' : 'unconfirmed';
      const complete = raw.success && raw.complete !== false && !raw.partialSuccess && companion !== 'unconfirmed';
      const issues = hasEffects && companion === 'unconfirmed'
        ? [{ code: 'COMPANION_OUTCOME_UNVERIFIED', reason: 'The principal calendar change is confirmed; its linked WhatsApp reminder outcome was not confirmed.' }] : [];
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
      if (!hasEffects) return failedOutcome(raw, data, observation, request.operation === 'read' || request.operation === 'connect' ? 'read' : 'write', operationId);
      return { status: complete ? 'success' : 'partial', data, observation,
        receipt: { userId: context.userId, operationId, toolName: `calendar_${request.operation}`, resourceIds: events.map(event => event.id) } };
    },
  };
}

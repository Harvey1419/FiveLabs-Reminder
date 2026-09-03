import {
  getUserIntegration,
  saveReminder,
} from '../../db/index.js';
import {
  getGoogleConnectUrl,
  revokeGoogleIntegration,
} from '../../services/googleAuth.js';
import {
  listCalendarEvents,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
} from '../../services/googleCalendar.js';
import {
  parseTargetTime,
  getDayBounds,
  resolveCalendarTemporalScope,
  formatLocalDateTime,
  zonedTimeToUtc,
  DEFAULT_TIMEZONE,
} from '../../utils/time.js';
import { resolveEntityReference } from '../workingMemory.js';

/**
 * Normalizes raw Google Calendar event into explicit civil or timed representation.
 * Guarantees All-Day events remain civil dates without UTC timezone shift.
 */
export function normalizeCalendarEvent(ev, timezone = DEFAULT_TIMEZONE) {
  const rawStartDate = ev.rawStartDate || (typeof ev.start === 'object' ? ev.start?.date : null) || (typeof ev.start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ev.start) ? ev.start : null);
  const rawStartDateTime = ev.rawStartDateTime || (typeof ev.start === 'object' ? ev.start?.dateTime : null) || (typeof ev.start === 'string' && ev.start.includes('T') ? ev.start : null);
  const isAllDay = Boolean(ev.isAllDay || (rawStartDate && !rawStartDateTime));

  if (isAllDay && rawStartDate) {
    const match = rawStartDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
    const y = match ? match[1] : '2026';
    const m = match ? match[2] : '01';
    const d = match ? match[3] : '01';
    const sortTimestamp = zonedTimeToUtc(parseInt(y, 10), parseInt(m, 10), parseInt(d, 10), 0, 0, 0, timezone).getTime();
    return {
      id: ev.id,
      summary: ev.summary || '(Sin título)',
      description: ev.description || '',
      location: ev.location || null,
      meetLink: ev.hangoutLink || ev.meetLink || null,
      type: 'all_day',
      localDate: `${y}-${m}-${d}`,
      formattedDate: `${d}/${m}/${y}`,
      displayDate: `${d}/${m}/${y} (Todo el día)`,
      sortTimestamp,
      status: ev.status || 'confirmed',
    };
  }

  const startIso = rawStartDateTime || (typeof ev.start === 'string' ? ev.start : (rawStartDate ? `${rawStartDate}T00:00:00Z` : new Date().toISOString()));
  const sortTimestamp = new Date(startIso).getTime();
  const dateStr = formatLocalDateTime(new Date(startIso), timezone, 'es-CO');
  return {
    id: ev.id,
    summary: ev.summary || '(Sin título)',
    description: ev.description || '',
    location: ev.location || null,
    meetLink: ev.hangoutLink || ev.meetLink || null,
    type: 'timed',
    startIso,
    endIso: typeof ev.end === 'object' ? (ev.end?.dateTime || ev.end?.date) : ev.end,
    localStartTime: dateStr,
    displayDate: dateStr,
    sortTimestamp,
    status: ev.status || 'confirmed',
  };
}

/**
 * Formats a normalized calendar event line for WhatsApp presentation.
 */
export function formatCalendarEventLine(ev, timezone = DEFAULT_TIMEZONE, language = 'es') {
  if (ev.type === 'all_day') {
    const [y, m, d] = ev.localDate.split('-');
    const dateText = `${d}/${m}/${y} (${language === 'en' ? 'All day' : 'Todo el día'})`;
    return `• 📅 *${ev.summary}* — ${dateText}`;
  }

  const meet = ev.meetLink ? ` (Google Meet: ${ev.meetLink})` : '';
  return `• 📅 *${ev.summary}* — ${ev.displayDate}${meet}`;
}

/**
 * Domain tool for managing Google Calendar synchronization (Architecture V3).
 */
export async function executeCalendarTool({ action, params = {}, user, language = 'es' }) {
  const userId = user?.id;
  const phoneNumber = user?.phone_number;
  const tz = user?.timezone || DEFAULT_TIMEZONE;
  const integration = await getUserIntegration(userId, 'google');
  const isConnected = Boolean(integration && (integration.access_token || integration.refresh_token));

  switch (action) {
    case 'get_connect_link':
    case 'connect': {
      if (isConnected) {
        const email = integration.account_email ? ` (${integration.account_email})` : '';
        const summary = `Tu Google Calendar ya está conectado${email}. Si deseas desconectarlo o cambiar de cuenta, solo dímelo.`;
        return {
          success: true,
          action: 'already_connected',
          data: { email: integration.account_email },
          rawSummary: summary,
          formattedCard: summary,
        };
      }

      const authUrl = getGoogleConnectUrl({ userId, phoneNumber });
      const summary = `👉 Para conectar tu Google Calendar con Reminder, entra a este enlace seguro: ${authUrl}`;
      return {
        success: true,
        action: 'google_auth_link_generated',
        data: { auth_url: authUrl, authUrl },
        ctaUrl: authUrl,
        ctaHeader: '📅 Google Calendar',
        ctaButtonText: language === 'en' ? '🔗 Connect Google' : '🔗 Conectar Google',
        rawSummary: summary,
        formattedCard: summary,
      };
    }

    case 'disconnect': {
      if (!integration) {
        return {
          success: false,
          action: 'not_connected',
          errorCode: 'NOT_CONNECTED',
          error: 'No tienes ninguna cuenta de Google Calendar vinculada en este momento.',
          rawSummary: 'No tienes ninguna cuenta de Google Calendar vinculada en este momento.',
        };
      }

      await revokeGoogleIntegration(userId);
      const summary = 'Tu cuenta de Google Calendar ha sido desvinculada exitosamente.';
      return {
        success: true,
        action: 'google_disconnected',
        data: {},
        rawSummary: summary,
        formattedCard: summary,
      };
    }

    case 'list_events':
    case 'search_events':
    case 'next_event': {
      // 1. STATE DISCONNECTED: Guard before calling Google API
      if (!isConnected) {
        const authUrl = getGoogleConnectUrl({ userId, phoneNumber });
        const summary = language === 'en'
          ? `To access your Google Calendar, please connect your account first: ${authUrl}`
          : `Para consultar tu Google Calendar, primero debes vincular tu cuenta: ${authUrl}`;
        return {
          success: false,
          action: 'google_not_connected',
          errorCode: 'AUTH_REQUIRED',
          data: { auth_url: authUrl, authUrl },
          ctaUrl: authUrl,
          error: summary,
          rawSummary: summary,
          formattedCard: summary,
        };
      }

      const queryParam = params.query || params.q || params.semanticFilter || null;
      const effectiveScope = action === 'next_event' ? 'next_event' : (params.scope || 'default_upcoming');
      const resolved = resolveCalendarTemporalScope({ ...params, scope: effectiveScope }, tz);

      let rawEvents;
      try {
        rawEvents = await listCalendarEvents(userId, {
          timeMin: resolved.timeMin,
          timeMax: resolved.timeMax,
          timezone: tz,
          maxResults: resolved.maxResults,
          q: queryParam,
        });
      } catch (err) {
        // 2. STATE ERROR / UNAVAILABLE: Distinct error reporting
        console.error(`[calendarTools] Google API error for user ${userId}:`, err.message);
        const errorMsg = language === 'en'
          ? 'I could not access your Google Calendar at this moment due to a service error.'
          : 'No pude consultar tu Google Calendar en este momento debido a una intermitencia con el servicio de Google.';
        return {
          success: false,
          action: 'google_api_error',
          errorCode: 'SERVICE_UNAVAILABLE',
          error: errorMsg,
          rawSummary: errorMsg,
          formattedCard: `⚠️ ${errorMsg}`,
        };
      }

      // Normalize all events ensuring civil all-day date integrity
      const events = (rawEvents || []).map(ev => normalizeCalendarEvent(ev, tz));

      // 3. STATE CONNECTED with 0 events
      if (events.length === 0) {
        let summary = '';
        if (resolved.isNextEvent) {
          summary = language === 'en'
            ? 'You have no upcoming events scheduled in your Google Calendar.'
            : 'No tienes eventos próximos programados en tu Google Calendar.';
        } else {
          summary = language === 'en'
            ? 'You have no events scheduled in Google Calendar for this period.'
            : 'No tienes eventos programados en Google Calendar para este período.';
        }
        return {
          success: true,
          action: 'google_events_listed',
          data: [],
          rawSummary: summary,
          formattedCard: summary,
        };
      }

      // Handle next_event: strictly sort by civil/timed sortTimestamp ascending
      if (resolved.isNextEvent) {
        events.sort((a, b) => a.sortTimestamp - b.sortTimestamp);
        const ev = events[0];
        const eventText = formatCalendarEventLine(ev, tz, language);
        const header = language === 'en'
          ? 'Your next event in Google Calendar is:'
          : 'Tu próximo evento en Google Calendar es:';
        const summary = `${header}\n${eventText}`;
        const structuredItem = {
          position: 1,
          type: 'calendar_event',
          internalId: ev.id,
          summary: ev.summary,
          time: ev.localStartTime || (ev.isAllDay ? (language === 'en' ? 'All day' : 'Todo el día') : null),
          source: 'calendar',
          raw: ev,
        };
        return {
          success: true,
          action: 'google_events_listed',
          data: { events: [ev], items: [structuredItem] },
          rawSummary: summary,
          formattedCard: summary,
        };
      }

      // List of events formatted with civil all-day preservation
      const eventsFormatted = events.map(e => formatCalendarEventLine(e, tz, language)).join('\n');
      const header = language === 'en'
        ? 'Events in your Google Calendar:'
        : 'Eventos en tu Google Calendar:';
      const summary = `${header}\n${eventsFormatted}`;

      const structuredItems = events.map((e, idx) => ({
        position: idx + 1,
        type: 'calendar_event',
        internalId: e.id,
        summary: e.summary,
        time: e.localStartTime || (e.isAllDay ? (language === 'en' ? 'All day' : 'Todo el día') : null),
        source: 'calendar',
        raw: e,
      }));

      return {
        success: true,
        action: 'google_events_listed',
        data: { events, items: structuredItems },
        rawSummary: summary,
        formattedCard: summary,
      };
    }

    case 'create_event': {
      if (!isConnected) {
        const authUrl = getGoogleConnectUrl({ userId, phoneNumber });
        const summary = `Para agendar directamente en Google Calendar, primero debes conectar tu cuenta: ${authUrl}`;
        return {
          success: false,
          action: 'google_not_connected',
          errorCode: 'AUTH_REQUIRED',
          data: { auth_url: authUrl, authUrl },
          ctaUrl: authUrl,
          error: summary,
          rawSummary: summary,
          formattedCard: summary,
        };
      }

      const startDateTime = parseTargetTime(params.startDateTime || params.targetTime || '+1h', tz);
      const endDateTime = params.endDateTime
        ? parseTargetTime(params.endDateTime, tz)
        : new Date(startDateTime.getTime() + (params.durationMinutes || 60) * 60 * 1000);

      let event;
      try {
        event = await createCalendarEvent(userId, {
          summary: params.summary || params.content || 'Reunión',
          description: params.description || '',
          startDateTime,
          endDateTime,
          timezone: tz,
          addGoogleMeet: Boolean(params.addGoogleMeet),
        });
      } catch (err) {
        console.error(`[calendarTools] Failed to create Google event for user ${userId}:`, err.message);
        const errorMsg = 'No pude crear el evento en tu Google Calendar debido a una intermitencia con Google.';
        return {
          success: false,
          action: 'google_api_error',
          errorCode: 'SERVICE_UNAVAILABLE',
          error: errorMsg,
          rawSummary: errorMsg,
          formattedCard: `⚠️ ${errorMsg}`,
        };
      }

      // Determine advance notice minutes:
      // 1. Explicit parameter from user / LLM
      // 2. User preference in memory (e.g. "avísame 15 minutos antes")
      // 3. Default: at the event time (0 minutes)
      let advanceMinutes = params.advanceMinutes !== undefined && params.advanceMinutes !== null
        ? Number(params.advanceMinutes)
        : null;

      if (advanceMinutes === null) {
        const memories = user?.memories || [];
        const prefText = memories.map(m => m.content || '').join(' ');
        const match = prefText.match(/(\d+)\s*(minutos?|mins?)\s*antes/i);
        if (match) {
          advanceMinutes = parseInt(match[1], 10);
        } else {
          advanceMinutes = 0;
        }
      }

      let reminderCreated = false;
      let reminderSendAt = null;

      if (advanceMinutes > 0) {
        reminderSendAt = new Date(startDateTime.getTime() - Number(advanceMinutes) * 60 * 1000).toISOString();
      } else {
        reminderSendAt = startDateTime.toISOString();
      }

      if (new Date(reminderSendAt).getTime() > Date.now()) {
        const advContent = advanceMinutes > 0
          ? `🔔 [Aviso Previo] ${event.summary} en ${advanceMinutes} minutos`
          : `🔔 ${event.summary}`;
        try {
          const inserted = await saveReminder({
            userId,
            phoneNumber,
            content: advContent,
            sendAt: reminderSendAt,
            requiresConfirmation: true,
          });
          if (inserted) reminderCreated = true;
        } catch (remErr) {
          console.warn('[calendarTools] Failed to save linked reminder:', remErr.message);
        }
      }

      const meetNotice = event.meetLink ? `\n📹 *Google Meet:* ${event.meetLink}` : '';
      const formattedStartDate = formatLocalDateTime(startDateTime, tz, 'es-CO');
      let summary = `📅 *Evento agendado en Google Calendar*\n• *${event.summary}* — ${formattedStartDate}${meetNotice}`;

      if (reminderCreated) {
        if (advanceMinutes > 0) {
          summary += `\n\n🔔 *Recordatorio programado en WhatsApp*\n• ${advanceMinutes} minutos antes (${formatLocalDateTime(new Date(reminderSendAt), tz, 'es-CO')})`;
        } else {
          summary += `\n\n🔔 *Recordatorio programado en WhatsApp*\n• A la misma hora (${formatLocalDateTime(startDateTime, tz, 'es-CO')})`;
        }
      }

      return {
        success: true,
        action: 'google_event_created',
        data: {
          ...event,
          reminderCreated,
          advanceMinutes,
          reminderSendAt,
        },
        rawSummary: summary,
        formattedCard: summary,
      };
    }

    case 'update_event': {
      if (!isConnected) {
        const authUrl = getGoogleConnectUrl({ userId, phoneNumber });
        return {
          success: false,
          action: 'google_not_connected',
          errorCode: 'AUTH_REQUIRED',
          data: { auth_url: authUrl, authUrl },
          ctaUrl: authUrl,
          error: 'Debes conectar tu Google Calendar para actualizar eventos.',
        };
      }

      let eventId = params.eventId || params.id;
      if (!eventId || String(eventId).length < 8) {
        const refRes = resolveEntityReference({
          userOrPhone: user || phoneNumber,
          reference: eventId || params.target || params.summary || params.query || '',
          preferredType: 'calendar_event',
        });
        if (refRes.status === 'RESOLVED') {
          eventId = refRes.item.internalId;
        } else if (refRes.status === 'AMBIGUOUS') {
          return {
            success: false,
            action: 'ambiguous_target',
            errorCode: 'AMBIGUOUS_TARGET',
            error: language === 'en'
              ? 'Multiple calendar events match. Please clarify which one you want to update.'
              : 'Hay múltiples eventos de calendario que coinciden. Por favor aclara cuál deseas actualizar.',
            rawSummary: 'Hay múltiples eventos que coinciden. Por favor aclara cuál deseas actualizar.',
            confirmation: 'Hay múltiples eventos que coinciden. Por favor aclara cuál deseas actualizar.',
          };
        }
      }

      if (!eventId) {
        return {
          success: false,
          action: 'missing_event_id',
          errorCode: 'MISSING_TARGET_ID',
          error: 'Falta el ID del evento a actualizar en Google Calendar.',
        };
      }

      const startDateTime = params.startDateTime ? parseTargetTime(params.startDateTime, tz) : undefined;
      const endDateTime = params.endDateTime ? parseTargetTime(params.endDateTime, tz) : undefined;

      try {
        const updated = await updateCalendarEvent(userId, {
          eventId,
          summary: params.summary,
          description: params.description,
          startDateTime,
          endDateTime,
          timezone: tz,
        });

        const summary = `Evento actualizado en Google Calendar: *${updated.summary}*.`;
        return {
          success: true,
          action: 'google_event_updated',
          data: updated,
          rawSummary: summary,
          formattedCard: summary,
        };
      } catch (err) {
        return {
          success: false,
          action: 'google_api_error',
          errorCode: 'SERVICE_UNAVAILABLE',
          error: 'No se pudo actualizar el evento en Google Calendar.',
        };
      }
    }

    case 'delete_event': {
      if (!isConnected) {
        const authUrl = getGoogleConnectUrl({ userId, phoneNumber });
        return {
          success: false,
          action: 'google_not_connected',
          errorCode: 'AUTH_REQUIRED',
          data: { auth_url: authUrl, authUrl },
          ctaUrl: authUrl,
          error: 'Debes conectar tu Google Calendar para eliminar eventos.',
        };
      }

      let eventId = params.eventId || params.id;
      if (!eventId || String(eventId).length < 8) {
        const refRes = resolveEntityReference({
          userOrPhone: user || phoneNumber,
          reference: eventId || params.target || params.summary || params.query || '',
          preferredType: 'calendar_event',
        });
        if (refRes.status === 'RESOLVED') {
          eventId = refRes.item.internalId;
        } else if (refRes.status === 'AMBIGUOUS') {
          return {
            success: false,
            action: 'ambiguous_target',
            errorCode: 'AMBIGUOUS_TARGET',
            error: language === 'en'
              ? 'Multiple calendar events match. Please clarify which one you want to delete.'
              : 'Hay múltiples eventos de calendario que coinciden. Por favor aclara cuál deseas eliminar.',
            rawSummary: 'Hay múltiples eventos que coinciden. Por favor aclara cuál deseas eliminar.',
            confirmation: 'Hay múltiples eventos que coinciden. Por favor aclara cuál deseas eliminar.',
          };
        }
      }

      if (!eventId) {
        return {
          success: false,
          action: 'missing_event_id',
          errorCode: 'MISSING_TARGET_ID',
          error: 'Falta el ID del evento a eliminar en Google Calendar.',
        };
      }

      const deleted = await deleteCalendarEvent(userId, eventId);
      const summary = deleted
        ? (language === 'en' ? 'Event deleted from your Google Calendar.' : 'Evento eliminado de tu Google Calendar.')
        : (language === 'en' ? 'Could not delete event from Google Calendar.' : 'No se pudo eliminar el evento de Google Calendar.');
      return {
        success: deleted,
        action: deleted ? 'google_event_deleted' : 'google_api_error',
        data: { eventId, deleted },
        rawSummary: summary,
        formattedCard: summary,
      };
    }

    default:
      return {
        success: false,
        action: 'unsupported_action',
        errorCode: 'UNSUPPORTED_ACTION',
        error: `Acción '${action}' no soportada para manage_google_calendar.`,
        rawSummary: `Acción '${action}' no soportada para manage_google_calendar.`,
      };
  }
}

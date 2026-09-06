import {
  getUserIntegration,
  saveReminder,
} from '../../infrastructure/database/index.js';
import {
  getGoogleConnectUrl,
  revokeGoogleIntegration,
  hasUsableGoogleCredentials,
  isGoogleAuthError,
} from '../../integrations/google/auth.js';
import {
  listCalendarEvents,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
} from '../../integrations/google/calendar.js';
import {
  parseTargetTime,
  getDayBounds,
  resolveCalendarTemporalScope,
  formatLocalDateTime,
  formatHumanFriendlyDateTime,
  zonedTimeToUtc,
  DEFAULT_TIMEZONE,
} from '../../shared/time.js';
import { resolveEntityReference } from '../core/working-memory.js';

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
  const dateStr = formatHumanFriendlyDateTime(new Date(startIso), timezone, 'es');
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
export async function executeCalendarTool({ action, params = {}, user, language = 'es', referenceTime = null }) {
  const userId = user?.id;
  const phoneNumber = user?.phone_number;
  const tz = user?.timezone || DEFAULT_TIMEZONE;
  const integration = await getUserIntegration(userId, 'google');
  const isConnected = hasUsableGoogleCredentials(integration);

  const buildGoogleReauthSummary = (lang) => {
    const authUrl = getGoogleConnectUrl({ userId, phoneNumber });
    const summary = lang === 'en'
      ? `Your Google Calendar connection needs re-authentication. Reconnect here: ${authUrl}`
      : `Tu conexión con Google Calendar necesita reconexión. Entra aquí para validarla: ${authUrl}`;
    return {
      summary,
      ctaUrl: authUrl,
      authUrl,
      action: 'google_not_connected',
      errorCode: 'AUTH_REQUIRED',
    };
  };

  switch (action) {
    case 'get_connect_link':
    case 'connect': {
      if (isConnected) {
        try {
          // Token presence is not proof of a live connection: revoked refresh
          // tokens remain persisted until Google is contacted. An explicit
          // connect request is rare and is the right moment for a live probe.
          await listCalendarEvents(userId, { timezone: tz, maxResults: 1 });
          const email = integration.account_email ? ` (${integration.account_email})` : '';
          const summary = language === 'en'
            ? `Your Google Calendar is already connected${email}. Tell me if you want to disconnect it or switch accounts.`
            : `Tu Google Calendar ya está conectado${email}. Si deseas desconectarlo o cambiar de cuenta, solo dímelo.`;
          return {
            success: true,
            action: 'already_connected',
            data: { email: integration.account_email },
            rawSummary: summary,
            formattedCard: summary,
          };
        } catch (err) {
          if (!isGoogleAuthError(err)) {
            const summary = language === 'en'
              ? 'I could not verify your Google Calendar connection right now because Google is temporarily unavailable.'
              : 'No pude verificar tu conexión con Google Calendar en este momento por una intermitencia de Google.';
            return {
              success: false,
              action: 'google_api_error',
              errorCode: 'SERVICE_UNAVAILABLE',
              error: summary,
              rawSummary: summary,
              formattedCard: `⚠️ ${summary}`,
            };
          }
          // The Calendar integration removes invalid credentials. Continue
          // below and issue the correct reconnection URL in this same turn.
        }
      }

      const authUrl = getGoogleConnectUrl({ userId, phoneNumber });
      const summary = `👉 Para conectar tu Google Calendar con Reminder, entra a este enlace seguro: ${authUrl}`;
      return {
        success: true,
        action: 'google_auth_link_generated',
        data: { auth_url: authUrl, authUrl },
        ctaUrl: authUrl,
        ctaHeader: '📅 Google Calendar',
        ctaButtonText: language === 'en' ? 'Connect' : 'Conectar',
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

        if (isGoogleAuthError(err)) {
          const reconnect = buildGoogleReauthSummary(language);
          return {
            success: false,
            action: reconnect.action,
            errorCode: reconnect.errorCode,
            data: { auth_url: reconnect.authUrl, authUrl: reconnect.authUrl },
            ctaUrl: reconnect.ctaUrl,
            error: reconnect.summary,
            rawSummary: reconnect.summary,
            formattedCard: `⚠️ ${reconnect.summary}`,
          };
        }

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

      if (!params.summary || !params.startDateTime) {
        const missing = !params.summary
          ? (language === 'en' ? 'What should the event be called?' : '¿Cómo se llama el evento?')
          : (language === 'en' ? 'What date and time should I use for the event?' : '¿Para qué fecha y hora quieres el evento?');
        return {
          success: false,
          action: 'missing_required_context',
          errorCode: 'MISSING_REQUIRED_CONTEXT',
          error: missing,
          rawSummary: missing,
          confirmation: missing,
        };
      }

      const startDateTime = parseTargetTime(params.startDateTime, tz, referenceTime);
      const endDateTime = params.endDateTime
        ? parseTargetTime(params.endDateTime, tz, referenceTime)
        : new Date(startDateTime.getTime() + (params.durationMinutes || 60) * 60 * 1000);

      let event;
      try {
        event = await createCalendarEvent(userId, {
          summary: params.summary,
          description: params.description || '',
          startDateTime,
          endDateTime,
          timezone: tz,
          addGoogleMeet: Boolean(params.addGoogleMeet),
        });
      } catch (err) {
        console.error(`[calendarTools] Failed to create Google event for user ${userId}:`, err.message);
        if (isGoogleAuthError(err)) {
          const reconnect = buildGoogleReauthSummary(language);
          return {
            success: false,
            action: reconnect.action,
            errorCode: reconnect.errorCode,
            data: { auth_url: reconnect.authUrl, authUrl: reconnect.authUrl },
            ctaUrl: reconnect.ctaUrl,
            error: reconnect.summary,
            rawSummary: reconnect.summary,
            formattedCard: `⚠️ ${reconnect.summary}`,
          };
        }
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

      const meetNotice = event.meetLink ? `\n• 📹 *Google Meet:* ${event.meetLink}` : '';
      const formattedStartDate = formatHumanFriendlyDateTime(startDateTime, tz, language);
      let summary = `📅 *Evento agendado en Google Calendar*\n\n• 🏢 *${event.summary}*\n• 📅 ${formattedStartDate}${meetNotice}`;

      if (reminderCreated) {
        if (advanceMinutes > 0) {
          summary += `\n\n🔔 *Recordatorio programado en WhatsApp*\n• ${advanceMinutes} minutos antes (${formatHumanFriendlyDateTime(new Date(reminderSendAt), tz, language)})`;
        } else {
          summary += `\n\n🔔 *Recordatorio programado en WhatsApp*\n• A la misma hora (${formatHumanFriendlyDateTime(startDateTime, tz, language)})`;
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
      const hasExplicitScope = Boolean(params.date || params.startDateTime || params.scope);

      if (!eventId || String(eventId).length < 8) {
        let domainCandidates = null;
        const targetRef = String(eventId || params.target || params.summary || params.query || '').trim();

        // If target is a search query (not an ordinal position "1", "primero"), retrieve domain candidates from Google Calendar
        const isOrdinal = /^(#?\d+|el\s+\d+|primero|primera|segundo|segunda|tercero|tercera|cuarto|cuarta|quinto|quinta|el\s+primero|la\s+primera|el\s+segundo|la\s+segunda|el\s+mas\s+temprano|el\s+más\s+temprano|el\s+ultimo|el\s+último)$/i.test(targetRef);

        if (!isOrdinal || hasExplicitScope) {
          try {
            let timeMin = new Date();
            let timeMax = null;

            if (hasExplicitScope) {
              const scopeRes = resolveCalendarTemporalScope(
                {
                  date: params.date || (params.startDateTime ? String(params.startDateTime).split('T')[0] : null),
                  scope: params.scope || (params.date || params.startDateTime ? 'explicit_date' : null),
                },
                tz
              );
              timeMin = scopeRes.timeMin;
              timeMax = scopeRes.timeMax;
            }

            const liveEvents = await listCalendarEvents(userId, {
              timeMin,
              timeMax,
              q: params.query || params.target || null,
              timezone: tz,
            });

            domainCandidates = liveEvents || [];
          } catch (fetchErr) {
            console.warn('[calendarTools] Domain candidate retrieval error:', fetchErr.message);
          }
        }

        const refRes = resolveEntityReference({
          userOrPhone: user || phoneNumber,
          reference: targetRef,
          candidates: domainCandidates,
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
        if (hasExplicitScope) {
          const notFoundMsg = language === 'en'
            ? 'No event found on Google Calendar for that date. Would you like me to schedule a new one?'
            : 'No encontré ningún evento en Google Calendar para esa fecha. ¿Deseas que lo agende como uno nuevo?';
          return {
            success: false,
            action: 'event_not_found',
            errorCode: 'NOT_FOUND',
            error: notFoundMsg,
            rawSummary: notFoundMsg,
            confirmation: notFoundMsg,
          };
        }
        return {
          success: false,
          action: 'missing_event_id',
          errorCode: 'MISSING_TARGET_ID',
          error: 'Falta el ID del evento a actualizar en Google Calendar.',
          confirmation: '⚠️ No encontré el evento a actualizar. Por favor indica la fecha o el nombre del evento.',
        };
      }

      const startDateTime = params.startDateTime ? parseTargetTime(params.startDateTime, tz, referenceTime) : undefined;
      const endDateTime = params.endDateTime ? parseTargetTime(params.endDateTime, tz, referenceTime) : undefined;

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
        if (isGoogleAuthError(err)) {
          const reconnect = buildGoogleReauthSummary(language);
          return {
            success: false,
            action: reconnect.action,
            errorCode: reconnect.errorCode,
            data: { auth_url: reconnect.authUrl, authUrl: reconnect.authUrl },
            ctaUrl: reconnect.ctaUrl,
            error: reconnect.summary,
            rawSummary: reconnect.summary,
            formattedCard: `⚠️ ${reconnect.summary}`,
            confirmation: reconnect.summary,
          };
        }
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
      let resolvedRef = null;
      const hasExplicitScope = Boolean(params.date || params.startDateTime || params.scope);

      if (!eventId || String(eventId).length < 8) {
        let domainCandidates = null;
        const targetRef = String(eventId || params.target || params.summary || params.query || '').trim();

        const isOrdinal = /^(#?\d+|el\s+\d+|primero|primera|segundo|segunda|tercero|tercera|cuarto|cuarta|quinto|quinta|el\s+primero|la\s+primera|el\s+segundo|la\s+segunda|el\s+mas\s+temprano|el\s+más\s+temprano|el\s+ultimo|el\s+último)$/i.test(targetRef);

        if (!isOrdinal || hasExplicitScope) {
          try {
            let timeMin = new Date();
            let timeMax = null;

            if (hasExplicitScope) {
              const scopeRes = resolveCalendarTemporalScope(
                {
                  date: params.date || (params.startDateTime ? String(params.startDateTime).split('T')[0] : null),
                  scope: params.scope || (params.date || params.startDateTime ? 'explicit_date' : null),
                },
                tz
              );
              timeMin = scopeRes.timeMin;
              timeMax = scopeRes.timeMax;
            }

            const liveEvents = await listCalendarEvents(userId, {
              timeMin,
              timeMax,
              q: params.query || params.target || null,
              timezone: tz,
            });

            domainCandidates = liveEvents || [];
          } catch (fetchErr) {
            console.warn('[calendarTools] Domain candidate retrieval error:', fetchErr.message);
          }
        }

        const refRes = resolveEntityReference({
          userOrPhone: user || phoneNumber,
          reference: targetRef,
          candidates: domainCandidates,
          preferredType: 'calendar_event',
        });
        if (refRes.status === 'RESOLVED') {
          eventId = refRes.item.internalId;
          resolvedRef = refRes.item;
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
        if (hasExplicitScope) {
          const notFoundMsg = language === 'en'
            ? 'No event found on Google Calendar for that date.'
            : 'No encontré ningún evento en Google Calendar para esa fecha.';
          return {
            success: false,
            action: 'event_not_found',
            errorCode: 'NOT_FOUND',
            error: notFoundMsg,
            rawSummary: notFoundMsg,
            confirmation: notFoundMsg,
          };
        }
        return {
          success: false,
          action: 'missing_event_id',
          errorCode: 'MISSING_TARGET_ID',
          error: 'Falta el ID del evento a eliminar en Google Calendar.',
          confirmation: '⚠️ No encontré el evento a eliminar. Por favor indica la fecha o el nombre del evento.',
        };
      }

      const deleted = await deleteCalendarEvent(userId, eventId);
      const refreshedIntegration = await getUserIntegration(userId, 'google');
      const isStale = hasUsableGoogleCredentials(refreshedIntegration) === false && !deleted;

      if (isStale) {
        const reconnect = buildGoogleReauthSummary(language);
        return {
          success: false,
          action: reconnect.action,
          errorCode: reconnect.errorCode,
          data: { auth_url: reconnect.authUrl, authUrl: reconnect.authUrl },
          ctaUrl: reconnect.ctaUrl,
          error: reconnect.summary,
          rawSummary: reconnect.summary,
          formattedCard: `⚠️ ${reconnect.summary}`,
          confirmation: reconnect.summary,
        };
      }

      const deletedItemSummary = resolvedRef?.summary || null;
      const summary = deleted
        ? (deletedItemSummary
            ? `Evento eliminado de tu Google Calendar: *${deletedItemSummary}*.`
            : (language === 'en' ? 'Event deleted from your Google Calendar.' : 'Evento eliminado de tu Google Calendar.'))
        : (language === 'en' ? 'Could not delete event from Google Calendar.' : 'No se pudo eliminar el evento de Google Calendar.');
      return {
        success: deleted,
        action: deleted ? 'google_event_deleted' : 'google_api_error',
        data: { eventId, deleted },
        rawSummary: summary,
        formattedCard: summary,
        confirmation: summary,
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

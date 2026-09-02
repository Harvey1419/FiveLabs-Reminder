import {
  getUserIntegration,
} from '../../db/index.js';
import {
  getGoogleConnectUrl,
  revokeGoogleIntegration,
} from '../../services/googleAuth.js';
import {
  listCalendarEvents,
  createCalendarEvent,
} from '../../services/googleCalendar.js';
import { parseTargetTime, formatLocalDateTime, DEFAULT_TIMEZONE } from '../../utils/time.js';

/**
 * Domain tool for managing Google Calendar synchronization.
 */
export async function executeCalendarTool({ action, params = {}, user, language = 'es' }) {
  const userId = user?.id;
  const phoneNumber = user?.phone_number;
  const tz = user?.timezone || DEFAULT_TIMEZONE;
  const integration = await getUserIntegration(userId, 'google');

  switch (action) {
    case 'get_connect_link':
    case 'connect': {
      if (integration?.access_token) {
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

    case 'list_events': {
      if (!integration?.access_token) {
        const authUrl = getGoogleConnectUrl({ userId, phoneNumber });
        const summary = `Para consultar tu Google Calendar, primero debes vincular tu cuenta: ${authUrl}`;
        return {
          success: false,
          action: 'google_not_connected',
          errorCode: 'AUTH_REQUIRED',
          data: { auth_url: authUrl, authUrl },
          ctaUrl: authUrl,
          error: summary,
          rawSummary: summary,
        };
      }

      const timeMin = params.timeMin ? parseTargetTime(params.timeMin, tz) : new Date();
      const timeMax = params.timeMax ? parseTargetTime(params.timeMax, tz) : null;

      const events = await listCalendarEvents(userId, {
        timeMin,
        timeMax,
        timezone: tz,
        maxResults: params.maxResults || 10,
      });

      if (!events || events.length === 0) {
        const summary = 'No tienes eventos programados en Google Calendar para este período.';
        return {
          success: true,
          action: 'google_events_listed',
          data: [],
          rawSummary: summary,
          formattedCard: summary,
        };
      }

      const eventsFormatted = events.map(e => {
        const dateStr = formatLocalDateTime(new Date(e.start), tz, language === 'en' ? 'en-US' : 'es-CO');
        const meet = e.meetLink ? ` (Google Meet: ${e.meetLink})` : '';
        return `• 📅 *${e.summary}* — ${dateStr}${meet}`;
      }).join('\n');

      const summary = `Eventos en tu Google Calendar:\n${eventsFormatted}`;

      return {
        success: true,
        action: 'google_events_listed',
        data: events,
        rawSummary: summary,
        formattedCard: summary,
      };
    }

    case 'create_event': {
      if (!integration?.access_token) {
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
        };
      }

      const startDateTime = parseTargetTime(params.startDateTime || params.targetTime || '+1h', tz);
      const endDateTime = params.endDateTime
        ? parseTargetTime(params.endDateTime, tz)
        : new Date(startDateTime.getTime() + (params.durationMinutes || 60) * 60 * 1000);

      const event = await createCalendarEvent(userId, {
        summary: params.summary || params.content || 'Reunión',
        description: params.description || '',
        startDateTime,
        endDateTime,
        timezone: tz,
        addGoogleMeet: Boolean(params.addGoogleMeet),
      });

      const meetNotice = event.meetLink ? `\n📹 *Google Meet:* ${event.meetLink}` : '';
      const summary = `Evento agendado en Google Calendar: *${event.summary}* para ${formatLocalDateTime(startDateTime, tz, 'es-CO')}.${meetNotice}`;

      return {
        success: true,
        action: 'google_event_created',
        data: event,
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

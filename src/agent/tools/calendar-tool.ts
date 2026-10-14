import { isCalendarLookupDate } from '../../shared/calendar-lookup-date.js';
import type { FeatureToolUser } from '../../features/read-model-ports.js';
export interface CalendarEventRow extends Record<string, unknown> {
 id?: string | undefined; summary?: string; description?: string; location?: string | null; hangoutLink?: string | null; meetLink?: string | null;
 rawStartDate?: string; rawStartDateTime?: string; start?: string | { dateTime?: string; date?: string }; end?: string | { dateTime?: string; date?: string };
 isAllDay?: boolean; recurrence?: unknown; status?: string; sortTimestamp?: number; type?: string; localDate?: string; formattedDate?: string; displayDate?: string; startIso?: string; endIso?: string | undefined; localStartTime?: string;
}
export interface CalendarParams extends Record<string, unknown> { query?: string | null; scope?: string | null; summary?: string; target?: unknown; description?: string; startDateTime?: string; endDateTime?: string; startDate?: string; endDate?: string; durationMinutes?: number; lookupDate?: string; advanceMinutes?: unknown; allDay?: boolean; addGoogleMeet?: boolean; recurrence?: string | null; clearRecurrence?: boolean }
export interface CalendarToolInput { action: string; params?: CalendarParams; user?: FeatureToolUser | null; language?: string; referenceTime?: Date | null }
export interface CalendarReference { status: string; item?: { internalId?: string; summary?: string } }
export interface CalendarToolDependencies {
 getUserIntegration(userId: string | undefined, provider: string): Promise<{ account_email?: string | null } | null>;
 saveReminder(input: Record<string, unknown>): Promise<unknown>;
 cancelCalendarCompanionReminders(input: Record<string, unknown>): Promise<{ cancelled: number; error?: unknown }>;
 rescheduleCalendarCompanionReminders(input: Record<string, unknown>): Promise<{ rescheduled: number }>;
 getGoogleConnectUrl(input: { userId: string | undefined; phoneNumber: string | null | undefined }): string;
 revokeGoogleIntegration(userId: string | undefined): Promise<unknown>;
 hasUsableGoogleCredentials(input: unknown): boolean;
 isGoogleAuthError(error: unknown): boolean;
 listCalendarEvents(userId: string | undefined, options: Record<string, unknown>): Promise<CalendarEventRow[]>;
 createCalendarEvent(userId: string | undefined, options: Record<string, unknown>): Promise<CalendarEventRow>;
 updateCalendarEvent(userId: string | undefined, options: Record<string, unknown>): Promise<CalendarEventRow>;
 deleteCalendarEvent(userId: string | undefined, eventId: string): Promise<unknown>;
 parseTargetTime: typeof import('../../shared/time.js').parseTargetTime;
 getDayBounds: typeof import('../../shared/time.js').getDayBounds;
 resolveCalendarTemporalScope: typeof import('../../shared/time.js').resolveCalendarTemporalScope;
 formatLocalDateTime: typeof import('../../shared/time.js').formatLocalDateTime;
 formatHumanFriendlyDateTime: typeof import('../../shared/time.js').formatHumanFriendlyDateTime;
 formatHumanFriendlyDate: typeof import('../../shared/time.js').formatHumanFriendlyDate;
 zonedTimeToUtc: typeof import('../../shared/time.js').zonedTimeToUtc;
 DEFAULT_TIMEZONE: string;
 formatRecurrenceLabel: typeof import('../../shared/reminder-presentation.js').formatRecurrenceLabel;
 parseStructuredOrdinal: typeof import('../core/context-reference.js').parseStructuredOrdinal;
 resolveContextReference(input: Record<string, unknown>): CalendarReference;
 getWorkingMemory(key: unknown): unknown;
 getNow(): Date; getNowMs(): number; logger: Pick<Console, 'log' | 'warn' | 'error'>;
}

export function createCalendarTool({ getUserIntegration, saveReminder, cancelCalendarCompanionReminders, rescheduleCalendarCompanionReminders, getGoogleConnectUrl, revokeGoogleIntegration, hasUsableGoogleCredentials, isGoogleAuthError, listCalendarEvents, createCalendarEvent, updateCalendarEvent, deleteCalendarEvent, parseTargetTime, getDayBounds, resolveCalendarTemporalScope, formatLocalDateTime, formatHumanFriendlyDateTime, formatHumanFriendlyDate, zonedTimeToUtc, DEFAULT_TIMEZONE, formatRecurrenceLabel, parseStructuredOrdinal, resolveContextReference, getWorkingMemory, getNow, getNowMs, logger }: CalendarToolDependencies) {

/**
 * Normalizes raw Google Calendar event into explicit civil or timed representation.
 * Guarantees All-Day events remain civil dates without UTC timezone shift.
 */
function normalizeCalendarEvent(ev: CalendarEventRow, timezone = DEFAULT_TIMEZONE): CalendarEventRow {
  const rawStartDate = ev.rawStartDate || (typeof ev.start === 'object' ? ev.start?.date : null) || (typeof ev.start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ev.start) ? ev.start : null);
  const rawStartDateTime = ev.rawStartDateTime || (typeof ev.start === 'object' ? ev.start?.dateTime : null) || (typeof ev.start === 'string' && ev.start.includes('T') ? ev.start : null);
  const isAllDay = Boolean(ev.isAllDay || (rawStartDate && !rawStartDateTime));

  if (isAllDay && rawStartDate) {
    const match = rawStartDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
    const y = match ? match[1]! : '2026';
    const m = match ? match[2]! : '01';
    const d = match ? match[3]! : '01';
    const sortTimestamp = zonedTimeToUtc(parseInt(y, 10), parseInt(m, 10), parseInt(d, 10), 0, 0, 0, timezone).getTime();
    return {
      id: ev.id,
      summary: ev.summary || '(Sin título)',
      description: ev.description || '',
      location: ev.location || null,
      meetLink: ev.hangoutLink || ev.meetLink || null,
      type: 'all_day',
      isAllDay: true,
      recurrence: ev.recurrence || null,
      localDate: `${y}-${m}-${d}`,
      formattedDate: `${d}/${m}/${y}`,
      displayDate: `${d}/${m}/${y} (Todo el día)`,
      sortTimestamp,
      status: ev.status || 'confirmed',
    };
  }

  const startIso = rawStartDateTime || (typeof ev.start === 'string' ? ev.start : (rawStartDate ? `${rawStartDate}T00:00:00Z` : getNow().toISOString()));
  const sortTimestamp = new Date(startIso).getTime();
  const dateStr = formatHumanFriendlyDateTime(new Date(startIso), timezone, 'es');
  return {
    id: ev.id,
    summary: ev.summary || '(Sin título)',
    description: ev.description || '',
    location: ev.location || null,
    meetLink: ev.hangoutLink || ev.meetLink || null,
    type: 'timed',
    isAllDay: false,
    recurrence: ev.recurrence || null,
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
function formatCalendarEventLine(ev: CalendarEventRow, timezone = DEFAULT_TIMEZONE, language = 'es') {
  if (ev.type === 'all_day') {
    const [y, m, d] = ev.localDate!.split('-');
    const dateText = `${d}/${m}/${y} (${language === 'en' ? 'All day' : 'Todo el día'})`;
    return `• 📅 *${ev.summary}* — ${dateText}`;
  }

  const meet = ev.meetLink ? ` (Google Meet: ${ev.meetLink})` : '';
  return `• 📅 *${ev.summary}* — ${ev.displayDate}${meet}`;
}

/**
 * Sanitizes calendar query strings, stripping temporal and filler phrases,
 * and inferring a temporal scope if none was explicitly provided.
 *
 * @param {{ query?: string|null, scope?: string|null }} input
 * @returns {{ query: string|null, scope: string|null }}
 */
function sanitizeCalendarQueryAndScope({ query, scope }: { query?: unknown; scope?: unknown } = {}) {
  let effectiveScope = scope ? String(scope).trim() : null;
  const raw = typeof query === 'string' ? query.trim() : '';

  if (!raw) {
    return { query: null, scope: effectiveScope };
  }

  const lower = raw.toLowerCase();
  let detectedScope = null;

  if (/\b(pasado\s+mañana|pasado\s+manana|day\s+after\s+tomorrow)\b/i.test(lower)) {
    detectedScope = 'day_after_tomorrow';
  } else if (/\b(mañana|manana|tomorrow)\b/i.test(lower)) {
    detectedScope = 'tomorrow';
  } else if (/\b(hoy|today)\b/i.test(lower)) {
    detectedScope = 'today';
  } else if (/\b(esta\s+semana|this\s+week)\b/i.test(lower)) {
    detectedScope = 'this_week';
  } else if (/\b(pr[oó]xima\s+semana|next\s+week)\b/i.test(lower)) {
    detectedScope = 'next_week';
  } else if (/\b(este\s+fin\s+de\s+semana|este\s+finde|this\s+weekend)\b/i.test(lower)) {
    detectedScope = 'this_weekend';
  } else {
    const weekdayMatches = lower.match(/\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
    if (weekdayMatches) {
      const w = weekdayMatches[1]!.toLowerCase().replace('é', 'e').replace('á', 'a');
      const map: Record<string, string> = {
        lunes: 'monday', martes: 'tuesday', miercoles: 'wednesday', jueves: 'thursday',
        viernes: 'friday', sabado: 'saturday', domingo: 'sunday',
        monday: 'monday', tuesday: 'tuesday', wednesday: 'wednesday', thursday: 'thursday',
        friday: 'friday', saturday: 'saturday', sunday: 'sunday',
      };
      if (map[w]) detectedScope = map[w];
    }
  }

  if (!effectiveScope || effectiveScope === 'default_upcoming' || effectiveScope === 'upcoming') {
    if (detectedScope) {
      effectiveScope = detectedScope;
    }
  }

  // Strip temporal phrases from query
  let cleaned = lower
    .replace(/\b(pasado\s+mañana|pasado\s+manana|day\s+after\s+tomorrow)\b/gi, ' ')
    .replace(/\b(mañana|manana|tomorrow)\b/gi, ' ')
    .replace(/\b(hoy|today)\b/gi, ' ')
    .replace(/\b(esta\s+semana|this\s+week)\b/gi, ' ')
    .replace(/\b(pr[oó]xima\s+semana|next\s+week)\b/gi, ' ')
    .replace(/\b(este\s+fin\s+de\s+semana|este\s+finde|this\s+weekend)\b/gi, ' ')
    .replace(/\b(el\s+|este\s+|este\s+pr[oó]ximo\s+|el\s+pr[oó]ximo\s+)?(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, ' ');

  // Strip generic calendar stopwords and search filler
  cleaned = cleaned
    .replace(/\b(google\s+calendar|google|calendario|calendar|agenda)\b/gi, ' ')
    .replace(/\b(reuniones|reuni[oó]n|meetings|meeting)\b/gi, ' ')
    .replace(/\b(eventos|evento|events|event)\b/gi, ' ')
    .replace(/\b(citas|cita|appointments|appointment)\b/gi, ' ')
    .replace(/\b(qu[eé]\s+tengo(\s+programado|\s+agendado)?|qu[eé]\s+hay|tengo(\s+programado|\s+agendado)?)\b/gi, ' ')
    .replace(/\b(revisa(r)?(\s+mi)?|dame(\s+mi)?|ver(\s+mi)?|mostrar(\s+mis?)?|muestra(\s+mis?)?|consultar(\s+mi)?|consulta(\s+mi)?)\b/gi, ' ')
    .replace(/\b(mis|mi|cu[aá]les\s+son|cu[aá]l\s+es|hay)\b/gi, ' ')
    .replace(/\b(de|del|para|en|por|a|con|sobre|el|la|los|las|un|una|unos|unas)\b/gi, ' ')
    .replace(/[^\w\sáéíóúüñÁÉÍÓÚÜÑ]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const finalQuery = cleaned.length > 0 ? cleaned : null;
  return { query: finalQuery, scope: effectiveScope };
}

/**
 * Resolve a canonical mutation target. Identity comes only from params.target;
 * patch fields such as startDateTime/summary never participate in lookup.
 */
async function resolveCalendarMutationTarget({ target, user, phoneNumber, userId, timezone, lookupDate, referenceTime }: { lookupDate?: string | undefined; referenceTime?: Date | null; target: unknown; user: FeatureToolUser | null | undefined; phoneNumber: string | null | undefined; userId: string | undefined; timezone: string }) {
  const targetRef = String(target || '').trim();
  if (!targetRef) return { status: 'NOT_FOUND' };

  let domainCandidates = null;
  const isOrdinal = parseStructuredOrdinal(targetRef) !== null;

  if (lookupDate && isOrdinal) return { status: 'NOT_FOUND' };
  const bounds = lookupDate ? resolveCalendarTemporalScope({ scope: 'explicit_date', date: lookupDate }, timezone, referenceTime || getNow()) : null;

  if (!isOrdinal) {
    try {
      domainCandidates = await listCalendarEvents(userId, {
        timeMin: bounds?.timeMin || getNow(),
        timeMax: bounds?.timeMax || null,
        q: targetRef,
        timezone,
      });
      if (bounds) domainCandidates = domainCandidates.filter(event => {
        const raw = event.rawStartDateTime || event.startIso || (typeof event.start === 'string' ? event.start : event.start?.dateTime);
        const civil = event.rawStartDate || (typeof event.start === 'object' ? event.start?.date : isCalendarLookupDate(event.start) ? event.start : null);
        const timestamp = civil && isCalendarLookupDate(civil)
          ? normalizeCalendarEvent({ ...event, rawStartDate: civil }, timezone).sortTimestamp
          : raw ? new Date(raw).getTime() : null;
        return typeof timestamp === 'number' && timestamp >= bounds.timeMin.getTime() && timestamp < bounds.timeMax!.getTime();
      });
    } catch (fetchErr) {
      logger.warn('[calendarTools] Domain candidate retrieval error:', (fetchErr as { message: string; code: string }).message);
      if (lookupDate) return { status: 'ERROR' };
    }
  }

  return resolveContextReference({
    reference: targetRef,
    candidates: domainCandidates,
    preferredType: 'calendar_event',
    workingMemory: lookupDate ? null : getWorkingMemory(user || phoneNumber),
  });
}

/**
 * Domain tool for managing Google Calendar synchronization (Architecture V3).
 */
async function executeCalendarTool({ action, params = {}, user, language = 'es', referenceTime = null }: CalendarToolInput) {
  if (action === 'update_event' && params.lookupDate !== undefined
    && (!isCalendarLookupDate(params.lookupDate) || parseStructuredOrdinal(String(params.target || '')) !== null)) {
    return { success: false, errorCode: 'INVALID_CALENDAR_LOOKUP_DATE', error: 'La fecha de búsqueda requiere YYYY-MM-DD y un nombre de evento.' };
  }
  const userId = user?.id;
  const phoneNumber = user?.phone_number;
  const tz = user?.timezone || DEFAULT_TIMEZONE;
  const integration = await getUserIntegration(userId, 'google');
  const isConnected = hasUsableGoogleCredentials(integration);

  const buildGoogleReauthSummary = (lang: string) => {
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
    case 'get_connect_link': {
      if (isConnected) {
        try {
          await listCalendarEvents(userId, { timezone: tz, maxResults: 1 });
          const email = integration!.account_email ? ` (${integration!.account_email})` : '';
          const summary = language === 'en'
            ? `Your Google Calendar is already connected${email}. Tell me if you want to disconnect it or switch accounts.`
            : `Tu Google Calendar ya está conectado${email}. Si deseas desconectarlo o cambiar de cuenta, solo dímelo.`;
          return {
            success: true,
            action: 'already_connected',
            data: { email: integration!.account_email },
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

      const sanitized = sanitizeCalendarQueryAndScope({
        query: params.query,
        scope: params.scope,
      });
      const queryParam = action === 'next_event' ? null : sanitized.query;
      const effectiveScope = action === 'next_event'
        ? 'next_event'
        : (sanitized.scope || params.scope || 'default_upcoming');
      const resolved = resolveCalendarTemporalScope({ ...params, scope: effectiveScope }, tz, referenceTime || getNow());

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
        logger.error(`[calendarTools] Google API error for user ${userId}:`, (err as { message: string; code: string }).message);

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

      const events = (rawEvents || []).map(ev => normalizeCalendarEvent(ev, tz));

      if (events.length === 0) {
        let summary = '';
        if (resolved.isNextEvent) {
          summary = language === 'en'
            ? 'You have no upcoming events scheduled in your Google Calendar.'
            : 'No tienes eventos próximos programados en tu Google Calendar.';
        } else if (queryParam) {
          summary = language === 'en'
            ? `No events matching "${queryParam}" were found in your Google Calendar for this period.`
            : `No encontré eventos relacionados con "${queryParam}" en tu Google Calendar para este período.`;
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

      if (resolved.isNextEvent) {
        events.sort((a, b) => a.sortTimestamp! - b.sortTimestamp!);
        const ev = events[0]!;
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

      const eventsFormatted = events.map(e => formatCalendarEventLine(e, tz, language)).join('\n');
      const header = language === 'en'
        ? (queryParam ? `Events matching "${queryParam}" in your Google Calendar:` : 'Events in your Google Calendar:')
        : (queryParam ? `Eventos relacionados con "${queryParam}" en tu Google Calendar:` : 'Eventos en tu Google Calendar:');
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
        const summary = language === 'en'
          ? `To schedule an event in Google Calendar, first connect your account: ${authUrl}`
          : `Para agendar directamente en Google Calendar, primero debes conectar tu cuenta: ${authUrl}`;
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

      if (!params.summary || (!params.startDateTime && !params.startDate)) {
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

      const isAllDay = Boolean(params.allDay || (params.startDate && !params.startDateTime));
      const startDateTime = params.startDateTime ? parseTargetTime(params.startDateTime, tz, referenceTime) : null;
      const endDateTime = params.endDateTime
        ? parseTargetTime(params.endDateTime, tz, referenceTime)
        : (startDateTime ? new Date(startDateTime.getTime() + (params.durationMinutes || 60) * 60 * 1000) : null);

      let event;
      try {
        event = await createCalendarEvent(userId, {
          summary: params.summary,
          description: params.description || '',
          startDateTime,
          endDateTime,
          timezone: tz,
          addGoogleMeet: Boolean(params.addGoogleMeet),
          allDay: isAllDay,
          startDate: params.startDate || (isAllDay && startDateTime ? startDateTime.toISOString().split('T')[0] : null),
          endDate: params.endDate || null,
          recurrence: params.recurrence || null,
        });
      } catch (err) {
        logger.error(`[calendarTools] Failed to create Google event for user ${userId}:`, (err as { message: string; code: string }).message);
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

      const hasExplicitAdvanceNotice = params.advanceMinutes !== undefined && params.advanceMinutes !== null;
      const advanceMinutes = hasExplicitAdvanceNotice ? Number(params.advanceMinutes) : null;
      let reminderCreated = false;
      let reminderSendAt = null;

      if (hasExplicitAdvanceNotice && Number.isFinite(advanceMinutes) && advanceMinutes! > 0 && startDateTime) {
        reminderSendAt = new Date(startDateTime.getTime() - advanceMinutes! * 60 * 1000).toISOString();
        if (new Date(reminderSendAt!).getTime() > getNowMs()) {
          const advContent = `🔔 [Google Calendar] ${event.summary} en ${advanceMinutes} minutos`;
          try {
            const inserted = await saveReminder({
              userId,
              phoneNumber,
              content: advContent,
              sendAt: reminderSendAt,
              deliveryId: `gcal:${event.id}`,
              source: 'gcal_companion',
              requiresConfirmation: true,
              recurrenceRule: params.recurrence || null,
            });
            if (inserted) reminderCreated = true;
          } catch (remErr) {
            logger.warn('[calendarTools] Failed to save linked reminder:', (remErr as { message: string; code: string }).message);
          }
        }
      }

      const meetNotice = event.meetLink ? `\n• 📹 *Google Meet:* ${event.meetLink}` : '';
      const formattedStartDate = isAllDay
        ? `${formatHumanFriendlyDate(startDateTime || params.startDate, tz, language)} (${language === 'en' ? 'All day' : 'Todo el día'})`
        : formatHumanFriendlyDateTime(startDateTime, tz, language);
      const recurrenceNotice = params.recurrence
        ? `\n• 🔄 *${language === 'en' ? 'Recurrence' : 'Recurrencia'}:* ${formatRecurrenceLabel(params.recurrence, language)}`
        : '';
      let summary = `📅 *${language === 'en' ? 'Event scheduled in Google Calendar' : 'Evento agendado en Google Calendar'}*\n\n• 🏢 *${event.summary}*\n• 📅 ${formattedStartDate}${recurrenceNotice}${meetNotice}`;

      if (reminderCreated) {
        summary += `\n\n🔔 *Recordatorio programado en WhatsApp*\n• ${advanceMinutes} minutos antes (${formatHumanFriendlyDateTime(new Date(reminderSendAt!), tz, language)})`;
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

      const targetRef = String(params.target || '').trim();
      if (!targetRef) {
        return {
          success: false,
          action: 'missing_event_target',
          errorCode: 'MISSING_TARGET_ID',
          error: 'Falta identificar el evento a actualizar en Google Calendar.',
          confirmation: '⚠️ No encontré el evento a actualizar. Por favor indica el nombre o referencia del evento.',
        };
      }

      const refRes = await resolveCalendarMutationTarget({
        target: targetRef,
        user,
        phoneNumber,
        userId,
        timezone: tz, lookupDate: params.lookupDate, referenceTime,
      });

      if (refRes.status === 'ERROR') return { success: false, errorCode: 'SERVICE_UNAVAILABLE', error: 'No pude consultar el evento en Google Calendar.' };

      if (refRes.status === 'AMBIGUOUS') {
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

      const eventId = refRes.status === 'RESOLVED' ? refRes.item!.internalId : null;
      if (!eventId) {
        const notFoundMsg = language === 'en'
          ? 'I could not find that event in Google Calendar.'
          : 'No encontré ese evento en Google Calendar.';
        return {
          success: false,
          action: 'event_not_found',
          errorCode: 'NOT_FOUND',
          error: notFoundMsg,
          rawSummary: notFoundMsg,
          confirmation: notFoundMsg,
        };
      }

      const isAllDay = Boolean(params.allDay || (params.startDate && !params.startDateTime));
      const startDateTime = params.startDateTime ? parseTargetTime(params.startDateTime, tz, referenceTime) : undefined;
      const endDateTime = params.endDateTime ? parseTargetTime(params.endDateTime, tz, referenceTime) : undefined;

      try {
        const updated = await updateCalendarEvent(userId, {
          eventId,
          summary: params.summary,
          description: params.description,
          startDateTime,
          endDateTime,
          durationMinutes: params.durationMinutes,
          timezone: tz,
          allDay: isAllDay,
          startDate: params.startDate || (isAllDay && startDateTime ? startDateTime.toISOString().split('T')[0] : null),
          endDate: params.endDate || null,
          recurrence: params.recurrence || null,
          clearRecurrence: Boolean(params.clearRecurrence),
        });

        let companionUpdated = false;
        if (startDateTime) {
          try {
            const resch = await rescheduleCalendarCompanionReminders({
              userId,
              eventId,
              summary: updated.summary,
              newStartDateTime: startDateTime,
            });
            companionUpdated = resch.rescheduled > 0;
          } catch (rErr) {
            logger.warn('[calendarTools] Companion reschedule error:', (rErr as { message: string; code: string }).message);
          }
        }

        let summary = `✏️ *Google Calendar · ${language === 'en' ? 'Event updated' : 'Evento actualizado'}*\n\n• 📅 *${updated.summary}*`;
        if (updated.isAllDay) {
          summary += ` — ${formatHumanFriendlyDate(startDateTime || new Date(updated.start as string), tz, language)} (${language === 'en' ? 'All day' : 'Todo el día'})`;
        } else if (startDateTime) {
          summary += ` — ${formatHumanFriendlyDateTime(startDateTime, tz, language)}`;
        }
        if (params.recurrence) {
          summary += `\n• 🔄 *${language === 'en' ? 'Recurrence' : 'Recurrencia'}:* ${formatRecurrenceLabel(params.recurrence, language)}`;
        }
        if (companionUpdated) {
          summary += `\n• 🔔 ${language === 'en' ? 'WhatsApp reminder rescheduled' : 'Recordatorio en WhatsApp reprogramado'}`;
        }

        return {
          success: true,
          action: 'google_event_updated',
          data: {
            ...updated,
            companionUpdated,
          },
          rawSummary: summary,
          formattedCard: summary,
        };
      } catch (err) {
        if (['UNSUPPORTED_CALENDAR_DURATION', 'INCOMPATIBLE_CALENDAR_PATCH', 'INVALID_CALENDAR_INTERVAL'].includes((err as { message: string; code: string }).code)) {
          return {
            success: false,
            action: 'invalid_parameters',
            errorCode: (err as { message: string; code: string }).code,
            error: language === 'en'
              ? ((err as { message: string; code: string }).message || 'The requested calendar update is not compatible with this event.')
              : ((err as { message: string; code: string }).code === 'UNSUPPORTED_CALENDAR_DURATION'
                ? 'No se puede aplicar una duración a un evento de día completo.'
                : 'La actualización solicitada no es compatible con este evento.'),
          };
        }
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

      const targetRef = String(params.target || '').trim();
      if (!targetRef) {
        return {
          success: false,
          action: 'missing_event_target',
          errorCode: 'MISSING_TARGET_ID',
          error: 'Falta identificar el evento a eliminar en Google Calendar.',
          confirmation: '⚠️ No encontré el evento a eliminar. Por favor indica el nombre o referencia del evento.',
        };
      }

      const refRes = await resolveCalendarMutationTarget({
        target: targetRef,
        user,
        phoneNumber,
        userId,
        timezone: tz,
      });

      if (refRes.status === 'AMBIGUOUS') {
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

      const eventId = refRes.status === 'RESOLVED' ? refRes.item!.internalId : null;
      const resolvedRef = refRes.status === 'RESOLVED' ? refRes.item : null;
      if (!eventId) {
        const notFoundMsg = language === 'en'
          ? 'I could not find that event in Google Calendar.'
          : 'No encontré ese evento en Google Calendar.';
        return {
          success: false,
          action: 'event_not_found',
          errorCode: 'NOT_FOUND',
          error: notFoundMsg,
          rawSummary: notFoundMsg,
          confirmation: notFoundMsg,
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

      let companionCancelled = false;
      let companionCleanupFailed = false;
      const deletedItemSummary = resolvedRef?.summary || null;
      if (deleted) {
        try {
          const cancelRes = await cancelCalendarCompanionReminders({
            userId,
            eventId,
            summary: deletedItemSummary,
          });
          companionCancelled = cancelRes.cancelled > 0;
          companionCleanupFailed = Boolean(cancelRes?.error);
        } catch (cErr) {
          logger.warn('[calendarTools] Companion cancel error:', (cErr as { message: string; code: string }).message);
          companionCleanupFailed = true;
        }
      }

      let summary;
      if (deleted) {
        const deletedTitle = deletedItemSummary ? `*${deletedItemSummary}*` : (language === 'en' ? 'Event' : 'Evento');
        summary = `🗑️ *Google Calendar · ${language === 'en' ? 'Event deleted' : 'Evento eliminado'}*\n\n• 📅 ${deletedTitle}`;
        if (companionCancelled) {
          summary += `\n• 🔔 ${language === 'en' ? 'Associated WhatsApp reminder cancelled' : 'Recordatorio de WhatsApp asociado cancelado'}`;
        }
        if (companionCleanupFailed) {
          summary += `\n• ⚠️ ${language === 'en' ? 'The event was deleted, but I could not confirm its linked reminder was cancelled; it may remain scheduled.' : 'El evento se eliminó, pero no pude confirmar la cancelación de su recordatorio vinculado; podría seguir programado.'}`;
        }
      } else {
        summary = language === 'en' ? 'Could not delete event from Google Calendar.' : 'No se pudo eliminar el evento de Google Calendar.';
      }
      return {
        success: deleted,
        partialSuccess: Boolean(deleted && companionCleanupFailed),
        complete: Boolean(deleted && !companionCleanupFailed),
        action: deleted ? 'google_event_deleted' : 'google_api_error',
        data: { eventId, deleted, companionCancelled },
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

return { normalizeCalendarEvent, formatCalendarEventLine, sanitizeCalendarQueryAndScope, executeCalendarTool };
}

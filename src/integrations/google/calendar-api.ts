import type { CalendarApi, GoogleEvent, CalendarEventInput, CalendarListOptions, CalendarWriteInput, CalendarDeltaOptions, WatchInput, GoogleApiError } from './calendar-api-ports.js';

export interface Dependencies {
  clearInvalidGoogleIntegration: typeof import('./auth.js').clearInvalidGoogleIntegration;
  isGoogleAuthError: typeof import('./auth.js').isGoogleAuthError;
  getAuthenticatedGoogleClient: (userId: string | undefined) => Promise<unknown>;
  getUserIntegration: (userId: string | undefined, provider: string) => Promise<{ metadata?: (Record<string, unknown> & { channelId?: string | null; resourceId?: string | null }) | null } | null>;
  updateUserIntegrationMetadata: (userId: string | undefined, provider: string, metadata: Record<string, unknown>) => Promise<unknown>;
  formatLocalDateTime: typeof import('../../shared/time.js').formatLocalDateTime;
  formatHumanFriendlyDateTime: typeof import('../../shared/time.js').formatHumanFriendlyDateTime;
  zonedTimeToUtc: typeof import('../../shared/time.js').zonedTimeToUtc;
  DEFAULT_TIMEZONE: typeof import('../../shared/time.js').DEFAULT_TIMEZONE;
  getCalendar(auth: unknown): CalendarApi;
  crypto: Pick<typeof import('node:crypto'), 'createHash' | 'randomUUID'>;
  getEnv(): NodeJS.ProcessEnv;
  logger: Pick<Console, 'log' | 'warn' | 'error'>;
}

export function createCalendarApi(dependencies: Dependencies) {
const { clearInvalidGoogleIntegration, isGoogleAuthError, getAuthenticatedGoogleClient, getUserIntegration, updateUserIntegrationMetadata, formatLocalDateTime, formatHumanFriendlyDateTime, zonedTimeToUtc, crypto, getCalendar, getEnv, logger } = dependencies;

async function handleGoogleApiError(userId: string | undefined, operation: string, err: unknown): Promise<never> {
  if (isGoogleAuthError(err)) {
    logger.warn(`[googleCalendar] ${operation} auth error for user ${userId}:`, (err as GoogleApiError).message);
    await clearInvalidGoogleIntegration(userId, `calendar-${operation}`);
  } else {
    logger.error(`[googleCalendar] ${operation} error for user ${userId}:`, (err as GoogleApiError).message);
  }

  throw err;
}

function googleAuthRequiredError() {
  const error: Error & { code?: string } = new Error('Google Calendar authentication is required.');
  error.code = 'GOOGLE_AUTH_REQUIRED';
  return error;
}

/**
 * Normalizes raw Google Calendar event into explicit civil or timed representation.
 * Guarantees All-Day events remain civil dates without UTC timezone shift.
 */
function normalizeCalendarEvent(ev: CalendarEventInput, timezone = dependencies.DEFAULT_TIMEZONE) {
  const rawStartDate = ev.rawStartDate || (typeof ev.start === 'object' ? ev.start?.date : null) || (typeof ev.start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ev.start) ? ev.start : null);
  const rawStartDateTime = ev.rawStartDateTime || (typeof ev.start === 'object' ? ev.start?.dateTime : null) || (typeof ev.start === 'string' && ev.start.includes('T') ? ev.start : null);
  const isAllDay = Boolean(ev.isAllDay || (rawStartDate && !rawStartDateTime));

  if (isAllDay && rawStartDate) {
    const match = rawStartDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
    const y = match ? match[1] : '2026';
    const m = match ? match[2] : '01';
    const d = match ? match[3] : '01';
    const sortTimestamp = zonedTimeToUtc(parseInt(y!, 10), parseInt(m!, 10), parseInt(d!, 10), 0, 0, 0, timezone).getTime();
    return {
      id: ev.id,
      summary: ev.summary || '(Sin título)',
      description: ev.description || '',
      location: ev.location || null,
      meetLink: ev.hangoutLink || ev.meetLink || null,
      type: 'all_day',
      isAllDay: true,
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
    isAllDay: false,
    startIso,
    endIso: typeof ev.end === 'object' ? (ev.end?.dateTime || ev.end?.date) : ev.end,
    localStartTime: dateStr,
    displayDate: dateStr,
    sortTimestamp,
    status: ev.status || 'confirmed',
    recurringEventId: ev.recurringEventId || null,
  };
}

/**
 * Generate a deterministic base32hex/hex event ID for Google Calendar API idempotency.
 * Google Calendar event IDs must match /^[a-v0-9]{5,1024}$/ (lowercase only).
 *
 * @param {string} userId
 * @param {string} summary
 * @param {string} startIso
 * @returns {string} 32-character deterministic ID
 */
function generateDeterministicCalendarEventId(userId: string | undefined, summary: unknown, startIso: unknown) {
  const seed = `${userId}::${String(summary || '').toLowerCase().trim()}::${startIso}`;
  const rawHash = crypto.createHash('sha256').update(seed).digest('hex');
  return `hermes${rawHash.slice(0, 26)}`;
}

/**
 * List events from user's primary Google Calendar.
 *
 * @param {string} userId
 * @param {object} [options]
 * @param {string|Date} [options.timeMin] - ISO string or Date (default: now)
 * @param {string|Date} [options.timeMax] - ISO string or Date
 * @param {number} [options.maxResults=15]
 * @param {string} [options.timezone='America/Bogota']
 * @param {string} [options.q] - Free-text search term
 * @returns {Promise<Array<object>>} List of events
 */
async function listCalendarEvents(userId: string | undefined, {
  timeMin = new Date(),
  timeMax = null,
  maxResults = 15,
  timezone = 'America/Bogota',
  q = null,
}: CalendarListOptions = {}) {
  const auth = await getAuthenticatedGoogleClient(userId);
  if (!auth) throw googleAuthRequiredError();

  try {
    const calendar = getCalendar(auth);

    const minIso = timeMin instanceof Date ? timeMin.toISOString() : new Date(timeMin).toISOString();
    const params: Record<string, unknown> = {
      calendarId: 'primary',
      timeMin: minIso,
      maxResults: Math.min(Math.max(1, maxResults), 50),
      singleEvents: true,
      orderBy: 'startTime',
      timeZone: timezone,
    };

    if (timeMax) {
      params.timeMax = timeMax instanceof Date ? timeMax.toISOString() : new Date(timeMax).toISOString();
    }

    if (q && String(q).trim()) {
      params.q = String(q).trim();
    }

    const res = await calendar.events.list(params);
    const items = res.data.items || [];

    return items
      .filter(ev => ev.status !== 'cancelled')
      .map(ev => ({
        id: ev.id,
        summary: ev.summary || '(Sin título)',
        description: ev.description || '',
        start: ev.start?.dateTime || ev.start?.date,
        end: ev.end?.dateTime || ev.end?.date,
        isAllDay: Boolean(ev.start?.date && !ev.start?.dateTime),
        rawStartDate: ev.start?.date || null,
        rawStartDateTime: ev.start?.dateTime || null,
        status: ev.status || 'confirmed',
        htmlLink: ev.htmlLink,
        hangoutLink: ev.hangoutLink || ev.conferenceData?.entryPoints?.[0]?.uri || null,
        location: ev.location || null,
        attendees: (ev.attendees || []).map(a => a.email),
      }));
  } catch (err) {
    await handleGoogleApiError(userId, 'list', err);
  }
}

function mapToGoogleRRule(recurrence: unknown) {
  if (!recurrence) return null;
  const normalized = String(recurrence).trim().toLowerCase();
  switch (normalized) {
    case 'yearly':
    case 'annual':
      return 'RRULE:FREQ=YEARLY';
    case 'monthly':
      return 'RRULE:FREQ=MONTHLY';
    case 'weekly':
      return 'RRULE:FREQ=WEEKLY';
    case 'daily':
      return 'RRULE:FREQ=DAILY';
    case 'weekdays':
      return 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
    default:
      return null;
  }
}

function computeNextDayIsoDate(dateString: unknown) {
  if (!dateString || typeof dateString !== 'string') return null;
  const parts = dateString.split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  const d = new Date(Date.UTC(parts[0]!, parts[1]! - 1, parts[2]! + 1));
  return [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, '0'),
    String(d.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

/**
 * Create a new event in user's primary Google Calendar.
 *
 * @param {string} userId
 * @param {object} params
 * @param {string} params.summary - Event title
 * @param {string} [params.description]
 * @param {string|Date} [params.startDateTime]
 * @param {string|Date} [params.endDateTime]
 * @param {string} [params.timezone='America/Bogota']
 * @param {boolean} [params.addGoogleMeet=false] - Whether to generate Google Meet link
 * @param {string|null} [params.customEventId=null]
 * @param {boolean} [params.allDay=false]
 * @param {string|null} [params.startDate=null] - ISO date YYYY-MM-DD for all-day events
 * @param {string|null} [params.endDate=null] - ISO date YYYY-MM-DD for all-day events
 * @param {string|null} [params.recurrence=null] - 'yearly' | 'monthly' | 'weekly' | 'daily' | 'weekdays'
 * @returns {Promise<object>} Created event details
 */
async function createCalendarEvent(userId: string | undefined, {
  summary,
  description = '',
  startDateTime,
  endDateTime = null,
  timezone = 'America/Bogota',
  addGoogleMeet = false,
  customEventId = null,
  allDay = false,
  startDate = null,
  endDate = null,
  recurrence = null,
}: CalendarWriteInput) {
  const auth = await getAuthenticatedGoogleClient(userId);
  if (!auth) throw googleAuthRequiredError();

  try {
    const calendar = getCalendar(auth);

    const isEventAllDay = Boolean(allDay || (startDate && !startDateTime));
    let startObj;
    let endObj;
    let seedTime;

    if (isEventAllDay) {
      let startIsoDate = startDate;
      if (!startIsoDate && startDateTime) {
        const d = startDateTime instanceof Date ? startDateTime : new Date(startDateTime as string);
        startIsoDate = !Number.isNaN(d.getTime()) ? d.toISOString().split('T')[0]! : null;
      }
      if (!startIsoDate) {
        throw new Error('All-day event requires a valid date (YYYY-MM-DD)');
      }
      const endIsoDate = endDate || computeNextDayIsoDate(startIsoDate) || startIsoDate;
      startObj = { date: startIsoDate };
      endObj = { date: endIsoDate };
      seedTime = startIsoDate;
    } else {
      const startDateVal = startDateTime instanceof Date ? startDateTime : new Date(startDateTime as string);
      const endDateVal = endDateTime
        ? (endDateTime instanceof Date ? endDateTime : new Date(endDateTime as string))
        : new Date(startDateVal.getTime() + 60 * 60 * 1000);
      startObj = {
        dateTime: startDateVal.toISOString(),
        timeZone: timezone,
      };
      endObj = {
        dateTime: endDateVal.toISOString(),
        timeZone: timezone,
      };
      seedTime = startDateVal.toISOString();
    }

    const eventId = customEventId || generateDeterministicCalendarEventId(userId, summary, seedTime);

    const eventResource: GoogleEvent = {
      id: eventId,
      summary: summary!.trim(),
      description: description ? description.trim() : 'Agendado por Hermes TempleLabs',
      start: startObj,
      end: endObj,
    };

    const rrule = mapToGoogleRRule(recurrence);
    if (rrule) {
      eventResource.recurrence = [rrule];
    }

    const requestParams: Record<string, unknown> = {
      calendarId: 'primary',
      requestBody: eventResource,
    };

    if (addGoogleMeet) {
      eventResource.conferenceData = {
        createRequest: {
          requestId: `meet_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      };
      requestParams.conferenceDataVersion = 1;
    }

    let ev;
    try {
      const res = await calendar.events.insert(requestParams);
      ev = res.data;
    } catch (insertErr) {
      // If event with deterministic ID already exists (409 Conflict), retrieve existing event idempotently
      if ((insertErr as GoogleApiError).code === 409 || (insertErr as GoogleApiError).status === 409 || (insertErr as GoogleApiError).message?.includes('already exists')) {
        logger.log(`[googleCalendar] Event ${eventId} already exists (409 Conflict), retrieving existing event.`);
        const existingRes = await calendar.events.get({
          calendarId: 'primary',
          eventId,
        });
        ev = existingRes.data;
      } else {
        throw insertErr;
      }
    }

    const meetLink = ev.hangoutLink || ev.conferenceData?.entryPoints?.[0]?.uri || null;

    logger.log(`[googleCalendar] Handled event "${summary}" (${ev.id}) for user ${userId}`);

    return {
      id: ev.id,
      summary: ev.summary,
      start: ev.start?.dateTime || ev.start?.date,
      end: ev.end?.dateTime || ev.end?.date,
      isAllDay: Boolean(ev.start?.date && !ev.start?.dateTime),
      htmlLink: ev.htmlLink,
      meetLink,
    };
  } catch (err) {
    await handleGoogleApiError(userId, 'create', err);
  }
}

/**
 * Update an existing event in user's primary Google Calendar.
 *
 * @param {string} userId
 * @param {object} params
 * @param {string} params.eventId
 * @param {string} [params.summary]
 * @param {string} [params.description]
 * @param {string|Date} [params.startDateTime]
 * @param {string|Date} [params.endDateTime]
 * @param {string} [params.timezone='America/Bogota']
 * @returns {Promise<object>}
 */
function isValidCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

async function updateCalendarEvent(userId: string | undefined, {
  eventId,
  summary,
  description,
  startDateTime,
  endDateTime = null,
  timezone = 'America/Bogota',
  allDay = false,
  startDate = null,
  endDate = null,
  recurrence = null,
  clearRecurrence = false,
  durationMinutes = undefined,
}: CalendarWriteInput) {
  const auth = await getAuthenticatedGoogleClient(userId);
  if (!auth) throw googleAuthRequiredError();

  try {
    const calendar = getCalendar(auth);
    const existing = await calendar.events.get({
      calendarId: 'primary',
      eventId,
    });

    const eventResource: GoogleEvent = { ...existing.data };
    const existingStartIsAllDay = Boolean(eventResource.start?.date && !eventResource.start?.dateTime);
    const requiresAllDayEndOnly = Boolean(endDate && !startDate && !startDateTime);
    if (requiresAllDayEndOnly && !existingStartIsAllDay) {
      const error: Error & { code?: string } = new Error('An all-day end date cannot be applied to a timed event without an all-day start date.');
      error.code = 'INCOMPATIBLE_CALENDAR_PATCH';
      throw error;
    }
    if (allDay && !startDate && !existingStartIsAllDay) {
      const error: Error & { code?: string } = new Error('An all-day update requires an explicit all-day start date.');
      error.code = 'INCOMPATIBLE_CALENDAR_PATCH';
      throw error;
    }
    if (durationMinutes !== undefined && !eventResource.start?.dateTime && !startDateTime) {
      const error: Error & { code?: string } = new Error('A duration cannot be applied to an all-day event.');
      error.code = 'UNSUPPORTED_CALENDAR_DURATION';
      throw error;
    }
    if (summary !== undefined) eventResource.summary = summary.trim();
    if (description !== undefined) eventResource.description = description === null ? '' : String(description).trim();

    const isEventAllDay = Boolean(allDay || startDate || requiresAllDayEndOnly);
    if (isEventAllDay) {
      const startIso = startDate || (startDateTime ? new Date(startDateTime as string).toISOString().split('T')[0]! : eventResource.start?.date);
      const endIso = endDate || computeNextDayIsoDate(startIso) || startIso;
      if (!isValidCalendarDate(startIso) || !isValidCalendarDate(endIso) || endIso <= startIso) {
        const error: Error & { code?: string } = new Error('The all-day event end date must be after its start date.');
        error.code = 'INVALID_CALENDAR_INTERVAL';
        throw error;
      }
      eventResource.start = { date: startIso };
      eventResource.end = { date: endIso };
    } else if (startDateTime || endDateTime || durationMinutes !== undefined) {
      const existingStart = eventResource.start?.dateTime ? new Date(eventResource.start.dateTime) : null;
      const existingEnd = eventResource.end?.dateTime ? new Date(eventResource.end.dateTime) : null;
      const startDateVal = startDateTime
        ? (startDateTime instanceof Date ? startDateTime : new Date(startDateTime as string))
        : existingStart;
      if (startDateVal && Number.isNaN(startDateVal.getTime())) {
        const error: Error & { code?: string } = new Error('The timed event start must be a valid date.');
        error.code = 'INVALID_CALENDAR_INTERVAL';
        throw error;
      }
      if (durationMinutes !== undefined && !startDateVal) {
        const error: Error & { code?: string } = new Error('A duration update requires a valid event start.');
        error.code = 'INVALID_CALENDAR_INTERVAL';
        throw error;
      }
      if (startDateVal && startDateTime) {
        eventResource.start = { dateTime: startDateVal.toISOString(), timeZone: timezone };
      }
      if (endDateTime) {
        const endDateVal = endDateTime instanceof Date ? endDateTime : new Date(endDateTime as string);
        if (Number.isNaN(endDateVal.getTime()) || !startDateVal || Number.isNaN(startDateVal.getTime()) || endDateVal.getTime() <= startDateVal.getTime()) {
          const error: Error & { code?: string } = new Error('The timed event end must be after its start.');
          error.code = 'INVALID_CALENDAR_INTERVAL';
          throw error;
        }
        eventResource.end = { dateTime: endDateVal.toISOString(), timeZone: timezone };
      } else if (durationMinutes !== undefined && startDateVal) {
        if (!Number.isFinite(Number(durationMinutes)) || Number(durationMinutes) <= 0) {
          const error: Error & { code?: string } = new Error('The event duration must be positive.');
          error.code = 'INVALID_CALENDAR_INTERVAL';
          throw error;
        }
        eventResource.end = {
          dateTime: new Date(startDateVal.getTime() + Number(durationMinutes) * 60 * 1000).toISOString(),
          timeZone: timezone,
        };
      } else if (startDateTime && startDateVal) {
        const duration = existingStart && existingEnd
          ? existingEnd.getTime() - existingStart.getTime()
          : 60 * 60 * 1000;
        if (!Number.isFinite(duration) || duration <= 0) {
          const error: Error & { code?: string } = new Error('The fetched event has an invalid start/end interval.');
          error.code = 'INVALID_CALENDAR_INTERVAL';
          throw error;
        }
        eventResource.end = {
          dateTime: new Date(startDateVal.getTime() + duration).toISOString(),
          timeZone: timezone,
        };
      }
    }

    if (clearRecurrence) {
      delete eventResource.recurrence;
    } else if (recurrence !== null && recurrence !== undefined) {
      const rrule = mapToGoogleRRule(recurrence);
      if (rrule) {
        eventResource.recurrence = [rrule];
      }
    }

    const res = await calendar.events.update({
      calendarId: 'primary',
      eventId,
      requestBody: eventResource,
    });

    return {
      id: res.data.id,
      summary: res.data.summary,
      start: res.data.start?.dateTime || res.data.start?.date,
      end: res.data.end?.dateTime || res.data.end?.date,
      isAllDay: Boolean(res.data.start?.date && !res.data.start?.dateTime),
      htmlLink: res.data.htmlLink,
    };
  } catch (err) {
    await handleGoogleApiError(userId, 'update', err);
  }
}

/**
 * Check for conflicting events in a given time slot.
 *
 * @param {string} userId
 * @param {object} params
 * @param {string|Date} params.startDateTime
 * @param {string|Date} params.endDateTime
 * @param {string} [params.timezone='America/Bogota']
 * @returns {Promise<Array<object>>} Conflicting events (empty array if none or unavailable)
 */
async function findConflictingEvents(userId: string | undefined, {
  startDateTime,
  endDateTime,
  timezone = 'America/Bogota',
}: CalendarWriteInput) {
  const auth = await getAuthenticatedGoogleClient(userId);
  if (!auth) return null;

  try {
    const calendar = getCalendar(auth);
    const minIso = startDateTime instanceof Date ? startDateTime.toISOString() : new Date(startDateTime as string).toISOString();
    const maxIso = endDateTime instanceof Date ? endDateTime.toISOString() : new Date(endDateTime as string).toISOString();

    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: minIso,
      timeMax: maxIso,
      singleEvents: true,
      orderBy: 'startTime',
      timeZone: timezone,
    });

    return (res.data.items || []).map(ev => ({
      id: ev.id,
      summary: ev.summary || '(Sin título)',
      start: ev.start?.dateTime || ev.start?.date,
      end: ev.end?.dateTime || ev.end?.date,
    }));
  } catch (err) {
    if (isGoogleAuthError(err)) {
      await clearInvalidGoogleIntegration(userId, 'calendar-conflict-check');
    } else {
      logger.warn(`[googleCalendar] findConflictingEvents warning for user ${userId}:`, (err as GoogleApiError).message);
    }
    return [];
  }
}

/**
 * Delete an event from primary Google Calendar.
 *
 * @param {string} userId
 * @param {string} eventId
 * @returns {Promise<boolean>}
 */
async function deleteCalendarEvent(userId: string | undefined, eventId: string) {
  const auth = await getAuthenticatedGoogleClient(userId);
  if (!auth) return false;

  try {
    const calendar = getCalendar(auth);
    await calendar.events.delete({
      calendarId: 'primary',
      eventId,
    });
    logger.log(`[googleCalendar] Deleted event ${eventId} for user ${userId}`);
    return true;
  } catch (err) {
    if (isGoogleAuthError(err)) {
      await clearInvalidGoogleIntegration(userId, 'calendar-delete');
    }
    logger.warn(`[googleCalendar] deleteCalendarEvent warning (${eventId}):`, (err as GoogleApiError).message);
    return false;
  }
}

/**
 * Setup a Google Calendar push notification watch channel.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} [params.webhookUrl]
 * @param {string} [params.channelId]
 * @param {number} [params.ttlSeconds=604800] 7 days default
 * @returns {Promise<{channelId: string, resourceId: string, expiration: number}|null>}
 */
async function setupGoogleCalendarWatch({
  userId,
  webhookUrl = null,
  channelId = null,
  ttlSeconds = 604800,
}: WatchInput) {
  const auth = await getAuthenticatedGoogleClient(userId);
  if (!auth) return null;

  const appBaseUrl = (getEnv().APP_BASE_URL || 'https://hermes.templelabs.co').replace(/\/$/, '');
  const targetAddress = webhookUrl || `${appBaseUrl}/webhooks/google-calendar`;
  const targetChannelId = channelId || crypto.randomUUID();

  // Enforce single active watch channel: stop previous channel if registered in metadata
  try {
    const existingIntegration = await getUserIntegration(userId, 'google');
    const oldChannelId = existingIntegration?.metadata?.channelId;
    const oldResourceId = existingIntegration?.metadata?.resourceId;
    if (oldChannelId && oldResourceId && oldChannelId !== targetChannelId) {
      logger.log(`[googleCalendar] Stopping previous watch channel before establishing new one for user ${userId}: channel=${oldChannelId}`);
      await stopGoogleCalendarWatch({ userId, channelId: oldChannelId, resourceId: oldResourceId }).catch((stopErr) => {
        logger.warn(`[googleCalendar] Failed to stop previous watch channel ${oldChannelId}:`, (stopErr as GoogleApiError).message);
      });
    }
  } catch (err) {
    logger.warn(`[googleCalendar] Warning checking existing watch for user ${userId}:`, (err as GoogleApiError).message);
  }

  try {
    const calendar = getCalendar(auth);
    const res = await calendar.events.watch({
      calendarId: 'primary',
      requestBody: {
        id: targetChannelId,
        type: 'web_hook',
        address: targetAddress,
        token: `userId=${userId}`,
        params: {
          ttl: String(ttlSeconds),
        },
      },
    });

    const resourceId = res.data.resourceId;
    const expiration = Number(res.data.expiration);

    await updateUserIntegrationMetadata(userId, 'google', {
      channelId: targetChannelId,
      resourceId,
      channelExpiration: expiration,
      channelAddress: targetAddress,
      lastWatchedAt: new Date().toISOString(),
    }).catch((metaErr) => {
      logger.warn(`[googleCalendar] Failed to update watch metadata for user ${userId}:`, (metaErr as GoogleApiError).message);
    });

    logger.log(`[googleCalendar] Watch established for user ${userId}: channel=${targetChannelId} expiration=${new Date(expiration).toISOString()}`);
    return {
      channelId: targetChannelId,
      resourceId,
      expiration,
    };
  } catch (err) {
    if (isGoogleAuthError(err)) {
      await clearInvalidGoogleIntegration(userId, 'calendar-watch');
    }
    logger.error(`[googleCalendar] setupGoogleCalendarWatch error for user ${userId}:`, (err as GoogleApiError).message);
    throw err;
  }
}

/**
 * Stop an existing Google Calendar push notification channel.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.channelId
 * @param {string} params.resourceId
 * @returns {Promise<boolean>}
 */
async function stopGoogleCalendarWatch({ userId, channelId, resourceId }: WatchInput) {
  if (!userId || !channelId || !resourceId) return false;

  const auth = await getAuthenticatedGoogleClient(userId);
  if (!auth) return false;

  try {
    const calendar = getCalendar(auth);
    await calendar.channels.stop({
      requestBody: {
        id: channelId,
        resourceId,
      },
    });

    // Only clear channelId/resourceId in metadata if the channel being stopped
    // is the CURRENT active channel in the user's metadata.
    // When stopping an obsolete/zombie channel, we must NOT clear the active channel!
    const current = await getUserIntegration(userId, 'google');
    if (current?.metadata?.channelId === channelId) {
      await updateUserIntegrationMetadata(userId, 'google', {
        channelId: null,
        resourceId: null,
        channelExpiration: null,
      }).catch(() => {});
    }

    logger.log(`[googleCalendar] Watch stopped for user ${userId}: channel=${channelId}`);
    return true;
  } catch (err) {
    if (isGoogleAuthError(err)) {
      await clearInvalidGoogleIntegration(userId, 'calendar-stop-watch');
    }
    logger.warn(`[googleCalendar] stopGoogleCalendarWatch warning for user ${userId}:`, (err as GoogleApiError).message);
    return false;
  }
}

/**
 * Fetch incremental event changes using syncToken, recovering automatically from 410 Gone.
 *
 * @param {string} userId
 * @param {object} [options]
 * @param {string|null} [options.syncToken]
 * @param {string} [options.timezone=dependencies.DEFAULT_TIMEZONE]
 * @param {Date|string} [options.timeMin]
 * @param {Date|string} [options.timeMax]
 * @returns {Promise<{items: Array<object>, nextSyncToken: string|null, fullSync: boolean}|null>}
 */
async function listIncrementalCalendarEvents(userId: string | undefined, {
  syncToken = null,
  timezone = dependencies.DEFAULT_TIMEZONE,
  timeMin = null,
  timeMax = null,
}: CalendarDeltaOptions = {}) {
  const auth = await getAuthenticatedGoogleClient(userId);
  if (!auth) return null;

  const calendar = getCalendar(auth);

  if (syncToken) {
    try {
      const items: GoogleEvent[] = [];
      let pageToken: string | null = null;
      let nextSyncToken: string | null = null;

      do {
        const params: Record<string, unknown> = {
          calendarId: 'primary',
          syncToken,
          singleEvents: true,
          timeZone: timezone,
        };
        if (pageToken) params.pageToken = pageToken;

        const res = await calendar.events.list(params);
        items.push(...(res.data.items || []));
        pageToken = res.data.nextPageToken || null;
        nextSyncToken = res.data.nextSyncToken || nextSyncToken;
      } while (pageToken);

      return {
        items,
        nextSyncToken,
        fullSync: false,
      };
    } catch (err) {
      if ((err as GoogleApiError).code === 410 || String((err as GoogleApiError)?.message || '').includes('Sync token is no longer valid')) {
        logger.warn(`[googleCalendar] Sync token expired (410) for user ${userId}; performing full sync recovery.`);
      } else {
        if (isGoogleAuthError(err)) {
          await clearInvalidGoogleIntegration(userId, 'calendar-sync');
        }
        throw err;
      }
    }
  }

  // Full sync fallback
  // Google Calendar API invariant: timeMax and orderBy are mutually exclusive with sync tokens.
  // When timeMax or orderBy is present, Google never emits nextSyncToken.
  const now = new Date();
  const minIso = timeMin ? (timeMin instanceof Date ? timeMin.toISOString() : new Date(timeMin).toISOString()) : now.toISOString();

  const items: GoogleEvent[] = [];
  let pageToken: string | null = null;
  let nextSyncToken: string | null = null;

  do {
    const params: Record<string, unknown> = {
      calendarId: 'primary',
      singleEvents: true,
      timeZone: timezone,
      maxResults: 250,
    };
    if (minIso) params.timeMin = minIso;
    if (pageToken) params.pageToken = pageToken;

    const res = await calendar.events.list(params);
    items.push(...(res.data.items || []));
    pageToken = res.data.nextPageToken || null;
    nextSyncToken = res.data.nextSyncToken || nextSyncToken;
  } while (pageToken);

  return {
    items,
    nextSyncToken,
    fullSync: true,
  };
}

return { normalizeCalendarEvent, generateDeterministicCalendarEventId, listCalendarEvents, mapToGoogleRRule, createCalendarEvent, updateCalendarEvent, findConflictingEvents, deleteCalendarEvent, setupGoogleCalendarWatch, stopGoogleCalendarWatch, listIncrementalCalendarEvents };
}

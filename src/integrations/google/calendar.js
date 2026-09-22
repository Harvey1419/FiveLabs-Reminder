import crypto from 'crypto';
import { google } from 'googleapis';
import {
  clearInvalidGoogleIntegration,
  isGoogleAuthError,
  getAuthenticatedGoogleClient,
} from './auth.js';
import { updateUserIntegrationMetadata } from '../../infrastructure/database/integrations.js';
import {
  formatLocalDateTime,
  formatHumanFriendlyDateTime,
  zonedTimeToUtc,
  DEFAULT_TIMEZONE,
} from '../../shared/time.js';

async function handleGoogleApiError(userId, operation, err) {
  if (isGoogleAuthError(err)) {
    console.warn(`[googleCalendar] ${operation} auth error for user ${userId}:`, err.message);
    await clearInvalidGoogleIntegration(userId, `calendar-${operation}`);
  } else {
    console.error(`[googleCalendar] ${operation} error for user ${userId}:`, err.message);
  }

  throw err;
}

function googleAuthRequiredError() {
  const error = new Error('Google Calendar authentication is required.');
  error.code = 'GOOGLE_AUTH_REQUIRED';
  return error;
}

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
export function generateDeterministicCalendarEventId(userId, summary, startIso) {
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
export async function listCalendarEvents(userId, {
  timeMin = new Date(),
  timeMax = null,
  maxResults = 15,
  timezone = 'America/Bogota',
  q = null,
} = {}) {
  const auth = await getAuthenticatedGoogleClient(userId);
  if (!auth) throw googleAuthRequiredError();

  try {
    const calendar = google.calendar({ version: 'v3', auth });

    const minIso = timeMin instanceof Date ? timeMin.toISOString() : new Date(timeMin).toISOString();
    const params = {
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

export function mapToGoogleRRule(recurrence) {
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

function computeNextDayIsoDate(dateString) {
  if (!dateString || typeof dateString !== 'string') return null;
  const parts = dateString.split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + 1));
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
export async function createCalendarEvent(userId, {
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
}) {
  const auth = await getAuthenticatedGoogleClient(userId);
  if (!auth) throw googleAuthRequiredError();

  try {
    const calendar = google.calendar({ version: 'v3', auth });

    const isEventAllDay = Boolean(allDay || (startDate && !startDateTime));
    let startObj;
    let endObj;
    let seedTime;

    if (isEventAllDay) {
      let startIsoDate = startDate;
      if (!startIsoDate && startDateTime) {
        const d = startDateTime instanceof Date ? startDateTime : new Date(startDateTime);
        startIsoDate = !Number.isNaN(d.getTime()) ? d.toISOString().split('T')[0] : null;
      }
      if (!startIsoDate) {
        throw new Error('All-day event requires a valid date (YYYY-MM-DD)');
      }
      const endIsoDate = endDate || computeNextDayIsoDate(startIsoDate) || startIsoDate;
      startObj = { date: startIsoDate };
      endObj = { date: endIsoDate };
      seedTime = startIsoDate;
    } else {
      const startDateVal = startDateTime instanceof Date ? startDateTime : new Date(startDateTime);
      const endDateVal = endDateTime
        ? (endDateTime instanceof Date ? endDateTime : new Date(endDateTime))
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

    const eventResource = {
      id: eventId,
      summary: summary.trim(),
      description: description ? description.trim() : 'Agendado por Hermes TempleLabs',
      start: startObj,
      end: endObj,
    };

    const rrule = mapToGoogleRRule(recurrence);
    if (rrule) {
      eventResource.recurrence = [rrule];
    }

    const requestParams = {
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
      if (insertErr.code === 409 || insertErr.status === 409 || insertErr.message?.includes('already exists')) {
        console.log(`[googleCalendar] Event ${eventId} already exists (409 Conflict), retrieving existing event.`);
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

    console.log(`[googleCalendar] Handled event "${summary}" (${ev.id}) for user ${userId}`);

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
export async function updateCalendarEvent(userId, {
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
}) {
  const auth = await getAuthenticatedGoogleClient(userId);
  if (!auth) throw googleAuthRequiredError();

  try {
    const calendar = google.calendar({ version: 'v3', auth });
    const existing = await calendar.events.get({
      calendarId: 'primary',
      eventId,
    });

    const eventResource = { ...existing.data };
    if (summary !== undefined) eventResource.summary = summary.trim();
    if (description !== undefined) eventResource.description = description.trim();

    const isEventAllDay = Boolean(allDay || startDate);
    if (isEventAllDay) {
      const startIso = startDate || (startDateTime ? new Date(startDateTime).toISOString().split('T')[0] : eventResource.start?.date);
      const endIso = endDate || computeNextDayIsoDate(startIso) || startIso;
      eventResource.start = { date: startIso };
      eventResource.end = { date: endIso };
    } else if (startDateTime) {
      const startDateVal = startDateTime instanceof Date ? startDateTime : new Date(startDateTime);
      eventResource.start = { dateTime: startDateVal.toISOString(), timeZone: timezone };
      const endDateVal = endDateTime
        ? (endDateTime instanceof Date ? endDateTime : new Date(endDateTime))
        : new Date(startDateVal.getTime() + 60 * 60 * 1000);
      eventResource.end = { dateTime: endDateVal.toISOString(), timeZone: timezone };
    }

    if (recurrence !== null && recurrence !== undefined) {
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
export async function findConflictingEvents(userId, {
  startDateTime,
  endDateTime,
  timezone = 'America/Bogota',
}) {
  const auth = await getAuthenticatedGoogleClient(userId);
  if (!auth) return null;

  try {
    const calendar = google.calendar({ version: 'v3', auth });
    const minIso = startDateTime instanceof Date ? startDateTime.toISOString() : new Date(startDateTime).toISOString();
    const maxIso = endDateTime instanceof Date ? endDateTime.toISOString() : new Date(endDateTime).toISOString();

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
      console.warn(`[googleCalendar] findConflictingEvents warning for user ${userId}:`, err.message);
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
export async function deleteCalendarEvent(userId, eventId) {
  const auth = await getAuthenticatedGoogleClient(userId);
  if (!auth) return false;

  try {
    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.delete({
      calendarId: 'primary',
      eventId,
    });
    console.log(`[googleCalendar] Deleted event ${eventId} for user ${userId}`);
    return true;
  } catch (err) {
    if (isGoogleAuthError(err)) {
      await clearInvalidGoogleIntegration(userId, 'calendar-delete');
    }
    console.warn(`[googleCalendar] deleteCalendarEvent warning (${eventId}):`, err.message);
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
export async function setupGoogleCalendarWatch({
  userId,
  webhookUrl = null,
  channelId = null,
  ttlSeconds = 604800,
}) {
  const auth = await getAuthenticatedGoogleClient(userId);
  if (!auth) return null;

  const appBaseUrl = (process.env.APP_BASE_URL || 'https://hermes.templelabs.co').replace(/\/$/, '');
  const targetAddress = webhookUrl || `${appBaseUrl}/webhooks/google-calendar`;
  const targetChannelId = channelId || crypto.randomUUID();

  try {
    const calendar = google.calendar({ version: 'v3', auth });
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
      console.warn(`[googleCalendar] Failed to update watch metadata for user ${userId}:`, metaErr.message);
    });

    console.log(`[googleCalendar] Watch established for user ${userId}: channel=${targetChannelId} expiration=${new Date(expiration).toISOString()}`);
    return {
      channelId: targetChannelId,
      resourceId,
      expiration,
    };
  } catch (err) {
    if (isGoogleAuthError(err)) {
      await clearInvalidGoogleIntegration(userId, 'calendar-watch');
    }
    console.error(`[googleCalendar] setupGoogleCalendarWatch error for user ${userId}:`, err.message);
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
export async function stopGoogleCalendarWatch({ userId, channelId, resourceId }) {
  if (!userId || !channelId || !resourceId) return false;

  const auth = await getAuthenticatedGoogleClient(userId);
  if (!auth) return false;

  try {
    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.channels.stop({
      requestBody: {
        id: channelId,
        resourceId,
      },
    });

    await updateUserIntegrationMetadata(userId, 'google', {
      channelId: null,
      resourceId: null,
      channelExpiration: null,
    }).catch(() => {});

    console.log(`[googleCalendar] Watch stopped for user ${userId}: channel=${channelId}`);
    return true;
  } catch (err) {
    if (isGoogleAuthError(err)) {
      await clearInvalidGoogleIntegration(userId, 'calendar-stop-watch');
    }
    console.warn(`[googleCalendar] stopGoogleCalendarWatch warning for user ${userId}:`, err.message);
    return false;
  }
}

/**
 * Fetch incremental event changes using syncToken, recovering automatically from 410 Gone.
 *
 * @param {string} userId
 * @param {object} [options]
 * @param {string|null} [options.syncToken]
 * @param {string} [options.timezone=DEFAULT_TIMEZONE]
 * @param {Date|string} [options.timeMin]
 * @param {Date|string} [options.timeMax]
 * @returns {Promise<{items: Array<object>, nextSyncToken: string|null, fullSync: boolean}|null>}
 */
export async function listIncrementalCalendarEvents(userId, {
  syncToken = null,
  timezone = DEFAULT_TIMEZONE,
  timeMin = null,
  timeMax = null,
} = {}) {
  const auth = await getAuthenticatedGoogleClient(userId);
  if (!auth) return null;

  const calendar = google.calendar({ version: 'v3', auth });

  if (syncToken) {
    try {
      const items = [];
      let pageToken = null;
      let nextSyncToken = null;

      do {
        const params = {
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
      if (err.code === 410 || String(err?.message || '').includes('Sync token is no longer valid')) {
        console.warn(`[googleCalendar] Sync token expired (410) for user ${userId}; performing full sync recovery.`);
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

  const items = [];
  let pageToken = null;
  let nextSyncToken = null;

  do {
    const params = {
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

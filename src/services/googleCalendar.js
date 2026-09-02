import { google } from 'googleapis';
import { getAuthenticatedGoogleClient } from './googleAuth.js';

/**
 * List events from user's primary Google Calendar.
 *
 * @param {string} userId
 * @param {object} [options]
 * @param {string|Date} [options.timeMin] - ISO string or Date (default: now)
 * @param {string|Date} [options.timeMax] - ISO string or Date
 * @param {number} [options.maxResults=15]
 * @param {string} [options.timezone='America/Bogota']
 * @returns {Promise<Array<object>|null>} List of events, or null if Google is not connected
 */
export async function listCalendarEvents(userId, {
  timeMin = new Date(),
  timeMax = null,
  maxResults = 15,
  timezone = 'America/Bogota',
} = {}) {
  const auth = await getAuthenticatedGoogleClient(userId);
  if (!auth) return null;

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

    const res = await calendar.events.list(params);
    const items = res.data.items || [];

    return items.map(ev => ({
      id: ev.id,
      summary: ev.summary || '(Sin título)',
      description: ev.description || '',
      start: ev.start?.dateTime || ev.start?.date,
      end: ev.end?.dateTime || ev.end?.date,
      htmlLink: ev.htmlLink,
      hangoutLink: ev.hangoutLink || ev.conferenceData?.entryPoints?.[0]?.uri || null,
      location: ev.location || null,
      attendees: (ev.attendees || []).map(a => a.email),
    }));
  } catch (err) {
    console.error(`[googleCalendar] listCalendarEvents error for user ${userId}:`, err.message);
    throw err;
  }
}

/**
 * Create a new event in user's primary Google Calendar.
 *
 * @param {string} userId
 * @param {object} params
 * @param {string} params.summary - Event title
 * @param {string} [params.description]
 * @param {string|Date} params.startDateTime - Start ISO string
 * @param {string|Date} [params.endDateTime] - End ISO string (defaults to +1h)
 * @param {string} [params.timezone='America/Bogota']
 * @param {boolean} [params.addGoogleMeet=false] - Whether to generate Google Meet link
 * @returns {Promise<object|null>} Created event details, or null if Google is not connected
 */
export async function createCalendarEvent(userId, {
  summary,
  description = '',
  startDateTime,
  endDateTime = null,
  timezone = 'America/Bogota',
  addGoogleMeet = false,
}) {
  const auth = await getAuthenticatedGoogleClient(userId);
  if (!auth) return null;

  try {
    const calendar = google.calendar({ version: 'v3', auth });

    const startDate = startDateTime instanceof Date ? startDateTime : new Date(startDateTime);
    // If no end time, default to 1 hour after start
    const endDate = endDateTime
      ? (endDateTime instanceof Date ? endDateTime : new Date(endDateTime))
      : new Date(startDate.getTime() + 60 * 60 * 1000);

    const eventResource = {
      summary: summary.trim(),
      description: description ? description.trim() : 'Agendado por Hermes TempleLabs',
      start: {
        dateTime: startDate.toISOString(),
        timeZone: timezone,
      },
      end: {
        dateTime: endDate.toISOString(),
        timeZone: timezone,
      },
    };

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

    const res = await calendar.events.insert(requestParams);
    const ev = res.data;

    const meetLink = ev.hangoutLink || ev.conferenceData?.entryPoints?.[0]?.uri || null;

    console.log(`[googleCalendar] Created event "${summary}" (${ev.id}) for user ${userId}`);

    return {
      id: ev.id,
      summary: ev.summary,
      start: ev.start?.dateTime || ev.start?.date,
      end: ev.end?.dateTime || ev.end?.date,
      htmlLink: ev.htmlLink,
      meetLink,
    };
  } catch (err) {
    console.error(`[googleCalendar] createCalendarEvent error for user ${userId}:`, err.message);
    throw err;
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
 * @returns {Promise<Array<object>>} Conflicting events (empty array if none, null if not connected)
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
    console.warn(`[googleCalendar] findConflictingEvents error for user ${userId}:`, err.message);
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
    console.warn(`[googleCalendar] deleteCalendarEvent warning (${eventId}):`, err.message);
    return false;
  }
}

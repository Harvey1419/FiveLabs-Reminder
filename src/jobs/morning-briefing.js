import { supabase, getDailyOverview, getUserIntegration } from '../infrastructure/database/index.js';
import { sendReminderConfirmation, isWithin24HourWindow } from '../integrations/whatsapp/kapso-client.js';
import { hasUsableGoogleCredentials, isGoogleAuthError } from '../integrations/google/auth.js';
import { resolveCalendarTemporalScope } from '../shared/time.js';
import { listCalendarEvents, normalizeCalendarEvent } from '../integrations/google/calendar.js';
import { reconcileCalendarCompanionReminders } from '../features/calendar/reconciliation.js';
import { formatTaskNotesBadge } from '../shared/task-presentation.js';

const BRIEFING_CHECK_INTERVAL_MS = 60 * 1000; // Check every minute

/**
 * Atomically claim morning briefing dispatch for user using conditional update.
 * Prevents race conditions and duplicate deliveries across distributed worker replicas.
 *
 * @param {string} userId
 * @param {string} [timezone='America/Bogota']
 * @param {Date} [now=new Date()]
 * @returns {Promise<boolean>} true if claimed successfully, false if already claimed or failed
 */
export async function claimMorningBriefing(userId, timezone = 'America/Bogota', now = new Date()) {
  if (!userId) return false;
  try {
    const temporal = resolveCalendarTemporalScope({ scope: 'today' }, timezone, now);
    const todayStartIso = temporal.timeMin instanceof Date ? temporal.timeMin.toISOString() : new Date(temporal.timeMin).toISOString();
    const nowIso = now.toISOString();

    const { data, error } = await supabase
      .from('users')
      .update({ last_briefing_at: nowIso })
      .eq('id', userId)
      .or(`last_briefing_at.is.null,last_briefing_at.lt.${todayStartIso}`)
      .select('id');

    if (error) {
      console.error(`[morningBriefing] claim error for user ${userId}:`, error.message);
      return false;
    }

    return Array.isArray(data) && data.length > 0;
  } catch (err) {
    console.error(`[morningBriefing] unexpected claim error for user ${userId}:`, err.message);
    return false;
  }
}

export function startMorningBriefingWorker() {
  console.log('[morningBriefing] worker started (monitoring 6:00 AM local briefings)');

  setInterval(async () => {
    try {
      await checkAndDispatchBriefings();
    } catch (err) {
      console.error('[morningBriefing] error in cycle:', err);
    }
  }, BRIEFING_CHECK_INTERVAL_MS).unref();
}

async function checkAndDispatchBriefings() {
  const { data: users, error } = await supabase
    .from('users')
    .select('*')
    .eq('morning_briefing_enabled', true);

  if (error || !users || users.length === 0) return;

  const now = new Date();

  for (const user of users) {
    const tz = user.timezone || 'America/Bogota';

    // Get current local time for user (HH:mm)
    const timeFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
    const localTimeStr = timeFormatter.format(now); // e.g. "06:00"

    const targetTime = user.morning_briefing_time || '06:00';

    // Check if target minute matches
    if (localTimeStr === targetTime) {
      // Check if already dispatched today
      const todayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
      const todayStr = todayFormatter.format(now);

      if (user.last_briefing_at) {
        const lastDateStr = todayFormatter.format(new Date(user.last_briefing_at));
        if (lastDateStr === todayStr) {
          continue; // Already sent today
        }
      }

      // Cost & Anti-Spam Guard: Only dispatch morning briefing if user is active in 24h window
      const isUserActive = await isWithin24HourWindow(user.phone_number);
      if (!isUserActive) {
        console.log(`[morningBriefing] Skipping briefing for ${user.phone_number}: outside active 24h window.`);
        continue;
      }

      // Pillar 4: Distributed Worker Idempotency Atomic Claim
      const claimed = await claimMorningBriefing(user.id, tz, now);
      if (!claimed) {
        console.log(`[morningBriefing] Briefing for user ${user.id} already claimed by another worker.`);
        continue;
      }

      await dispatchBriefingForUser(user, todayStr, tz);
    }
  }
}

/**
 * Format a human-readable day header (e.g. "Martes, 1 de septiembre" or "Tuesday, September 1").
 */
export function formatBriefingDate(dateObj = new Date(), timezone = 'America/Bogota', isEnglish = false) {
  try {
    const locale = isEnglish ? 'en-US' : 'es-CO';
    const formatter = new Intl.DateTimeFormat(locale, {
      timeZone: timezone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });
    const formatted = formatter.format(dateObj);
    return formatted.charAt(0).toUpperCase() + formatted.slice(1);
  } catch {
    const todayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    return todayFormatter.format(dateObj);
  }
}

/**
 * Build rich, structured morning briefing message integrating Google Calendar, timed reminders, and open tasks.
 * Preserves canonical Google Calendar states (CONNECTED, DISCONNECTED, AUTH_REQUIRED, ERROR) without failing the briefing.
 *
 * @param {object} params
 * @param {object} params.overview
 * @param {object} [params.calendar={ state: 'DISCONNECTED', events: [] }]
 * @param {string} [params.timezone='America/Bogota']
 * @param {object} [params.user]
 * @param {string} [params.language]
 * @returns {string}
 */
export function formatMorningBriefingMessage({
  overview = {},
  calendar = { state: 'DISCONNECTED', events: [] },
  timezone = 'America/Bogota',
  user = null,
  language = null,
}) {
  const isEnglish = language === 'en' || (!language && Boolean(user?.locale?.startsWith('en')));
  const calendarEvents = (calendar && calendar.events) ? calendar.events : [];
  const rawTimedReminders = overview.timedRemindersToday || [];
  // Filter out gcal companion reminders if Google Calendar is connected to avoid redundant listings in briefing
  const timedReminders = calendar.state === 'CONNECTED'
    ? rawTimedReminders.filter(r => !(r.delivery_id?.startsWith('gcal:') || (r.content && r.content.startsWith('🔔 [Google Calendar]'))))
    : rawTimedReminders;
  const tasksDueToday = overview.tasksDueToday || [];
  const openTasksByEntity = overview.openTasksByEntity || {};
  const openTasksGeneral = overview.openTasksGeneral || [];

  const entityKeys = Object.keys(openTasksByEntity);
  const totalItems = calendarEvents.length + timedReminders.length + tasksDueToday.length + entityKeys.length + openTasksGeneral.length;
  const dateFormatted = formatBriefingDate(new Date(), timezone, isEnglish);

  if (totalItems === 0) {
    if (isEnglish) {
      let errorNote = '';
      if (calendar.state === 'ERROR') {
        errorNote = `\n\n_(Note: We could not check your Google Calendar due to a temporary outage)._`;
      } else if (calendar.state === 'AUTH_REQUIRED' || calendar.state === 'DISCONNECTED') {
        errorNote = `\n\n_(Note: Google Calendar connection is required to include your events)._`;
      }
      return (
        `🌅 *Good morning!* ☕\n\n` +
        `Today (*${dateFormatted}*) you have no scheduled appointments or pending tasks.${errorNote}\n\n` +
        `Have a productive and great day! 🚀`
      );
    }

    let errorNote = '';
    if (calendar.state === 'ERROR') {
      errorNote = `\n\n_(Nota: No pudimos consultar tu Google Calendar por una intermitencia temporal)._`;
    } else if (calendar.state === 'AUTH_REQUIRED' || calendar.state === 'DISCONNECTED') {
      errorNote = `\n\n_(Nota: Google Calendar necesita conexión para incluir tus eventos)._`;
    }
    return (
      `🌅 *¡Buenos días!* ☕\n\n` +
      `Hoy (*${dateFormatted}*) no tienes citas programadas ni tareas pendientes.${errorNote}\n\n` +
      `¡Que tengas una jornada productiva y excelente! 🚀`
    );
  }

  const sections = [];
  sections.push(
    isEnglish
      ? `🌅 *Good morning!* ☕\nHere is your daily overview for today (*${dateFormatted}*):`
      : `🌅 *¡Buenos días!* ☕\nAquí tienes tu panorama para hoy (*${dateFormatted}*):`
  );

  // 1. Google Calendar section (if connected and has events)
  if (calendar.state === 'CONNECTED' && calendarEvents.length > 0) {
    const lines = calendarEvents.map(ev => {
      const timeStr = ev.isAllDay ? (isEnglish ? 'All day' : 'Todo el día') : (ev.localStartTime || '');
      const timeDisplay = timeStr ? ` — ${timeStr}` : '';
      return `• 📅 *${ev.summary || (isEnglish ? 'Event' : 'Evento')}*${timeDisplay}`;
    });
    sections.push(
      isEnglish
        ? `📅 *Google Calendar Commitments:*\n${lines.join('\n')}`
        : `📅 *Compromisos en Google Calendar:*\n${lines.join('\n')}`
    );
  } else if (calendar.state === 'ERROR') {
    sections.push(
      isEnglish
        ? `📅 *Google Calendar:*\n⚠️ _(Temporarily unable to sync with Google Calendar)_`
        : `📅 *Google Calendar:*\n⚠️ _(No pudimos sincronizar con Google Calendar temporalmente)_`
    );
  } else if (calendar.state === 'AUTH_REQUIRED' || calendar.state === 'DISCONNECTED') {
    sections.push(
      isEnglish
        ? `📅 *Google Calendar:*\n🔐 _(Connection required to include your events)_`
        : `📅 *Google Calendar:*\n🔐 _(Necesita conexión para incluir tus eventos)_`
    );
  }

  // 2. Timed Reminders section (real scheduled alarms for today)
  if (timedReminders.length > 0) {
    const lines = timedReminders.map(r => {
      const rec = r.recurrenceRule ? (isEnglish ? ` _(Recurring)_` : ` _(Recurrente)_`) : '';
      return `• ⏰ *${r.localTime}* — ${r.content || r.title}${rec}`;
    });
    sections.push(
      isEnglish
        ? `⏰ *Scheduled Commitments:*\n${lines.join('\n')}`
        : `⏰ *Compromisos con hora fija:*\n${lines.join('\n')}`
    );
  }

  // 3. Tasks Due Today
  if (tasksDueToday.length > 0) {
    const lines = tasksDueToday.map(t => {
      const time = t.localTime ? (isEnglish ? ` _(before ${t.localTime})_` : ` _(antes de las ${t.localTime})_`) : '';
      const entity = t.entityName ? ` [${t.entityName}]` : '';
      const notesBadge = formatTaskNotesBadge(t, isEnglish);
      return `• 🎯 *${isEnglish ? 'Due today' : 'Vence hoy'}${time}:* ${t.title || t.content}${entity}${notesBadge}`;
    });
    sections.push(
      isEnglish
        ? `📌 *Tasks to Complete Today:*\n${lines.join('\n')}`
        : `📌 *Tareas para completar hoy:*\n${lines.join('\n')}`
    );
  }

  // 4. Open Tasks & Projects (no deadline/dateless)
  if (entityKeys.length > 0 || openTasksGeneral.length > 0) {
    const lines = [];

    for (const entityName of entityKeys) {
      const tasks = openTasksByEntity[entityName];
      lines.push(`📁 *${entityName}:*`);
      for (const t of tasks) {
        const notesBadge = formatTaskNotesBadge(t, isEnglish);
        lines.push(`▫️ ${t.title || t.content}${notesBadge}`);
      }
      lines.push('');
    }

    if (openTasksGeneral.length > 0) {
      if (entityKeys.length > 0) {
        lines.push(isEnglish ? `📋 *Other pending tasks:*` : `📋 *Otros pendientes:*`);
      }
      for (const t of openTasksGeneral) {
        const notesBadge = formatTaskNotesBadge(t, isEnglish);
        lines.push(`▫️ ${t.title || t.content}${notesBadge}`);
      }
    }

    const title = timedReminders.length === 0 && tasksDueToday.length === 0 && calendarEvents.length === 0
      ? (isEnglish ? `📋 *Your open tasks and pending items:*` : `📋 *Tus tareas y pendientes abiertos:*`)
      : (isEnglish ? `📋 *Ongoing tasks and projects:*` : `📋 *Tareas y proyectos en curso:*`);

    sections.push(`${title}\n${lines.join('\n').trim()}`);
  }

  // Footer tip
  sections.push(
    isEnglish
      ? `💡 *Executive tip:* If you want to assign a time to any task or mark it as done, just let me know. Let's make today count! 🎯`
      : `💡 *Tip ejecutivo:* Si quieres asignarle hora a algún pendiente o marcarlo como listo, solo dímelo. ¡Con toda hoy! 🎯`
  );

  return sections.join('\n\n');
}

export async function dispatchBriefingForUser(user, todayStr, timezone) {
  try {
    const language = user?.locale?.startsWith('en') ? 'en' : 'es';
    // Pillar 3: JIT Google Calendar Companion Reminders Reconciliation
    await reconcileCalendarCompanionReminders({
      userId: user.id,
      phoneNumber: user.phone_number,
      timezone,
    }).catch(err => {
      console.warn(`[morningBriefing] JIT calendar reconciliation warning for user ${user.id}:`, err.message);
    });

    const [overview, calendar] = await Promise.all([
      getDailyOverview({ userId: user.id, phoneNumber: user.phone_number, timezone }),
      (async () => {
        if (!user.id) return { state: 'DISCONNECTED', events: [] };
        const integration = await getUserIntegration(user.id, 'google');
        if (!hasUsableGoogleCredentials(integration)) {
          return { state: 'DISCONNECTED', events: [] };
        }
        try {
          const temporal = resolveCalendarTemporalScope({ scope: 'today' }, timezone);
          const rawEvents = await listCalendarEvents(user.id, {
            timeMin: temporal.timeMin,
            timeMax: temporal.timeMax,
            timezone,
            maxResults: 20,
          });
          const events = rawEvents.map(ev => normalizeCalendarEvent(ev, timezone));
          return { state: 'CONNECTED', events };
        } catch (err) {
          console.error(`[morningBriefing] calendar read error for user ${user.id}:`, err.message);
          return {
            state: isGoogleAuthError(err) ? 'AUTH_REQUIRED' : 'ERROR',
            error: err.message,
            events: [],
          };
        }
      })(),
    ]);

    const messageText = formatMorningBriefingMessage({ overview, calendar, timezone, user, language });

    const delivery = await sendReminderConfirmation(user.phone_number, messageText);
    if (!delivery?.success || !delivery?.messageId) {
      throw new Error(delivery?.error || 'Kapso did not accept the morning briefing.');
    }
    console.log(`[morningBriefing] sent morning briefing to ${user.phone_number}`);

    // Update last_briefing_at
    await supabase.from('users')
      .update({ last_briefing_at: new Date().toISOString() })
      .eq('id', user.id);

  } catch (err) {
    console.error(`[morningBriefing] failed to dispatch for user ${user.id}:`, err);
  }
}

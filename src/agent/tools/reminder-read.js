import { supabase } from '../../infrastructure/database/index.js';
import {
  formatHumanFriendlyDateTime,
  getDayBounds,
  resolveCalendarTemporalScope,
} from '../../shared/time.js';
import { parseReminderScope } from '../../shared/agenda-scopes.js';
import {
  buildReminderOwnerContext,
  scopeReminderQueryToOwner,
} from './reminder-owner.js';

function isVisiblePendingReminder(reminder) {
  if (!reminder || reminder.status !== 'pending') return false;
  // Companion reminders for Google Calendar events are internal delivery jobs;
  // they belong to the Calendar domain, never user-created reminders.
  if (reminder.delivery_id?.startsWith('gcal:') || reminder.content?.startsWith('🔔 [Google Calendar]')) {
    return false;
  }
  // For a recurring reminder, acknowledged_at describes the most recent
  // execution, while send_at points at the next execution. It therefore stays
  // visible as an active reminder after acknowledging a previous occurrence.
  return Boolean(reminder.recurrence_rule) || !reminder.acknowledged_at;
}

export async function executeReminderReadTool({
  params = {},
  user = null,
  language = 'es',
  referenceTime = null,
} = {}) {
  const owner = buildReminderOwnerContext(user);
  const { userId, phoneNumber } = owner;
  const timezone = user?.timezone || 'America/Bogota';
  const locale = user?.locale || (language === 'en' ? 'en-US' : 'es-CO');
  const reference = referenceTime instanceof Date ? referenceTime : new Date(referenceTime || Date.now());
  const now = Number.isNaN(reference.getTime()) ? new Date() : reference;
  const nowIso = now.toISOString();
  const rawInput = String(params.filter || params.scope || '').toLowerCase().trim();
  const parsedScope = parseReminderScope(rawInput, 'upcoming');
  const filter = parsedScope.scope;

  const todayBounds = getDayBounds('today', timezone);
  const todayStartIso = todayBounds.timeMin.toISOString();
  const todayEndIso = todayBounds.timeMax.toISOString();

  let query = scopeReminderQueryToOwner(supabase.from('reminders').select('*'), owner);
  if (!query) {
    return {
      success: false,
      action: 'missing_owner',
      errorCode: 'ACCESS_DENIED',
      error: language === 'en' ? 'I could not identify the reminder owner.' : 'No pude identificar al propietario de los recordatorios.',
    };
  }

  if (filter === 'completed_today') {
    query = query
      .not('acknowledged_at', 'is', null)
      .gte('acknowledged_at', todayStartIso)
      .lt('acknowledged_at', todayEndIso)
      .order('acknowledged_at', { ascending: true });
  } else if (filter === 'created_today') {
    query = query
      .neq('status', 'cancelled')
      .gte('created_at', todayStartIso)
      .lt('created_at', todayEndIso)
      .order('created_at', { ascending: true });
  } else if (filter === 'remaining_today') {
    query = query
      .eq('status', 'pending')
      .gte('send_at', nowIso)
      .lt('send_at', todayEndIso)
      .order('send_at', { ascending: true });
  } else if (filter === 'pending_today' || filter === 'today') {
    query = query
      .eq('status', 'pending')
      .gte('send_at', todayStartIso)
      .lt('send_at', todayEndIso)
      .order('send_at', { ascending: true });
  } else if (filter === 'upcoming' || filter === 'all_pending') {
    query = query
      .eq('status', 'pending')
      .gte('send_at', nowIso)
      .order('send_at', { ascending: true })
      .limit(50);
  } else {
    // Dynamic temporal scope (tomorrow, day_after_tomorrow, this_week, next_week, weekdays, explicit_date, etc.)
    const temporal = resolveCalendarTemporalScope({
      scope: parsedScope.scope,
      ...(parsedScope.date ? { date: parsedScope.date } : {}),
    }, timezone, now);

    const minIso = temporal.timeMin instanceof Date ? temporal.timeMin.toISOString() : String(temporal.timeMin);
    const maxIso = temporal.timeMax instanceof Date ? temporal.timeMax.toISOString() : String(temporal.timeMax);

    query = query
      .eq('status', 'pending')
      .gte('send_at', minIso)
      .lt('send_at', maxIso)
      .order('send_at', { ascending: true })
      .limit(50);
  }

  const { data, error } = await query;
  if (error) {
    console.error('[reminder-read] query failed:', error.message || error);
    return {
      success: false,
      action: 'database_error',
      errorCode: 'DATABASE_ERROR',
      error: language === 'en' ? 'I could not read your reminders.' : 'No pude consultar tus recordatorios.',
    };
  }

  let reminders = data || [];
  if (filter !== 'completed_today') {
    reminders = reminders.filter(isVisiblePendingReminder);
  }

  const items = reminders.map((reminder, index) => ({
    position: index + 1,
    type: 'reminder',
    internalId: reminder.id,
    summary: reminder.content || reminder.title,
    time: reminder.send_at ? formatHumanFriendlyDateTime(new Date(reminder.send_at), timezone, language) : null,
    source: 'reminder',
    raw: reminder,
  }));

  console.log(`[reminder-read] filter=${filter} count=${reminders.length} user=${userId || phoneNumber}`);

  return {
    success: true,
    action: 'listed_reminders',
    data: {
      reminders,
      items,
      filter,
      timezone,
      locale,
    },
    rawSummary: language === 'en' ? 'Reminders loaded.' : 'Recordatorios consultados.',
  };
}

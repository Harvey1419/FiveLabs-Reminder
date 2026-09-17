import { supabase } from '../../infrastructure/database/index.js';
import { formatHumanFriendlyDateTime, getDayBounds } from '../../shared/time.js';
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
  const rawFilter = String(params.filter || params.scope || '').toLowerCase().trim();
  const bounds = getDayBounds('today', timezone);
  const todayStartIso = bounds.timeMin.toISOString();
  const todayEndIso = bounds.timeMax.toISOString();

  let query = scopeReminderQueryToOwner(supabase.from('reminders').select('*'), owner);
  if (!query) {
    return {
      success: false,
      action: 'missing_owner',
      errorCode: 'ACCESS_DENIED',
      error: language === 'en' ? 'I could not identify the reminder owner.' : 'No pude identificar al propietario de los recordatorios.',
    };
  }

  let filter = 'upcoming';

  if (rawFilter === 'completed_today') {
    filter = 'completed_today';
    query = query
      .not('acknowledged_at', 'is', null)
      .gte('acknowledged_at', todayStartIso)
      .lt('acknowledged_at', todayEndIso)
      .order('acknowledged_at', { ascending: true });
  } else if (rawFilter === 'created_today') {
    filter = 'created_today';
    query = query
      .neq('status', 'cancelled')
      .gte('created_at', todayStartIso)
      .lt('created_at', todayEndIso)
      .order('created_at', { ascending: true });
  } else if (['remaining_today', 'pending_remaining_today', 'rest_of_today'].includes(rawFilter)) {
    filter = 'remaining_today';
    query = query
      .eq('status', 'pending')
      .gte('send_at', nowIso)
      .lt('send_at', todayEndIso)
      .order('send_at', { ascending: true });
  } else if (rawFilter === 'pending_today' || rawFilter === 'today') {
    filter = 'pending_today';
    query = query
      .eq('status', 'pending')
      .gte('send_at', todayStartIso)
      .lt('send_at', todayEndIso)
      .order('send_at', { ascending: true });
  } else {
    query = query
      .eq('status', 'pending')
      .gte('send_at', nowIso)
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
  if (['upcoming', 'remaining_today', 'pending_today'].includes(filter)) {
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

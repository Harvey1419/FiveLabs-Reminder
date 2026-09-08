import { supabase } from '../../infrastructure/database/index.js';
import { normalizePhoneNumber } from '../../integrations/whatsapp/kapso-client.js';
import { formatHumanFriendlyDateTime, getDayBounds } from '../../shared/time.js';

function ownerPhoneVariants(phoneNumber) {
  const clean = phoneNumber ? normalizePhoneNumber(phoneNumber) || phoneNumber : null;
  return Array.from(new Set([
    phoneNumber,
    clean,
    clean ? `+${clean}` : null,
  ].filter(Boolean)));
}

function isVisiblePendingReminder(reminder) {
  if (!reminder || reminder.status !== 'pending') return false;
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
  const userId = user?.id || null;
  const phoneNumber = user?.phone_number || null;
  const timezone = user?.timezone || 'America/Bogota';
  const locale = user?.locale || (language === 'en' ? 'en-US' : 'es-CO');
  const phones = ownerPhoneVariants(phoneNumber);
  const reference = referenceTime instanceof Date ? referenceTime : new Date(referenceTime || Date.now());
  const now = Number.isNaN(reference.getTime()) ? new Date() : reference;
  const nowIso = now.toISOString();
  const rawFilter = String(params.filter || params.type || params.scope || '').toLowerCase().trim();
  const bounds = getDayBounds('today', timezone);
  const todayStartIso = bounds.timeMin.toISOString();
  const todayEndIso = bounds.timeMax.toISOString();

  let query = supabase.from('reminders').select('*');
  if (userId && phones.length > 0) {
    const phoneConditions = phones.map((p) => `phone_number.eq.${p}`).join(',');
    query = query.or(`user_id.eq.${userId},${phoneConditions}`);
  } else if (userId) {
    query = query.eq('user_id', userId);
  } else if (phones.length > 0) {
    query = query.in('phone_number', phones);
  } else {
    return {
      success: false,
      action: 'missing_owner',
      errorCode: 'ACCESS_DENIED',
      error: language === 'en' ? 'I could not identify the reminder owner.' : 'No pude identificar al propietario de los recordatorios.',
    };
  }

  let filter = 'upcoming';

  if (rawFilter === 'completed_today' || params.status === 'completed') {
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

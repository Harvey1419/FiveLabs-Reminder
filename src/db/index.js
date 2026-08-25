import { createClient } from '@supabase/supabase-js';
import { formatLocalDateTime } from '../utils/time.js';

const supabaseUrl = process.env.SUPABASE_URL || 'https://placeholder.supabase.co';
const supabaseSecret = process.env.SUPABASE_SECRET || 'placeholder-secret';

const supabase = createClient(
  supabaseUrl,
  supabaseSecret,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);

export async function saveReminder({
  userId,
  phoneNumber,
  content,
  sendAt,
  taskId = null,
  recurrenceRule = null,
  requiresConfirmation = false,
  nudgeIntervalMinutes = 15,
  maxNudges = 5,
}) {
  const isPersistent = Boolean(requiresConfirmation);
  const insertPayload = {
    phone_number: phoneNumber,
    content,
    send_at: sendAt,
    recurrence_rule: recurrenceRule || null,
    status: 'pending',
    task_id: taskId || null,
    requires_confirmation: isPersistent,
    nudge_interval_minutes: isPersistent ? (Number(nudgeIntervalMinutes) || 15) : null,
    max_nudges: isPersistent ? (maxNudges !== undefined ? Number(maxNudges) : 5) : null,
    nudge_count: 0,
  };

  if (userId) {
    insertPayload.user_id = userId;
  }

  // Deduplication / Supersede guard:
  try {
    // 1. If an identical pending reminder already exists with exact same time, return it
    let checkQ = supabase
      .from('reminders')
      .select('*')
      .eq('status', 'pending')
      .eq('content', content)
      .eq('send_at', sendAt);

    if (userId) checkQ = checkQ.eq('user_id', userId);
    else checkQ = checkQ.eq('phone_number', phoneNumber);

    const { data: existing } = await checkQ.maybeSingle();
    if (existing) {
      console.log(`[reminders] Identical pending reminder already exists (${existing.id}), returning existing.`);
      return existing;
    }

    // 2. If creating a persistent reminder, cancel/supersede any older active unacknowledged nudge loop for the same content
    if (isPersistent) {
      let activeQ = supabase
        .from('reminders')
        .update({ status: 'cancelled', acknowledged_at: new Date().toISOString() })
        .eq('requires_confirmation', true)
        .is('acknowledged_at', null)
        .ilike('content', content.trim());

      if (userId) activeQ = activeQ.eq('user_id', userId);
      else activeQ = activeQ.eq('phone_number', phoneNumber);

      await activeQ;
    }
  } catch (err) {
    console.warn('[reminders] duplicate check warning:', err.message);
  }

  const { data, error } = await supabase
    .from('reminders')
    .insert(insertPayload)
    .select()
    .single();

  if (error) {
    // If remote DB schema hasn't run the ALTER TABLE yet, fallback to base columns
    if (error.message?.includes('column') && error.message?.includes('schema cache')) {
      const fallbackPayload = {
        phone_number: phoneNumber,
        content,
        send_at: sendAt,
        recurrence_rule: recurrenceRule || null,
        status: 'pending',
        task_id: taskId || null,
      };
      if (userId) fallbackPayload.user_id = userId;

      const { data: fallbackData, error: fallbackError } = await supabase
        .from('reminders')
        .insert(fallbackPayload)
        .select()
        .single();

      if (fallbackError) throw fallbackError;

      return {
        ...fallbackData,
        requires_confirmation: Boolean(requiresConfirmation),
        nudge_interval_minutes: Number(nudgeIntervalMinutes) || 15,
        max_nudges: maxNudges !== undefined ? Number(maxNudges) : 5,
        nudge_count: 0,
        acknowledged_at: null,
      };
    }

    throw error;
  }

  return data;
}

/**
 * Acknowledge pending confirmation reminders when user completes a task (e.g. "Listo", "OK").
 */
export async function acknowledgeReminders({ userId, phoneNumber, contentQuery = null }) {
  let q = supabase
    .from('reminders')
    .select('*');

  if (userId) {
    q = q.eq('user_id', userId);
  } else if (phoneNumber) {
    q = q.eq('phone_number', phoneNumber);
  }

  q = q.order('created_at', { ascending: false });
  const { data: list, error: fetchErr } = await q;

  if (fetchErr || !list || list.length === 0) {
    return { acknowledgedCount: 0, acknowledgedReminders: [] };
  }

  let candidates = list.filter(r => {
    // Check if acknowledged
    if (r.acknowledged_at) return false;
    // If requires_confirmation is present and false, only filter if explicitly false when column exists
    if (r.requires_confirmation === false) return false;
    return r.status === 'pending' || r.status === 'sent' || r.status === 'processing';
  });

  if (candidates.length === 0) {
    // Fallback to latest pending or sent reminders if column not present
    candidates = list.filter(r => r.status === 'pending' || r.status === 'sent').slice(0, 1);
  }

  if (contentQuery && typeof contentQuery === 'string') {
    const clean = contentQuery.toLowerCase().trim();
    const filtered = candidates.filter(r => r.content.toLowerCase().includes(clean));
    if (filtered.length > 0) candidates = filtered;
  }

  if (candidates.length === 0) {
    return { acknowledgedCount: 0, acknowledgedReminders: [] };
  }

  const ids = candidates.map(r => r.id);
  const ackTime = new Date().toISOString();

  try {
    const { error: updateErr } = await supabase
      .from('reminders')
      .update({ acknowledged_at: ackTime })
      .in('id', ids);

    if (updateErr && updateErr.message?.includes('column') && updateErr.message?.includes('schema cache')) {
      await supabase.from('reminders').update({ status: 'sent' }).in('id', ids);
    }

    // Auto-complete any linked tasks in tasks table
    const taskIds = candidates.filter(r => r.task_id).map(r => r.task_id);
    if (taskIds.length > 0) {
      await supabase
        .from('tasks')
        .update({
          status: 'completed',
          completed_at: ackTime,
          updated_at: ackTime,
        })
        .in('id', taskIds);
      console.log(`[tasks] Auto-completed ${taskIds.length} linked task(s) on reminder acknowledgement.`);
    }
  } catch (err) {
    console.warn('[reminders] acknowledge update error:', err);
  }

  console.log(`[reminders] Acknowledged ${ids.length} reminder(s) for user ${userId || phoneNumber}`);
  return {
    acknowledgedCount: ids.length,
    acknowledgedReminders: candidates.map(r => ({ ...r, acknowledged_at: ackTime })),
  };
}

/**
 * Find reminders that need an escalation nudge.
 */
export async function getRemindersDueForNudge() {
  const { data, error } = await supabase
    .from('reminders')
    .select('*')
    .eq('status', 'sent');

  if (error || !data) return [];

  const now = Date.now();
  return data.filter(r => {
    if (!r.requires_confirmation) return false;
    if (r.acknowledged_at) return false;

    const maxNudges = r.max_nudges ?? 5;
    const nudgeCount = r.nudge_count ?? 0;
    if (nudgeCount >= maxNudges) return false;

    const lastNudgeMs = r.last_nudged_at
      ? new Date(r.last_nudged_at).getTime()
      : (r.sent_at ? new Date(r.sent_at).getTime() : 0);

    if (!lastNudgeMs) return false;

    const intervalMs = (r.nudge_interval_minutes || 15) * 60 * 1000;
    return now >= (lastNudgeMs + intervalMs);
  });
}

/**
 * Increment nudge count and update last_nudged_at timestamp.
 */
export async function incrementReminderNudge(id, newCount) {
  try {
    const { data, error } = await supabase
      .from('reminders')
      .update({
        nudge_count: newCount,
        last_nudged_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      if (error.message?.includes('column') && error.message?.includes('schema cache')) {
        return { id, nudge_count: newCount, last_nudged_at: new Date().toISOString() };
      }
      throw error;
    }
    return data;
  } catch (err) {
    return { id, nudge_count: newCount, last_nudged_at: new Date().toISOString() };
  }
}

export async function getDueReminders() {
  const { data, error } = await supabase
    .from('reminders')
    .select('*')
    .eq('status', 'pending')
    .lte('send_at', new Date().toISOString());

  if (error) throw error;
  return data || [];
}

export async function markReminderAsSent(id) {
  const { error } = await supabase
    .from('reminders')
    .update({ status: 'sent', sent_at: new Date().toISOString() })
    .eq('id', id);

  if (error) throw error;
}

export async function markReminderAsFailed(id) {
  const { error } = await supabase
    .from('reminders')
    .update({ status: 'failed' })
    .eq('id', id);

  if (error) throw error;
}

export async function markReminderAsMissed(id) {
  const { error } = await supabase
    .from('reminders')
    .update({ status: 'missed' })
    .eq('id', id);

  if (error) throw error;
}

/**
 * Cancel pending reminders by criteria (all, keepLatest, content matching).
 */
export async function cancelReminders({ userId, phoneNumber, contentQuery = null, cancelAll = false, keepLatest = false }) {
  let q = supabase
    .from('reminders')
    .select('id, content, send_at, status')
    .eq('status', 'pending');

  if (userId) {
    q = q.eq('user_id', userId);
  } else if (phoneNumber) {
    q = q.eq('phone_number', phoneNumber);
  }

  q = q.order('created_at', { ascending: false });
  const { data: list, error: fetchErr } = await q;

  if (fetchErr || !list || list.length === 0) {
    return { cancelledCount: 0, cancelledReminders: [], remainingCount: 0 };
  }

  let toCancel = [];
  if (keepLatest) {
    toCancel = list.slice(1);
  } else if (cancelAll) {
    toCancel = list;
  } else if (contentQuery) {
    toCancel = list.filter(r => r.content.toLowerCase().includes(contentQuery.toLowerCase().trim()));
  } else {
    toCancel = list.slice(0, 1);
  }

  if (toCancel.length === 0) {
    return { cancelledCount: 0, cancelledReminders: [], remainingCount: list.length };
  }

  const ids = toCancel.map(r => r.id);
  const { error: delErr } = await supabase
    .from('reminders')
    .update({ status: 'cancelled' })
    .in('id', ids);

  if (delErr) {
    console.error('[reminders] cancelReminders failed:', delErr);
    return { cancelledCount: 0, cancelledReminders: [], remainingCount: list.length };
  }

  return {
    cancelledCount: ids.length,
    cancelledReminders: toCancel,
    remainingCount: list.length - ids.length,
  };
}

/**
 * Fetch rich daily overview formatted directly in the User's local timezone.
 */
export async function getDailyOverview({ userId, phoneNumber, timezone = 'America/Bogota' }) {
  let userRemindersQ = supabase.from('reminders').select('*');
  let userTasksQ = supabase.from('tasks').select('*');

  if (userId) {
    userRemindersQ = userRemindersQ.eq('user_id', userId);
    userTasksQ = userTasksQ.eq('user_id', userId);
  } else if (phoneNumber) {
    userRemindersQ = userRemindersQ.eq('phone_number', phoneNumber);
  }

  const [{ data: allReminders }, { data: allTasks }] = await Promise.all([
    userRemindersQ.order('send_at', { ascending: true }),
    userTasksQ.order('created_at', { ascending: false }),
  ]);

  const reminders = allReminders || [];
  const tasks = allTasks || [];

  const formatItem = (item, isDone = false) => {
    const rawDate = item.send_at || item.due_date || item.sent_at || item.completed_at;
    const dateObj = new Date(rawDate);
    const localFormatted = formatLocalDateTime(dateObj, timezone, 'es-CO');

    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const localDateStr = formatter.format(dateObj);

    const timeFormatter = new Intl.DateTimeFormat('es-CO', { timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true });
    const localTimeStr = timeFormatter.format(dateObj);

    return {
      id: item.id,
      content: item.content || item.title,
      localDate: localDateStr,
      localTime: localTimeStr,
      localFormatted,
      recurrenceRule: item.recurrence_rule || null,
      status: item.status,
    };
  };

  const todayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const now = new Date();
  const todayStr = todayFormatter.format(now);

  const tomorrowObj = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowStr = todayFormatter.format(tomorrowObj);

  const doneToday = [];
  const pendingToday = [];
  const tomorrow = [];
  const upcoming = [];

  for (const r of reminders) {
    if (r.status === 'sent') {
      const formatted = formatItem(r, true);
      if (formatted.localDate === todayStr) doneToday.push(formatted);
    } else if (r.status === 'pending' || r.status === 'processing') {
      const formatted = formatItem(r);
      if (formatted.localDate === todayStr) {
        pendingToday.push(formatted);
      } else if (formatted.localDate === tomorrowStr) {
        tomorrow.push(formatted);
      } else if (formatted.localDate > tomorrowStr) {
        upcoming.push(formatted);
      }
    }
  }

  for (const t of tasks) {
    if (t.status === 'completed') {
      const formatted = formatItem(t, true);
      if (formatted.localDate === todayStr) doneToday.push(formatted);
    } else if (t.status === 'pending') {
      const formatted = formatItem(t);
      if (!t.due_date || formatted.localDate === todayStr) {
        pendingToday.push(formatted);
      } else if (formatted.localDate === tomorrowStr) {
        tomorrow.push(formatted);
      } else if (formatted.localDate > tomorrowStr) {
        upcoming.push(formatted);
      }
    }
  }

  return {
    todayDate: todayStr,
    tomorrowDate: tomorrowStr,
    doneToday,
    pendingToday,
    tomorrow,
    upcoming,
  };
}

export async function getRecentRemindersForPhone(phoneNumber, limit = 10) {
  const safeLimit = Math.min(Math.max(1, Number(limit) || 10), 50);

  const { data, error } = await supabase
    .from('reminders')
    .select('content, send_at, recurrence_rule, status, created_at, sent_at')
    .eq('phone_number', phoneNumber)
    .order('created_at', { ascending: false })
    .limit(safeLimit);

  if (error) {
    console.error('getRecentRemindersForPhone failed:', error);
    return [];
  }
  return data || [];
}

/**
 * Claim the next due reminder atomically with FOR UPDATE SKIP LOCKED.
 */
export async function claimNextDueReminder() {
  const { data, error } = await supabase.rpc('claim_next_pending_reminder');
  if (error) {
    // Fallback if RPC not loaded
    const { data: fallback, error: fbErr } = await supabase
      .from('reminders')
      .select('*')
      .eq('status', 'pending')
      .lte('send_at', new Date().toISOString())
      .order('send_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (fbErr) throw fbErr;
    return fallback || null;
  }

  return data?.[0] || null;
}

/**
 * Peek at the earliest upcoming pending reminder for sleep calculation.
 */
export async function getNextPendingReminder() {
  const { data, error } = await supabase
    .from('reminders')
    .select('id, content, send_at, recurrence_rule, phone_number, status')
    .eq('status', 'pending')
    .order('send_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

export { supabase };
export * from './users.js';
export * from './tasks.js';
export * from './entities.js';
export * from './memories.js';

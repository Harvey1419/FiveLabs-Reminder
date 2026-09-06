import { createClient } from '@supabase/supabase-js';
import { formatLocalDateTime } from '../../shared/time.js';

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
  if (!userId && !phoneNumber) {
    return { acknowledgedCount: 0, acknowledgedReminders: [] };
  }

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
  } catch (err) {
    console.warn('[reminders] acknowledge update error:', err);
  }

  console.log(`[reminders] Acknowledged ${ids.length} reminder(s) for user ${userId || phoneNumber}`);
  return {
    acknowledgedCount: ids.length,
    acknowledgedReminders: candidates.map(r => ({ ...r, acknowledged_at: ackTime })),
  };
}

import { isStrictUUID } from '../../shared/entity-resolution.js';

/**
 * Acknowledge single reminder by its ID.
 */
export async function acknowledgeReminder(id, userId = null) {
  if (!id) return null;
  const ackTime = new Date().toISOString();
  try {
    let resolvedId = String(id).trim();
    if (!isStrictUUID(resolvedId)) {
      let q = supabase.from('reminders').select('id');
      if (userId) {
        q = q.eq('user_id', userId);
      }
      const { data: list } = await q.limit(100);
      const matched = list?.find(r => r.id.startsWith(resolvedId));
      if (matched) {
        resolvedId = matched.id;
      } else {
        return null;
      }
    }

    const { data, error } = await supabase
      .from('reminders')
      .update({ acknowledged_at: ackTime, status: 'sent' })
      .eq('id', resolvedId)
      .select()
      .maybeSingle();

    if (error) {
      console.warn('[reminders] acknowledgeReminder error:', error.message);
      return null;
    }
    return data;
  } catch (e) {
    console.warn('[reminders] acknowledgeReminder threw:', e.message);
    return null;
  }
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

/**
 * Get pending reminders by phone number or user ID.
 */
export async function getRemindersByPhone(phoneNumber, status = 'pending', limit = 20) {
  if (!phoneNumber) return [];
  const { data } = await supabase
    .from('reminders')
    .select('*')
    .eq('phone_number', phoneNumber)
    .eq('status', status)
    .order('send_at', { ascending: true })
    .limit(limit);
  return data || [];
}

export async function markReminderAsSent(id) {
  const { error } = await supabase
    .from('reminders')
    .update({ status: 'sent', sent_at: new Date().toISOString() })
    .eq('id', id);

  if (error) throw error;
}

export async function markReminderAsDispatched(id, { deliveryId } = {}) {
  const { error } = await supabase
    .from('reminders')
    .update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      delivery_id: deliveryId || null,
    })
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

export async function updateReminderDeliveryStatus({ deliveryId, deliveryStatus }) {
  if (!deliveryId || !deliveryStatus) return null;
  const normalizedStatus = String(deliveryStatus).toLowerCase();
  const allowed = new Set(['submitted', 'sent', 'delivered', 'read', 'failed']);
  if (!allowed.has(normalizedStatus)) return null;

  const updates = { status: normalizedStatus === 'failed' ? 'failed' : 'sent' };

  const { data, error } = await supabase
    .from('reminders')
    .update(updates)
    .eq('delivery_id', deliveryId)
    .select('id, status')
    .maybeSingle();
  if (error) {
    console.warn('[reminders] delivery status reconciliation failed:', error.message);
    return null;
  }
  return data || null;
}

export async function markReminderAsMissed(id) {
  const { error } = await supabase
    .from('reminders')
    .update({ status: 'missed' })
    .eq('id', id);

  if (error) throw error;
}

export async function markReminderAsCancelled(id, userId = null, phoneNumber = null) {
  if (!id) return false;
  try {
    let resolvedId = String(id).trim();
    if (!isStrictUUID(resolvedId)) {
      let lookupQ = supabase.from('reminders').select('id');
      if (userId) lookupQ = lookupQ.eq('user_id', userId);
      else if (phoneNumber) lookupQ = lookupQ.eq('phone_number', phoneNumber);
      const { data: rems } = await lookupQ.limit(50);
      const matched = (rems || []).find(r => r.id.startsWith(resolvedId.toLowerCase()));
      if (matched) resolvedId = matched.id;
      else return false;
    }

    let q = supabase
      .from('reminders')
      .update({ status: 'cancelled' })
      .eq('id', resolvedId);

    if (userId) {
      q = q.eq('user_id', userId);
    } else if (phoneNumber) {
      q = q.eq('phone_number', phoneNumber);
    }

    const { data, error } = await q.select('id');
    if (error || !data || data.length === 0) {
      if (error) console.error('[reminders] markReminderAsCancelled failed:', error);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[reminders] markReminderAsCancelled threw:', err);
    return false;
  }
}

/**
 * Update an existing reminder with user ownership guard and prefix-ID support.
 *
 * @param {string} reminderId - 36-char UUID or 8-char prefix
 * @param {object} updates - Fields to update (e.g. send_at, content, recurrence_rule, status)
 * @param {string} [userId] - User ID for ownership isolation
 * @param {string} [phoneNumber] - Fallback phone number
 * @returns {Promise<object|null>} Updated reminder object or null
 */
export async function updateReminder(reminderId, updates, userId = null, phoneNumber = null) {
  if (!reminderId || !updates) return null;
  try {
    let resolvedId = reminderId;
    if (!isStrictUUID(reminderId)) {
      let q = supabase.from('reminders').select('id');
      if (userId) {
        q = q.eq('user_id', userId);
      } else if (phoneNumber) {
        q = q.eq('phone_number', phoneNumber);
      }
      const { data: reminders } = await q;
      const matched = (reminders || []).find(r => r.id.startsWith(reminderId.toLowerCase()));
      if (matched) resolvedId = matched.id;
      else return null;
    }

    let q = supabase
      .from('reminders')
      .update(updates)
      .eq('id', resolvedId);

    if (userId) {
      q = q.eq('user_id', userId);
    } else if (phoneNumber) {
      q = q.eq('phone_number', phoneNumber);
    }

    const { data, error } = await q.select().limit(1);

    if (error) {
      console.error('[reminders] updateReminder failed:', error);
      return null;
    }

    return data && data.length > 0 ? data[0] : null;
  } catch (err) {
    console.error('[reminders] updateReminder threw:', err);
    return null;
  }
}

/**
 * Cancel pending reminders by criteria (all, keepLatest, content matching).
 */
export async function cancelReminders({ userId, phoneNumber, contentQuery = null, cancelAll = false, keepLatest = false }) {
  if (!userId && !phoneNumber) {
    return { cancelledCount: 0, cancelledReminders: [], remainingCount: 0 };
  }

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
  } else if (Array.isArray(contentQuery)) {
    const queries = contentQuery.map(q => String(q).toLowerCase().trim()).filter(Boolean);
    toCancel = list.filter(r => {
      const lower = r.content.toLowerCase();
      return queries.some(q => lower.includes(q));
    });
  } else if (typeof contentQuery === 'string' && contentQuery.trim()) {
    const raw = contentQuery.trim().toLowerCase();
    toCancel = list.filter(r => r.content.toLowerCase().includes(raw));
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

export const cancelPendingRemindersByContent = cancelReminders;

/**
 * Fetch rich daily overview formatted directly in the User's local timezone.
 */
export async function getDailyOverview({ userId, phoneNumber, timezone = 'America/Bogota' }) {
  if (!userId && !phoneNumber) {
    return {
      todayDate: '',
      tomorrowDate: '',
      doneToday: [],
      pendingToday: [],
      timedRemindersToday: [],
      tasksDueToday: [],
      openTasks: [],
      openTasksByEntity: {},
      openTasksGeneral: [],
      tomorrow: [],
      tomorrowReminders: [],
      tomorrowTasks: [],
      upcoming: [],
    };
  }

  let userRemindersQ = supabase.from('reminders').select('*');
  let userTasksQ = supabase.from('tasks').select('*, entities:entity_id(id, name, category)');

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
    // For reminders: scheduled date is send_at
    // For tasks: scheduled date is due_date
    // For completed: date is acknowledged_at / completed_at / sent_at
    // NEVER fall back to created_at or updated_at for an item's date or time!
    const rawDate = isDone
      ? (item.acknowledged_at || item.completed_at || item.sent_at || null)
      : (item.send_at || item.due_date || null);

    const isTask = !item.send_at && (item.title !== undefined || item.due_date !== undefined);
    const entityName = item.entities?.name || null;
    const entityCategory = item.entities?.category || null;

    if (!rawDate) {
      return {
        id: item.id,
        content: item.content || item.title,
        title: item.title || item.content,
        localDate: null,
        localTime: null,
        localFormatted: '(Sin fecha límite)',
        recurrenceRule: item.recurrence_rule || null,
        status: item.status,
        isTask,
        entityName,
        entityCategory,
      };
    }

    const dateObj = new Date(rawDate);
    const localFormatted = formatLocalDateTime(dateObj, timezone, 'es-CO');

    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const localDateStr = formatter.format(dateObj);

    const timeFormatter = new Intl.DateTimeFormat('es-CO', { timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true });
    const localTimeStr = timeFormatter.format(dateObj);

    return {
      id: item.id,
      content: item.content || item.title,
      title: item.title || item.content,
      localDate: localDateStr,
      localTime: localTimeStr,
      localFormatted,
      recurrenceRule: item.recurrence_rule || null,
      status: item.status,
      isTask,
      entityName,
      entityCategory,
    };
  };

  const todayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const now = new Date();
  const todayStr = todayFormatter.format(now);

  const tomorrowObj = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowStr = todayFormatter.format(tomorrowObj);

  const doneToday = [];
  const pendingConfirmationReminders = [];
  const timedRemindersToday = [];
  const tasksDueToday = [];
  const openTasks = [];
  const tomorrowReminders = [];
  const tomorrowTasks = [];
  const upcoming = [];

  for (const r of reminders) {
    // Active persistent reminders that require confirmation and are not yet acknowledged
    if (r.requires_confirmation && !r.acknowledged_at && (r.status === 'sent' || r.status === 'pending' || r.status === 'processing')) {
      const formatted = formatItem(r, false);
      formatted.nudgeCount = r.nudge_count || 0;
      formatted.maxNudges = r.max_nudges || 3;
      pendingConfirmationReminders.push(formatted);
    }

    if (r.acknowledged_at || (r.status === 'sent' && !r.requires_confirmation)) {
      const formatted = formatItem(r, true);
      if (formatted.localDate === todayStr || (!r.acknowledged_at && !r.sent_at)) {
        doneToday.push(formatted);
      }
    } else if (r.status === 'pending' || r.status === 'processing') {
      const formatted = formatItem(r);
      if (formatted.localDate === todayStr) {
        timedRemindersToday.push(formatted);
      } else if (formatted.localDate === tomorrowStr) {
        tomorrowReminders.push(formatted);
      } else if (formatted.localDate > tomorrowStr) {
        upcoming.push(formatted);
      }
    }
  }

  for (const t of tasks) {
    if (t.status === 'completed') {
      const formatted = formatItem(t, true);
      if (formatted.localDate === todayStr) {
        doneToday.push(formatted);
      }
    } else if (t.status === 'pending') {
      const formatted = formatItem(t);
      if (formatted.localDate === todayStr) {
        tasksDueToday.push(formatted);
      } else if (!t.due_date) {
        openTasks.push(formatted);
      } else if (formatted.localDate === tomorrowStr) {
        tomorrowTasks.push(formatted);
      } else if (formatted.localDate > tomorrowStr) {
        upcoming.push(formatted);
      }
    }
  }

  // Group open tasks by entity/project
  const openTasksByEntity = {};
  const openTasksGeneral = [];

  for (const task of openTasks) {
    const groupKey = task.entityName ? task.entityName.trim() : null;
    if (groupKey) {
      if (!openTasksByEntity[groupKey]) {
        openTasksByEntity[groupKey] = [];
      }
      openTasksByEntity[groupKey].push(task);
    } else {
      openTasksGeneral.push(task);
    }
  }

  const pendingToday = [...timedRemindersToday, ...tasksDueToday, ...openTasks];
  const tomorrow = [...tomorrowReminders, ...tomorrowTasks];

  return {
    todayDate: todayStr,
    tomorrowDate: tomorrowStr,
    doneToday,
    pendingConfirmationReminders,
    pendingToday,
    timedRemindersToday,
    tasksDueToday,
    openTasks,
    openTasksByEntity,
    openTasksGeneral,
    tomorrow,
    tomorrowReminders,
    tomorrowTasks,
    upcoming,
  };
}

export async function getRecentRemindersForPhone(phoneNumber, limit = 10) {
  if (!phoneNumber) return [];
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
 * Claim the next due reminder atomically with FOR UPDATE SKIP LOCKED or conditional lease locking.
 * Safe across multiple concurrent workers and server replicas.
 *
 * @param {string} [workerId='worker-1']
 * @param {number} [lockDurationSec=120]
 * @returns {Promise<object|null>}
 */
export async function claimNextDueReminder(workerId = 'worker-1', lockDurationSec = 120) {
  const nowIso = new Date().toISOString();
  const lockUntilIso = new Date(Date.now() + lockDurationSec * 1000).toISOString();

  // 1. Try native Postgres RPC function with FOR UPDATE SKIP LOCKED
  try {
    const { data, error } = await supabase.rpc('claim_next_pending_reminder', {
      p_worker_id: workerId,
      p_lock_duration_sec: lockDurationSec,
    });

    if (!error && data && data.length > 0) {
      return data[0];
    }
  } catch (rpcErr) {
    // Continue to atomic client fallback
  }

  // 2. Client-side Atomic Conditional Claim Fallback with Lease Recovery:
  // Select candidate due reminders (either pending or processing with expired lock_until)
  try {
    const { data: candidates, error: candErr } = await supabase
      .from('reminders')
      .select('*')
      .or(`status.eq.pending,and(status.eq.processing,lock_until.not.is.null,lock_until.lte.${nowIso})`)
      .lte('send_at', nowIso)
      .order('send_at', { ascending: true })
      .limit(10);

    if (candErr || !candidates || candidates.length === 0) {
      return null;
    }

    for (const candidate of candidates) {
      // Execute atomic conditional UPDATE:
      // If pending: match status = 'pending'
      // If processing: match status = 'processing' AND lock_until <= nowIso
      let updQuery = supabase
        .from('reminders')
        .update({
          status: 'processing',
          claimed_by: workerId,
          claimed_at: nowIso,
          lock_until: lockUntilIso,
        })
        .eq('id', candidate.id);

      if (candidate.status === 'pending') {
        updQuery = updQuery.eq('status', 'pending');
      } else {
        updQuery = updQuery.eq('status', 'processing').lte('lock_until', nowIso);
      }

      const { data: claimed, error: updErr } = await updQuery.select();

      // If update succeeded and returned the row, this worker won the atomic claim!
      if (!updErr && claimed && claimed.length > 0) {
        return claimed[0];
      }
    }
  } catch (fbErr) {
    console.error('[db] claimNextDueReminder fallback error:', fbErr.message);
  }

  return null;
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
export * from './subscriptions.js';
export * from './integrations.js';
export * from './messages.js';

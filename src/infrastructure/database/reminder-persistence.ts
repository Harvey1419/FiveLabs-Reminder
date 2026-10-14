import type { ReminderDependencies, ReminderRow, ReminderStorageError, SaveReminderInput, OwnerInput, CalendarCompanionInput, CalendarRescheduleInput, ReminderDate } from './reminder-persistence-client.js';

export function createReminderPersistence({ getClient, getNow, assertTurnLease, isStrictUUID, logger }: Pick<ReminderDependencies, 'getClient' | 'getNow' | 'assertTurnLease' | 'isStrictUUID' | 'logger'>) {
  async function saveReminder({
    userId,
    phoneNumber,
    content,
    sendAt,
    taskId = null,
    deliveryId = null,
    parentReminderId = null,
    recurrenceRule = null,
    requiresConfirmation = false,
    nudgeIntervalMinutes = 15,
    maxNudges = 5,
    source = null,
  }: SaveReminderInput) {
    const isPersistent = Boolean(requiresConfirmation);
    const resolvedSource = source
      || (deliveryId?.startsWith('gcal:') || content?.startsWith('🔔 [Google Calendar]') ? 'gcal_companion' : null)
      || (content?.startsWith('🔔 [Aviso Previo]') ? 'advance_notice' : null)
      || 'user';

    const insertPayload: Record<string, unknown> = {
      phone_number: phoneNumber,
      content,
      send_at: sendAt,
      recurrence_rule: recurrenceRule || null,
      status: 'pending',
      task_id: taskId || null,
      delivery_id: deliveryId || null,
      parent_reminder_id: parentReminderId || null,
      source: resolvedSource,
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
      let checkQ = getClient()
        .from('reminders')
        .select('*')
        .eq('status', 'pending')
        .eq('content', content)
        .eq('send_at', sendAt);

      if (userId) checkQ = checkQ.eq('user_id', userId);
      else checkQ = checkQ.eq('phone_number', phoneNumber);

      const { data: existing } = await checkQ.maybeSingle();
      if (existing) {
        logger.log(`[reminders] Identical pending reminder already exists (${existing.id}), returning existing.`);
        return { ...existing, isExisting: true };
      }

      // 1b. If deliveryId is specified (e.g. companion reminder), guard against duplicate insertion
      if (deliveryId) {
        let deliveryQ = getClient()
          .from('reminders')
          .select('*')
          .eq('delivery_id', deliveryId)
          .in('status', ['pending', 'sent']);

        if (userId) deliveryQ = deliveryQ.eq('user_id', userId);
        else deliveryQ = deliveryQ.eq('phone_number', phoneNumber);

        const { data: existingByDelivery } = await deliveryQ.maybeSingle();
        if (existingByDelivery) {
          logger.log(`[reminders] Reminder with delivery_id already exists (${existingByDelivery.id}), returning existing.`);
          return { ...existingByDelivery, isExisting: true };
        }
      }

      // 2. If creating a persistent reminder, cancel/supersede any older active unacknowledged nudge loop for the same content.
      // Never cancel external companion reminders (deliveryId) or future pending reminders with the same text.
      // Only supersede reminders that were already sent and are actively in an unacknowledged nudge loop.
      if (isPersistent && !deliveryId) {
        let activeQ = getClient()
          .from('reminders')
          .update({ status: 'cancelled', acknowledged_at: getNow().toISOString() })
          .eq('requires_confirmation', true)
          .eq('status', 'sent')
          .is('acknowledged_at', null)
          .is('delivery_id', null)
          .ilike('content', content.trim());

        if (userId) activeQ = activeQ.eq('user_id', userId);
        else activeQ = activeQ.eq('phone_number', phoneNumber);

        await activeQ;
      }
    } catch (err) {
      logger.warn('[reminders] duplicate check warning:', (err as ReminderStorageError).message);
    }

    const { data, error } = await getClient()
      .from('reminders')
      .insert(insertPayload)
      .select()
      .single();

    if (error) {
      // If remote DB schema hasn't run the ALTER TABLE yet, fallback to base columns
      if (error.message?.includes('column') && error.message?.includes('schema cache')) {
        const fallbackPayload: Record<string, unknown> = {
          phone_number: phoneNumber,
          content,
          send_at: sendAt,
          recurrence_rule: recurrenceRule || null,
          status: 'pending',
          task_id: taskId || null,
          parent_reminder_id: parentReminderId || null,
        };
        if (userId) fallbackPayload.user_id = userId;

        const { data: fallbackData, error: fallbackError } = await getClient()
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

  async function acknowledgeReminders({ userId, phoneNumber, contentQuery = null }: OwnerInput & { contentQuery?: unknown }) {
    if (!userId && !phoneNumber) {
      return { acknowledgedCount: 0, acknowledgedReminders: [] };
    }

    let q = getClient()
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
    const ackTime = getNow().toISOString();

    try {
      const { error: updateErr } = await getClient()
        .from('reminders')
        .update({ acknowledged_at: ackTime })
        .in('id', ids);

      if (updateErr && updateErr.message?.includes('column') && updateErr.message?.includes('schema cache')) {
        await getClient().from('reminders').update({ status: 'sent' }).in('id', ids);
      }
    } catch (err) {
      logger.warn('[reminders] acknowledge update error:', err);
    }

    logger.log(`[reminders] Acknowledged ${ids.length} reminder(s) for user ${userId || phoneNumber}`);
    return {
      acknowledgedCount: ids.length,
      acknowledgedReminders: candidates.map(r => ({ ...r, acknowledged_at: ackTime })),
    };
  }

  async function acknowledgeReminder(id: string | null | undefined, userId: string | null = null) {
    await assertTurnLease();
    if (!id || !userId) return null;
    const ackTime = getNow().toISOString();
    try {
      let resolvedId = String(id).trim();
      if (!isStrictUUID(resolvedId)) {
        let q = getClient().from('reminders').select('id');
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

      const { data, error } = await getClient()
        .from('reminders')
        .update({ acknowledged_at: ackTime, status: 'sent' })
        .eq('id', resolvedId)
        .eq('user_id', userId)
        .select()
        .maybeSingle();

      if (error) {
        logger.warn('[reminders] acknowledgeReminder error:', error.message);
        return null;
      }
      return data;
    } catch (e) {
      logger.warn('[reminders] acknowledgeReminder threw:', (e as ReminderStorageError).message);
      return null;
    }
  }

  async function getRemindersByPhone(phoneNumber: string | null | undefined, status = 'pending', limit = 20) {
    if (!phoneNumber) return [];
    const { data } = await getClient()
      .from('reminders')
      .select('*')
      .eq('phone_number', phoneNumber)
      .eq('status', status)
      .order('send_at', { ascending: true })
      .limit(limit);
    return data || [];
  }

  async function markReminderAsCancelled(id: string | null | undefined, userId: string | null = null, phoneNumber: string | null = null) {
    if (!id) return false;
    try {
      let resolvedId = String(id).trim();
      if (!isStrictUUID(resolvedId)) {
        let lookupQ = getClient().from('reminders').select('id');
        if (userId) lookupQ = lookupQ.eq('user_id', userId);
        else if (phoneNumber) lookupQ = lookupQ.eq('phone_number', phoneNumber);
        const { data: rems } = await lookupQ.limit(50);
        const matched = (rems || []).find(r => r.id.startsWith(resolvedId.toLowerCase()));
        if (matched) resolvedId = matched.id;
        else return false;
      }

      let q = getClient()
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
        if (error) logger.error('[reminders] markReminderAsCancelled failed:', error);
        return false;
      }
      return true;
    } catch (err) {
      logger.error('[reminders] markReminderAsCancelled threw:', err);
      return false;
    }
  }

  async function updateReminder(reminderId: string | null | undefined, updates: Record<string, unknown> | null, userId: string | null = null, phoneNumber: string | null = null) {
    await assertTurnLease();
    if (!reminderId || !updates) return null;
    try {
      let resolvedId = reminderId;
      if (!isStrictUUID(reminderId)) {
        let q = getClient().from('reminders').select('id');
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

      let q = getClient()
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
        logger.error('[reminders] updateReminder failed:', error);
        return null;
      }

      return data && data.length > 0 ? data[0] : null;
    } catch (err) {
      logger.error('[reminders] updateReminder threw:', err);
      return null;
    }
  }

  async function cancelReminders({ userId, phoneNumber, contentQuery = null, cancelAll = false, keepLatest = false }: OwnerInput & { contentQuery?: unknown; cancelAll?: boolean; keepLatest?: boolean }) {
    if (!userId && !phoneNumber) {
      return { cancelledCount: 0, cancelledReminders: [], remainingCount: 0 };
    }

    let q = getClient()
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

    let toCancel: ReminderRow[] = [];
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
    const { error: delErr } = await getClient()
      .from('reminders')
      .update({ status: 'cancelled' })
      .in('id', ids);

    if (delErr) {
      logger.error('[reminders] cancelReminders failed:', delErr);
      return { cancelledCount: 0, cancelledReminders: [], remainingCount: list.length };
    }

    return {
      cancelledCount: ids.length,
      cancelledReminders: toCancel,
      remainingCount: list.length - ids.length,
    };
  }

  async function cancelCalendarCompanionReminders({ userId, eventId, summary = null }: CalendarCompanionInput) {
    if (!userId || (!eventId && !summary)) return { cancelled: 0 };
    let cleanupError = null;
    try {
      if (eventId) {
        const { data, error } = await getClient()
          .from('reminders')
          .update({ status: 'cancelled', acknowledged_at: getNow().toISOString() })
          .eq('user_id', userId)
          .eq('delivery_id', `gcal:${eventId}`)
          .in('status', ['pending', 'processing'])
          .select('id');
        if (error) cleanupError = error;
        if (!error && data?.length! > 0) {
          return { cancelled: data!.length };
        }
      }
      if (summary) {
        const cleanSummary = String(summary).trim();
        const { data, error } = await getClient()
          .from('reminders')
          .update({ status: 'cancelled', acknowledged_at: getNow().toISOString() })
          .eq('user_id', userId)
          .in('status', ['pending', 'processing'])
          .ilike('content', `%${cleanSummary}%`)
          .select('id');
        if (error) cleanupError = error;
        if (!error && data?.length! > 0) {
          return { cancelled: data!.length };
        }
      }
      if (cleanupError) return { cancelled: 0, error: { code: cleanupError.code || 'DATABASE_ERROR' } };
      return { cancelled: 0 };
    } catch (err) {
      logger.warn('[reminders] cancelCalendarCompanionReminders warning:', (err as ReminderStorageError).message);
      return { cancelled: 0, error: { code: (err as ReminderStorageError).code || 'DATABASE_ERROR' } };
    }
  }

  async function rescheduleCalendarCompanionReminders({
    userId,
    eventId,
    summary = null,
    newStartDateTime,
    advanceMinutes = null,
  }: CalendarRescheduleInput) {
    if (!userId || (!eventId && !summary) || !newStartDateTime) return { rescheduled: 0 };
    try {
      let targetReminder = null;
      if (eventId) {
        const { data } = await getClient()
          .from('reminders')
          .select('*')
          .eq('user_id', userId)
          .eq('delivery_id', `gcal:${eventId}`)
          .in('status', ['pending', 'processing'])
          .maybeSingle();
        targetReminder = data;
      }
      if (!targetReminder && summary) {
        const { data } = await getClient()
          .from('reminders')
          .select('*')
          .eq('user_id', userId)
          .in('status', ['pending', 'processing'])
          .ilike('content', `%${String(summary).trim()}%`)
          .maybeSingle();
        targetReminder = data;
      }
      if (!targetReminder) return { rescheduled: 0 };

      const advMin = advanceMinutes !== null && Number.isFinite(Number(advanceMinutes))
        ? Number(advanceMinutes)
        : 30;
      const startTime = new Date(newStartDateTime).getTime();
      const newSendAt = new Date(startTime - advMin * 60 * 1000).toISOString();
      const updatedContent = advMin > 0
        ? `🔔 [Google Calendar] ${summary || 'Evento'} en ${advMin} minutos`
        : `🔔 [Google Calendar] ${summary || 'Evento'} ahora`;

      const { data: updated, error } = await getClient()
        .from('reminders')
        .update({
          send_at: newSendAt,
          content: updatedContent,
          delivery_id: eventId ? `gcal:${eventId}` : targetReminder.delivery_id,
        })
        .eq('id', targetReminder.id)
        .select('id');

      if (error) {
        logger.warn('[reminders] rescheduleCalendarCompanionReminders warning:', error.message);
        return { rescheduled: 0 };
      }
      return { rescheduled: updated?.length || 0, newSendAt };
    } catch (err) {
      logger.warn('[reminders] rescheduleCalendarCompanionReminders error:', (err as ReminderStorageError).message);
      return { rescheduled: 0 };
    }
  }

  async function acknowledgeRemindersByTaskId(taskId: string | null | undefined, userId: string | null = null) {
    await assertTurnLease();
    if (!taskId) return { acknowledgedCount: 0 };
    const now = getNow().toISOString();
    try {
      let q = getClient()
        .from('reminders')
        .update({ acknowledged_at: now, status: 'sent' })
        .eq('task_id', taskId)
        .is('acknowledged_at', null);

      if (userId) q = q.eq('user_id', userId);
      const { data, error } = await q.select('id');
      if (error) {
        logger.warn('[reminders] acknowledgeRemindersByTaskId error:', error.message);
        return { acknowledgedCount: 0, error: { code: error.code || 'DATABASE_ERROR' } };
      }
      return { acknowledgedCount: data?.length || 0 };
    } catch (err) {
      logger.warn('[reminders] acknowledgeRemindersByTaskId threw:', (err as ReminderStorageError).message);
      return { acknowledgedCount: 0, error: { code: (err as ReminderStorageError).code || 'DATABASE_ERROR' } };
    }
  }

  async function cancelRemindersByTaskId(taskId: string | null | undefined, userId: string | null = null) {
    if (!taskId) return { cancelledCount: 0 };
    try {
      let q = getClient()
        .from('reminders')
        .update({ status: 'cancelled' })
        .eq('task_id', taskId)
        .eq('status', 'pending');

      if (userId) q = q.eq('user_id', userId);
      const { data, error } = await q.select('id');
      if (error) {
        logger.warn('[reminders] cancelRemindersByTaskId error:', error.message);
        return { cancelledCount: 0, error: { code: error.code || 'DATABASE_ERROR' } };
      }
      return { cancelledCount: data?.length || 0 };
    } catch (err) {
      logger.warn('[reminders] cancelRemindersByTaskId threw:', (err as ReminderStorageError).message);
      return { cancelledCount: 0, error: { code: (err as ReminderStorageError).code || 'DATABASE_ERROR' } };
    }
  }

  async function rescheduleRemindersByTaskId(taskId: string | null | undefined, newDueDate: ReminderDate | null | undefined, userId: string | null = null) {
    if (!taskId || !newDueDate) return { rescheduledCount: 0 };
    try {
      const newSendAt = new Date(newDueDate).toISOString();
      let q = getClient()
        .from('reminders')
        .update({ send_at: newSendAt })
        .eq('task_id', taskId)
        .eq('status', 'pending');

      if (userId) q = q.eq('user_id', userId);
      const { data, error } = await q.select('id');
      if (error) {
        logger.warn('[reminders] rescheduleRemindersByTaskId error:', error.message);
        return { rescheduledCount: 0, error: { code: error.code || 'DATABASE_ERROR' } };
      }
      return { rescheduledCount: data?.length || 0, newSendAt };
    } catch (err) {
      logger.warn('[reminders] rescheduleRemindersByTaskId threw:', (err as ReminderStorageError).message);
      return { rescheduledCount: 0, error: { code: (err as ReminderStorageError).code || 'DATABASE_ERROR' } };
    }
  }

  const cancelPendingRemindersByContent = cancelReminders;
  return { saveReminder, acknowledgeReminders, acknowledgeReminder, getRemindersByPhone, markReminderAsCancelled, updateReminder, cancelReminders, cancelCalendarCompanionReminders, rescheduleCalendarCompanionReminders, acknowledgeRemindersByTaskId, cancelRemindersByTaskId, rescheduleRemindersByTaskId, cancelPendingRemindersByContent };
}

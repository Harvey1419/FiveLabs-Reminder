import type * as DB from '../infrastructure/database/index.js';
import type { ReminderRow, ReminderResult } from '../infrastructure/database/reminder-persistence-client.js';
export interface SchedulerReminder extends ReminderRow {
  locale?: string | null;
  users?: { locale?: string | null } | null;
  created_at?: string | null;
}
export interface SchedulerQuery extends PromiseLike<ReminderResult<SchedulerReminder[]>> {
  select(columns?: string): SchedulerQuery;
  update(values: Record<string, unknown>): SchedulerQuery;
  eq(column: string, value: unknown): SchedulerQuery;
  neq(column: string, value: unknown): SchedulerQuery;
  not(column: string, operator: string, value: unknown): SchedulerQuery;
  or(expression: string): SchedulerQuery;
  in(column: string, values: string[]): SchedulerQuery;
  gt(column: string, value: string): SchedulerQuery;
  is(column: string, value: null): SchedulerQuery;
  limit(count: number): SchedulerQuery;
  maybeSingle(): PromiseLike<ReminderResult<SchedulerReminder>>;
}
export interface ReminderDelivery { success?: boolean; messageId?: string | null; error?: string | null }
export interface SchedulerDependencies {
  supabase: { from(table: 'users' | 'reminders'): SchedulerQuery };
  claimNextDueReminder: typeof DB.claimNextDueReminder;
  getNextPendingReminder: typeof DB.getNextPendingReminder;
  markReminderAsDispatched: typeof DB.markReminderAsDispatched;
  markReminderAsFailed: typeof DB.markReminderAsFailed;
  markReminderAsMissed: typeof DB.markReminderAsMissed;
  getRemindersDueForNudge: typeof DB.getRemindersDueForNudge;
  incrementReminderNudge: typeof DB.incrementReminderNudge;
  getLatestInboundPhoneNumberId(phone: string | null | undefined, createdAt: string | null): Promise<string | null>;
  saveMessage(input: { userId: string | null | undefined; phoneNumber: string | null | undefined; role: 'assistant'; content: string; intent: 'reminder'; messageId: string; entities: Record<string, unknown> }): Promise<unknown>;
  getReminderDispatchPolicy: typeof DB.getReminderDispatchPolicy;
  sendReminderMessage(recipient: string | null | undefined, content: string, options: { phoneNumberId: string | null; language: string; buttons?: { id: string; title: string }[] }): Promise<ReminderDelivery>;
  stripReminderPrefix(text: string): string;
  saveWorkingMemory: typeof import('../agent/core/working-memory.js').saveWorkingMemory;
  computeNextRecurringSendAt(sendAt: SchedulerReminder['send_at'], rule: SchedulerReminder['recurrence_rule'], reference: Date): Date | null;
  detectLocaleFromPhone: typeof import('../shared/time.js').detectLocaleFromPhone;
  isAdvanceNoticeContent(content: string): boolean;
  getNow(): Date;
  getNowMs(): number;
  sleep(ms: number): Promise<void>;
  workerId: string;
  logger: Pick<Console, 'log' | 'warn' | 'error'>;
  checkIntervalMs?: number;
}

export function createReminderScheduler({ claimNextDueReminder, getNextPendingReminder, markReminderAsDispatched, markReminderAsFailed, markReminderAsMissed, getRemindersDueForNudge, incrementReminderNudge, getLatestInboundPhoneNumberId, saveMessage, supabase, getReminderDispatchPolicy, sendReminderMessage, stripReminderPrefix, saveWorkingMemory, computeNextRecurringSendAt, detectLocaleFromPhone, isAdvanceNoticeContent, getNow, getNowMs, sleep, workerId: WORKER_ID, logger, checkIntervalMs }: SchedulerDependencies) {
  const CHECK_INTERVAL_MS = checkIntervalMs ?? 15 * 1000;
  const NUDGE_CHECK_INTERVAL_MS = 60 * 1000; // Check nudges every 60s (nudges are spaced 10-15m)
  const RECONCILE_INTERVAL_MS = 5 * 60 * 1000; // Reconcile recurring schedules every 5m
  const MAX_STALE_MS = 2 * 60 * 60 * 1000;




  async function resolveReminderLocale(reminder: SchedulerReminder | null | undefined) {
    if (reminder?.locale) return reminder.locale;
    if (reminder?.users?.locale) return reminder.users.locale;
    if (reminder?.user_id) {
      try {
        const { data } = await supabase
          .from('users')
          .select('locale')
          .eq('id', reminder.user_id)
          .maybeSingle();
        if (data?.locale) return data.locale;
      } catch {
        // ignore and fall back
      }
    }
    if (reminder?.phone_number) {
      return detectLocaleFromPhone(reminder.phone_number);
    }
    return 'es-CO';
  }

  function isEnglishReminder(reminder: SchedulerReminder | null | undefined, resolvedLocale: string | null = null) {
    const loc = resolvedLocale || reminder?.locale || reminder?.users?.locale;
    if (loc) return loc.startsWith('en');
    if (reminder?.phone_number) return detectLocaleFromPhone(reminder.phone_number) === 'en-US';
    return false;
  }

  function isRecurring(reminder: SchedulerReminder | null | undefined) {
    return Boolean(String(reminder?.recurrence_rule || '').trim());
  }

  function isNudgeDue(reminder: SchedulerReminder | null | undefined, now = getNowMs()) {
    if (!reminder?.requires_confirmation || reminder?.acknowledged_at) return false;
    // SNOOZE / FUTURE SCHEDULE INVARIANT:
    // A reminder whose scheduled send_at is in the future (e.g. snoozed or next recurring occurrence)
    // must NEVER receive an escalation nudge.
    if (reminder?.send_at && new Date(reminder.send_at as string | number | Date).getTime() > now) {
      return false;
    }
    const maxNudges = reminder.max_nudges ?? 5;
    const nudgeCount = reminder.nudge_count ?? 0;
    if (nudgeCount >= maxNudges) return false;
    const lastNudgeMs = reminder.last_nudged_at
      ? new Date(reminder.last_nudged_at).getTime()
      : (reminder.sent_at ? new Date(reminder.sent_at).getTime() : 0);
    if (!lastNudgeMs || Number.isNaN(lastNudgeMs)) return false;
    const intervalMs = (reminder.nudge_interval_minutes || 15) * 60 * 1000;
    return now >= lastNudgeMs + intervalMs;
  }

  /**
   * A recurring reminder is one durable domain object. After each execution we
   * advance its next send_at in-place instead of materializing another row.
   * Lifecycle fields describe the most recent delivery/acknowledgement.
   */
  async function advanceRecurringReminderInPlace(reminder: SchedulerReminder, { dispatchedAt = null, deliveryId = null, requiresConfirmation = undefined }: { dispatchedAt?: Date | null; deliveryId?: string | null; requiresConfirmation?: boolean | null | undefined } = {}) {
    const reference = dispatchedAt || getNow();
    const nextSendAt = computeNextRecurringSendAt(reminder.send_at, reminder.recurrence_rule, reference);
    if (!nextSendAt) {
      throw new Error(`Could not compute next recurrence for reminder ${reminder.id}`);
    }

    const effectiveConfirmation = typeof requiresConfirmation === 'boolean'
      ? requiresConfirmation
      : reminder.requires_confirmation;

    const updates: Record<string, unknown> = {
      send_at: nextSendAt.toISOString(),
      status: 'pending',
      claimed_by: null,
      claimed_at: null,
      lock_until: null,
      requires_confirmation: effectiveConfirmation,
      // Keep the provider id for the most recent execution so delayed Meta/Kapso
      // delivery callbacks can still reconcile against this stable reminder row.
      delivery_id: deliveryId || reminder.delivery_id || null,
    };

    if (dispatchedAt) {
      const sentIso = dispatchedAt.toISOString();
      updates.sent_at = sentIso;
      updates.acknowledged_at = null;
      updates.nudge_count = 0;
      updates.last_nudged_at = effectiveConfirmation ? sentIso : null;
    }

    const { data, error } = await supabase
      .from('reminders')
      .update(updates)
      .eq('id', reminder.id)
      .select('id, send_at, recurrence_rule, status, sent_at, acknowledged_at, delivery_id')
      .maybeSingle();

    if (error || !data) {
      throw error || new Error(`Recurring reminder ${reminder.id} could not be advanced.`);
    }

    logger.log(
      `[scheduler worker=${WORKER_ID}] recurring reminder advanced in-place id=${reminder.id} next=${data.send_at} rule=${data.recurrence_rule} deliveryId=${data.delivery_id || 'none'}`,
    );
    return data;
  }

  /**
   * Defensive reconciliation for callbacks/acknowledgements that may set a
   * recurring row to sent/failed after it has already been advanced. A future
   * recurring schedule is always pending and keeps the same UUID.
   */
  async function reconcileRecurringScheduleState() {
    const nowIso = getNow().toISOString();
    try {
      await supabase
        .from('reminders')
        .update({ status: 'cancelled' })
        .not('acknowledged_at', 'is', null)
        .neq('status', 'cancelled')
        .or('recurrence_rule.eq.hourly,recurrence_rule.like.hourly:%,recurrence_rule.like.interval:%');
    } catch (healErr) {
      logger.warn(`[scheduler worker=${WORKER_ID}] intraday recurrence heal warning:`, (healErr as { message?: string }).message || healErr);
    }

    const { data, error } = await supabase
      .from('reminders')
      .update({ status: 'pending' })
      .not('recurrence_rule', 'is', null)
      .in('status', ['sent', 'failed'])
      .gt('send_at', nowIso)
      .select('id');

    if (error) {
      logger.warn(`[scheduler worker=${WORKER_ID}] recurring state reconciliation failed:`, error.message || error);
      return 0;
    }
    const count = data?.length || 0;
    if (count > 0) {
      logger.log(`[scheduler worker=${WORKER_ID}] reconciled ${count} recurring reminder lifecycle row(s) to pending`);
    }
    return count;
  }

  async function getRecurringPendingNudges() {
    const { data, error } = await supabase
      .from('reminders')
      .select('id, user_id, phone_number, content, task_id, status, requires_confirmation, nudge_interval_minutes, max_nudges, nudge_count, last_nudged_at, sent_at, recurrence_rule, send_at')
      .eq('status', 'pending')
      .eq('requires_confirmation', true)
      .not('recurrence_rule', 'is', null)
      .is('acknowledged_at', null)
      .not('last_nudged_at', 'is', null)
      .limit(200);

    if (error) {
      logger.warn(`[scheduler worker=${WORKER_ID}] recurring nudge read failed:`, error.message || error);
      return [];
    }
    return (data || []).filter((reminder) => isNudgeDue(reminder));
  }

  async function startScheduler() {
    logger.log(`[scheduler] started worker=${WORKER_ID} (check interval: ${CHECK_INTERVAL_MS / 1000}s with atomic locking, stable recurring IDs & persistent nudges)`);

    let lastNudgeCheckMs = 0;
    let lastReconcileMs = 0;

    while (true) {
      try {
        const now = getNowMs();

        // Only reconcile recurring state every 5 minutes instead of every 15 seconds
        if (now - lastReconcileMs >= RECONCILE_INTERVAL_MS) {
          lastReconcileMs = now;
          await reconcileRecurringScheduleState();
        }

        let claimed = await claimNextDueReminder(WORKER_ID);
        while (claimed) {
          await processReminder(claimed);
          claimed = await claimNextDueReminder(WORKER_ID);
        }

        // Check nudges every 60 seconds instead of every 15 seconds
        if (now - lastNudgeCheckMs >= NUDGE_CHECK_INTERVAL_MS) {
          lastNudgeCheckMs = now;
          await checkAndDispatchNudges();
        }

        const nextReminder = await getNextPendingReminder();
        if (!nextReminder) {
          await sleep(CHECK_INTERVAL_MS);
          continue;
        }

        const sendAtMs = new Date(nextReminder.send_at as string | number | Date).getTime();
        const currentMs = getNowMs();
        if (sendAtMs <= currentMs) continue;
        await sleep(Math.min(sendAtMs - currentMs, CHECK_INTERVAL_MS));
      } catch (error) {
        logger.error(`[scheduler worker=${WORKER_ID}] error in cycle:`, error);
        await sleep(15000);
      }
    }
  }

  async function checkAndDispatchNudges() {
    try {
      const [legacyDue, recurringDue] = await Promise.all([
        getRemindersDueForNudge(),
        getRecurringPendingNudges(),
      ]);
      const byId = new Map<string, SchedulerReminder>();
      for (const reminder of [...(legacyDue || []), ...(recurringDue || [])]) {
        if (reminder?.id) byId.set(reminder.id, reminder);
      }

      for (const reminder of byId.values()) {
        let includeNudgeButtons = true;
        if (reminder.user_id) {
          try {
            const policy = await getReminderDispatchPolicy(reminder.user_id);
            const scope = isRecurring(reminder) ? policy?.recurring : policy?.global;
            includeNudgeButtons = !scope?.disableButtons;
            if (scope?.disableNudges || (isRecurring(reminder) && policy?.disableNudgesForRecurring)) {
              await supabase
                .from('reminders')
                .update({ requires_confirmation: false, nudge_count: 0, last_nudged_at: null })
                .eq('id', reminder.id);
              continue;
            }
          } catch (policyErr) {
            logger.warn(`[scheduler worker=${WORKER_ID}] failed to check reminder policy for nudge:`, (policyErr as { message?: string }).message);
            continue;
          }
        }

        const nextCount = (reminder.nudge_count || 0) + 1;
        const cleanText = stripReminderPrefix(reminder.content);
        const isTask = Boolean(reminder.task_id);
        const resolvedLocale = await resolveReminderLocale(reminder);
        const isEnglish = isEnglishReminder(reminder, resolvedLocale);
        const nudgeMessage = isEnglish
          ? (reminder.task_id
              ? `🔔 Were you able to complete the task: *${cleanText}*? (Notice #${nextCount}). Tap 'Done' or reply when finished.`
              : `🔔 *Pending reminder:* ${cleanText} (Notice #${nextCount}). Tap 'Done' or reply once completed.`)
          : (reminder.task_id
              ? `🔔 ¿Pudiste completar la tarea: *${cleanText}*? (Aviso #${nextCount}). Escribe 'Listo' o 'OK' cuando termines.`
              : `🔔 *Recordatorio pendiente:* ${cleanText} (Aviso #${nextCount}). Escribe 'Listo' o 'OK' cuando lo hayas completado.`);

        const phoneNumberId = await getLatestInboundPhoneNumberId(
          reminder.phone_number,
          reminder.created_at || null,
        );
        const nudgeButtons = [
          { id: `rem:ack:${reminder.id}`, title: isEnglish ? '✅ Done' : '✅ Listo' },
          { id: `rem:snooze:15:${reminder.id}`, title: '⏰ +15 min' },
          { id: `rem:snooze:60:${reminder.id}`, title: isEnglish ? '⏰ +1 hour' : '⏰ +1 hora' },
        ];
        const sendResult = await sendReminderMessage(reminder.phone_number, nudgeMessage, {
          phoneNumberId,
          ...(includeNudgeButtons ? { buttons: nudgeButtons } : {}),
          language: isEnglish ? 'en' : 'es',
        });
        if (!sendResult?.success || !sendResult?.messageId) {
          throw new Error(sendResult?.error || 'Kapso did not accept the reminder nudge.');
        }
        await incrementReminderNudge(reminder.id, nextCount);

        const wmPayload = {
          source: 'notification',
          scope: 'today',
          lastAction: 'nudge',
          notificationReminderId: reminder.id,
          notificationContent: cleanText,
          items: [{
            position: 1,
            type: 'reminder',
            internalId: reminder.id,
            summary: cleanText,
            raw: reminder,
          }],
        };
        if (reminder.phone_number) saveWorkingMemory(reminder.phone_number, wmPayload);
        if (reminder.user_id) saveWorkingMemory(reminder.user_id, wmPayload);

        await saveMessage({
          userId: reminder.user_id,
          phoneNumber: reminder.phone_number,
          role: 'assistant',
          content: nudgeMessage,
          intent: 'reminder',
          messageId: sendResult.messageId,
          entities: {
            _workingMemory: {
              ...wmPayload,
              persistedAt: getNow().toISOString(),
            },
          },
        });

        logger.log(`[scheduler worker=${WORKER_ID}] Nudge #${nextCount} sent for reminder ${reminder.id} ("${reminder.content}") to ${reminder.phone_number}`);
      }
    } catch (err) {
      logger.error(`[scheduler worker=${WORKER_ID}] checkAndDispatchNudges error:`, err);
    }
  }

  async function processReminder(reminder: SchedulerReminder) {
    const sendAtMs = new Date(reminder.send_at as string | number | Date).getTime();
    const now = getNowMs();
    const recurring = isRecurring(reminder);

    if (now - sendAtMs > MAX_STALE_MS) {
      logger.warn(`[scheduler worker=${WORKER_ID}] reminder ${reminder.id} missed (expired ${Math.round((now - sendAtMs) / 60000)}m ago)`);
      if (recurring) {
        await advanceRecurringReminderInPlace(reminder);
      } else {
        await markReminderAsMissed(reminder.id);
      }
      return;
    }

    try {
      const phoneNumberId = await getLatestInboundPhoneNumberId(
        reminder.phone_number,
        reminder.created_at || null,
      );

      const resolvedLocale = await resolveReminderLocale(reminder);
      const isEnglish = isEnglishReminder(reminder, resolvedLocale);

      const isAdvance = isAdvanceNoticeContent(reminder?.content);
      let includeButtons = !isAdvance;
      let effectiveRequiresConfirmation = isAdvance ? false : reminder.requires_confirmation;
      if (reminder.user_id) {
        try {
          const policy = await getReminderDispatchPolicy(reminder.user_id);
          const scope = recurring ? policy?.recurring : policy?.global;
          if (scope?.disableButtons || (recurring && policy?.disableButtonsForRecurring)) {
            includeButtons = false;
          }
          if (scope?.disableNudges || (recurring && policy?.disableNudgesForRecurring)) {
            effectiveRequiresConfirmation = false;
          }
        } catch (policyErr) {
          logger.warn(`[scheduler worker=${WORKER_ID}] failed to load reminder policy:`, (policyErr as { message?: string }).message);
          includeButtons = false;
        }
      }

      const sendOpts = {
        phoneNumberId,
        language: isEnglish ? 'en' : 'es',
        ...(includeButtons ? {
          buttons: [
            { id: `rem:ack:${reminder.id}`, title: isEnglish ? '✅ Done' : '✅ Listo' },
            { id: `rem:snooze:15:${reminder.id}`, title: '⏰ +15 min' },
            { id: `rem:snooze:60:${reminder.id}`, title: isEnglish ? '⏰ +1 hour' : '⏰ +1 hora' },
          ],
        } : {}),
      };

      const sendResult = await sendReminderMessage(
        reminder.phone_number,
        reminder.content,
        sendOpts,
      );
      if (!sendResult?.success || !sendResult?.messageId) {
        throw new Error(sendResult?.error || 'Kapso did not accept the scheduled reminder.');
      }

      const deliveryId = sendResult.messageId;
      const dispatchedAt = getNow();

      if (recurring) {
        await advanceRecurringReminderInPlace(reminder, {
          dispatchedAt,
          deliveryId,
          requiresConfirmation: effectiveRequiresConfirmation,
        });
      } else {
        await markReminderAsDispatched(reminder.id, { deliveryId });
        if (effectiveRequiresConfirmation) {
          const nowIso = dispatchedAt.toISOString();
          const { error: nudgeStateError } = await supabase.from('reminders').update({
            last_nudged_at: nowIso,
            nudge_count: 0,
          }).eq('id', reminder.id);
          if (nudgeStateError) throw nudgeStateError;
        }
      }

      const cleanSummary = stripReminderPrefix(reminder.content);
      const wmPayload = {
        source: 'notification',
        scope: 'today',
        lastAction: isAdvance ? 'advance_notice_dispatched' : 'reminder_dispatched',
        notificationReminderId: isAdvance ? null : reminder.id,
        notificationContent: cleanSummary,
        items: [{
          position: 1,
          type: 'reminder',
          internalId: reminder.id,
          summary: cleanSummary,
          raw: reminder,
        }],
      };
      if (reminder.phone_number) saveWorkingMemory(reminder.phone_number, wmPayload);
      if (reminder.user_id) saveWorkingMemory(reminder.user_id, wmPayload);

      await saveMessage({
        userId: reminder.user_id,
        phoneNumber: reminder.phone_number,
        role: 'assistant',
        content: reminder.content,
        intent: 'reminder',
        messageId: deliveryId,
        entities: {
          _workingMemory: {
            ...wmPayload,
            persistedAt: dispatchedAt.toISOString(),
          },
        },
      });

      logger.log(`[scheduler worker=${WORKER_ID}] reminder sent ok: ${reminder.id} ("${reminder.content}") deliveryId=${deliveryId} recurring=${recurring}`);
    } catch (error) {
      logger.error(`[scheduler worker=${WORKER_ID}] failed to send reminder ${reminder.id}:`, error);
      if (recurring) {
        // A failed occurrence must not destroy the user's recurring routine.
        try {
          await advanceRecurringReminderInPlace(reminder);
        } catch (advanceError) {
          logger.error(`[scheduler worker=${WORKER_ID}] failed to preserve recurring reminder ${reminder.id}:`, advanceError);
          await markReminderAsFailed(reminder.id);
        }
      } else {
        await markReminderAsFailed(reminder.id);
      }
    }
  }

  return { resolveReminderLocale, isEnglishReminder, isNudgeDue, reconcileRecurringScheduleState, startScheduler, checkAndDispatchNudges, processReminder };
}

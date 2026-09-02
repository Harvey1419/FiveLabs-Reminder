import {
  saveReminder,
  getRemindersByPhone,
  cancelPendingRemindersByContent,
  acknowledgeReminder,
  acknowledgeReminders,
  markReminderAsCancelled,
  createTask,
  getUserSubscription,
  hasProAccess,
} from '../../db/index.js';
import {
  parseTargetTime,
  formatLocalDateTime,
  DEFAULT_TIMEZONE,
} from '../../utils/time.js';
import { formatReminderCreatedCard, formatReminderCancelledCard, formatReminderAcknowledgedCard } from './formatters.js';

/**
 * Domain tool for managing reminders.
 */
export async function executeReminderTool(optionsOrAction, legacyParams = {}, legacyUser = null) {
  let action, params, user, isPro, language, correlationId;

  if (typeof optionsOrAction === 'string') {
    action = optionsOrAction;
    params = legacyParams || {};
    user = legacyUser || {};
  } else {
    action = optionsOrAction?.action;
    params = optionsOrAction?.params || {};
    user = optionsOrAction?.user || (legacyParams?.id ? legacyParams : legacyUser) || {};
    isPro = optionsOrAction?.isPro || false;
    language = optionsOrAction?.language || 'es';
    correlationId = optionsOrAction?.correlationId;
  }

  const userId = user?.id;
  const phoneNumber = user?.phone_number;
  const timezone = user?.timezone || DEFAULT_TIMEZONE;
  const subscription = user?.subscription || (userId ? await getUserSubscription(userId) : null);
  const userHasPro = isPro || user?.is_admin === true || hasProAccess(subscription, user);

  const normalizedAction = String(action || 'create').replace(/_reminder$/, '');

  switch (normalizedAction) {
    case 'create': {
      const rawItems = Array.isArray(params.items) && params.items.length > 0
        ? params.items
        : [params];

      const savedReminders = [];

      for (const item of rawItems) {
        const content = item.content || item.reminder || item.text || item.title || '';
        let targetTime = item.targetTime || item.sendAt || item.time || item.date || '';
        const advanceMinutes = item.advanceMinutes || item.advance_minutes || null;
        const advanceNoticeTime = item.advanceNoticeTime || item.advance_notice_time || null;
        let recurrenceRule = item.recurrence || item.recurrenceRule || item.recurrence_rule || null;
        const requiresConfirmation = item.requiresConfirmation || item.requires_confirmation || false;
        const nudgeIntervalMinutes = item.nudgeIntervalMinutes || item.nudge_interval_minutes || null;
        const maxNudges = item.maxNudges || item.max_nudges || null;
        const replacePending = item.replacePending || item.replace_pending || false;
        const checklist = item.checklist || null;

        // Auto-detect recurrence from content text if not explicitly provided
        if (!recurrenceRule && content) {
          if (/\b(cada\s+hora|hourly)\b/i.test(content)) {
            recurrenceRule = 'hourly';
            if (!targetTime) targetTime = '+1h';
          } else if (/\b(cada\s+\d+\s*horas?)\b/i.test(content)) {
            const hMatch = content.match(/cada\s+(\d+)\s*horas?/i);
            recurrenceRule = `hourly:${hMatch ? hMatch[1] : 2}`;
            if (!targetTime) targetTime = `+${hMatch ? hMatch[1] : 2}h`;
          } else if (/\b(cada\s+\d+\s*minutos?)\b/i.test(content)) {
            const mMatch = content.match(/cada\s+(\d+)\s*minutos?/i);
            recurrenceRule = `interval:${mMatch ? mMatch[1] : 30}m`;
            if (!targetTime) targetTime = `+${mMatch ? mMatch[1] : 30}m`;
          } else if (/\b(todos\s+los\s+d[ií]as|diario|daily)\b/i.test(content)) {
            recurrenceRule = 'daily';
            if (!targetTime) targetTime = '08:00';
          }
        }

        if (!targetTime) {
          targetTime = '+1h';
        }

        if (!content) {
          return {
            success: false,
            action: 'invalid_parameters',
            errorCode: 'INVALID_PARAMETERS',
            error: 'Falta el contenido del recordatorio.',
            rawSummary: 'Falta el contenido del recordatorio.',
          };
        }

        const mainDate = parseTargetTime(targetTime, timezone);
        if (!mainDate || isNaN(mainDate.getTime())) {
          return {
            success: false,
            action: 'invalid_time_format',
            errorCode: 'INVALID_TIME_FORMAT',
            error: `No pude interpretar la hora '${targetTime}'. Por favor indícala claramente (ej: '5:00 PM', '18:30').`,
            rawSummary: `No pude interpretar la hora '${targetTime}'.`,
          };
        }

        // Check Pro Tier Restriction (Future Days & Recurrence)
        const now = new Date();
        const userDateStr = now.toLocaleDateString('sv-SE', { timeZone: timezone });
        const targetDateStr = mainDate.toLocaleDateString('sv-SE', { timeZone: timezone });
        const diffMs = mainDate.getTime() - now.getTime();
        // Future day if different date and beyond 3 hours from now
        const isFutureDay = (targetDateStr !== userDateStr && diffMs > 3 * 60 * 60 * 1000) || (diffMs > 24 * 60 * 60 * 1000);
        const isRecurring = Boolean(recurrenceRule);

        if ((isFutureDay || isRecurring) && !userHasPro) {
          const errorMsg = 'Para programar recordatorios recurrentes o para días futuros, se requiere una suscripción a Reminder Pro.';
          return {
            success: false,
            action: 'tier_limit_exceeded',
            errorCode: 'PRO_TIER_REQUIRED',
            isProFeature: true,
            error: errorMsg,
            rawSummary: errorMsg,
            data: {
              reason: 'pro_tier_limit',
              targetDate: mainDate.toISOString(),
              recurrence: recurrenceRule,
            },
          };
        }

        // Optional: Replace previous similar reminders
        if (replacePending) {
          try {
            await cancelPendingRemindersByContent({
              phoneNumber,
              contentQuery: content,
            });
          } catch (e) {
            console.warn('[reminderTools] replacePending error:', e.message);
          }
        }

        // 1. Advance notice reminder if requested
        if (advanceMinutes || advanceNoticeTime) {
          let advDate = null;
          if (advanceNoticeTime) {
            advDate = parseTargetTime(advanceNoticeTime, timezone);
          } else if (advanceMinutes) {
            advDate = new Date(mainDate.getTime() - advanceMinutes * 60 * 1000);
          }

          if (advDate && advDate.getTime() > Date.now()) {
            const advContent = `🔔 [Aviso Previo] En ${advanceMinutes || 15} minutos: ${content}`;
            const advReminder = await saveReminder({
              userId,
              phoneNumber,
              content: advContent,
              sendAt: advDate.toISOString(),
              requiresConfirmation: false,
            });
            if (advReminder) {
              savedReminders.push({
                id: advReminder.id,
                content: advContent,
                sendAt: advDate.toISOString(),
                formattedTime: formatLocalDateTime(advDate, timezone),
              });
            }
          }
        }

        // 2. Main reminder
        const mainReminder = await saveReminder({
          userId,
          phoneNumber,
          content,
          sendAt: mainDate.toISOString(),
          recurrenceRule: recurrenceRule || null,
          requiresConfirmation: Boolean(requiresConfirmation),
          nudgeIntervalMinutes: nudgeIntervalMinutes || (requiresConfirmation ? 10 : null),
          maxNudges: maxNudges || (requiresConfirmation ? 3 : null),
        });

        if (!mainReminder) {
          return {
            success: false,
            action: 'database_error',
            errorCode: 'DATABASE_ERROR',
            error: 'No se pudo guardar el recordatorio en la base de datos.',
            rawSummary: 'No se pudo guardar el recordatorio en la base de datos.',
          };
        }

        savedReminders.push({
          id: mainReminder.id,
          content,
          sendAt: mainDate.toISOString(),
          formattedTime: formatLocalDateTime(mainDate, timezone),
          recurrenceRule,
          recurrence_rule: recurrenceRule,
          requiresConfirmation,
        });

        // 3. Optional Checklist creation
        if (Array.isArray(checklist) && checklist.length > 0) {
          for (const chkItem of checklist) {
            const itemTitle = typeof chkItem === 'string' ? chkItem : chkItem.title;
            if (itemTitle) {
              await createTask({
                userId,
                title: itemTitle,
                dueDate: mainDate.toISOString(),
              });
            }
          }
        }
      }

      const formattedCard = formatReminderCreatedCard(savedReminders, language);

      return {
        success: true,
        action: 'created_reminders_batch',
        data: savedReminders,
        rawSummary: formattedCard,
        formattedCard,
      };
    }

    case 'acknowledge': {
      const { reminderId = null, queryText = null } = params;
      let count = 0;

      if (reminderId) {
        let targetId = reminderId;
        if (targetId.length < 36) {
          const pending = await getRemindersByPhone(phoneNumber, 'pending', 50);
          const matched = pending.find(r => r.id.startsWith(targetId));
          if (matched) targetId = matched.id;
        }
        const res = await acknowledgeReminder(targetId);
        if (res) count++;
      } else {
        const ackRes = await acknowledgeReminders({
          userId,
          phoneNumber,
          contentQuery: queryText,
        });
        count = ackRes?.acknowledgedCount || 0;
      }

      const formattedCard = formatReminderAcknowledgedCard(count, language);

      return {
        success: true,
        action: 'acknowledged_reminders',
        data: {
          acknowledgedCount: count,
        },
        rawSummary: formattedCard,
        formattedCard,
      };
    }

    case 'cancel': {
      const { reminderId = null, scope = null, cancelAll = false } = params;
      let cancelledCount = 0;

      // 1. Missing Target Guard: single-reminder cancellation strictly REQUIRES reminderId
      if (!reminderId && scope !== 'all' && !cancelAll) {
        return {
          success: false,
          action: 'missing_target_id',
          errorCode: 'MISSING_TARGET_ID',
          error: language === 'en' ? 'Missing reminder ID to cancel. Please specify which reminder you want to cancel.' : 'Falta el ID del recordatorio a cancelar. Por favor especifica cuál recordatorio deseas cancelar.',
          rawSummary: language === 'en' ? 'Which reminder would you like me to cancel?' : '¿Cuál recordatorio deseas que cancele?',
          confirmation: language === 'en' ? 'Which reminder would you like me to cancel?' : '¿Cuál recordatorio deseas que cancele?',
        };
      }

      if (reminderId) {
        let targetId = reminderId;
        if (targetId.length < 36) {
          const pending = await getRemindersByPhone(phoneNumber, 'pending', 50);
          const matched = pending.find(r => r.id.startsWith(targetId));
          if (matched) targetId = matched.id;
          else {
            return {
              success: false,
              action: 'reminder_not_found',
              errorCode: 'NOT_FOUND',
              error: language === 'en' ? 'Reminder not found.' : 'No se encontró el recordatorio especificado.',
              rawSummary: language === 'en' ? 'Reminder not found.' : 'No se encontró el recordatorio especificado.',
              confirmation: language === 'en' ? '⚠️ Reminder not found.' : '⚠️ No se encontró el recordatorio especificado.',
            };
          }
        }
        const marked = await markReminderAsCancelled(targetId);
        if (!marked) {
          return {
            success: false,
            action: 'reminder_not_found',
            errorCode: 'NOT_FOUND',
            error: language === 'en' ? 'Reminder not found or already completed.' : 'No se encontró el recordatorio o ya fue completado.',
            rawSummary: language === 'en' ? 'Reminder not found.' : 'No se encontró el recordatorio especificado.',
            confirmation: language === 'en' ? '⚠️ Reminder not found.' : '⚠️ No se encontró el recordatorio especificado.',
          };
        }
        cancelledCount = 1;
      } else if (scope === 'all' || cancelAll) {
        const pending = await getRemindersByPhone(phoneNumber, 'pending', 50);
        for (const r of pending) {
          await markReminderAsCancelled(r.id);
          cancelledCount++;
        }
      }

      const remaining = await getRemindersByPhone(phoneNumber, 'pending', 50);
      const formattedCard = formatReminderCancelledCard(cancelledCount, remaining.length, '', language);

      return {
        success: true,
        action: 'cancelled_reminders',
        data: {
          cancelledCount,
          remainingCount: remaining.length,
        },
        rawSummary: formattedCard,
        formattedCard,
      };
    }

    case 'list': {
      const pending = await getRemindersByPhone(phoneNumber, 'pending', 20);
      return {
        success: true,
        action: 'listed_reminders',
        data: pending,
        rawSummary: `Tienes ${pending.length} recordatorio(s) pendiente(s).`,
      };
    }

    default:
      return {
        success: false,
        action: 'unsupported_action',
        errorCode: 'UNSUPPORTED_ACTION',
        error: `Acción '${action}' no soportada para manage_reminder.`,
        rawSummary: `Acción '${action}' no soportada para manage_reminder.`,
      };
  }
}

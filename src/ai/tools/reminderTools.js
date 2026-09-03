import {
  supabase,
  saveReminder,
  getRemindersByPhone,
  cancelPendingRemindersByContent,
  acknowledgeReminder,
  acknowledgeReminders,
  markReminderAsCancelled,
  updateReminder,
  createTask,
  getUserSubscription,
  hasProAccess,
  shouldEnforceBillingForUser,
} from '../../db/index.js';
import {
  parseTargetTime,
  formatLocalDateTime,
  formatHumanFriendlyDateTime,
  getDayBounds,
  DEFAULT_TIMEZONE,
} from '../../utils/time.js';
import { normalizePhoneNumber, stripReminderPrefix } from '../../utils/kapso.js';
import {
  formatReminderCreatedCard,
  formatReminderCancelledCard,
  formatReminderAcknowledgedCard,
  formatReminderUpdatedCard,
  formatReminderListCard,
  formatReminderCreatedTodayCard,
  formatReminderCompletedTodayCard,
  formatReminderRemainingTodayCard,
} from './formatters.js';
import { resolveEntityReference, getWorkingMemory } from '../workingMemory.js';

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
  const userMessage = optionsOrAction?.userMessage || optionsOrAction?.message || optionsOrAction?.text || '';
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

        // Check Pro Tier Restriction (Future Days & Recurrence) if user is subject to billing enforcement
        const enforceBilling = shouldEnforceBillingForUser(user);
        if (enforceBilling) {
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
                formattedTime: formatHumanFriendlyDateTime(advDate, timezone, language),
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
          formattedTime: formatHumanFriendlyDateTime(mainDate, timezone, language),
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

      const formattedCard = formatReminderCreatedCard(savedReminders, timezone, language);

      return {
        success: true,
        action: 'created_reminders_batch',
        data: savedReminders,
        rawSummary: formattedCard,
        formattedCard,
      };
    }

    case 'update': {
      const {
        reminderId = null,
        updates = {},
        targetTime = null,
        sendAt = null,
        content = null,
        text = null,
        recurrence = null,
        recurrenceRule = null,
      } = params;

      const targetReminderId = reminderId || params.id || updates.reminderId || updates.id;

      // 0. Advance Notice Guard ("avísame 15 minutos antes", "recuérdame 30 mins antes"):
      // If the intent is an advance notice relative to an existing reminder, CREATE a new reminder instead of overwriting.
      const isAdvanceNotice = /\b(\d+)\s*(minutos?|mins?|horas?|hrs?)\s*antes\b/i.test(userMessage || '') ||
                              params.advanceMinutes !== undefined ||
                              params.isAdvanceNotice === true;

      if (isAdvanceNotice) {
        let targetId = targetReminderId;
        const pending = await getRemindersByPhone(phoneNumber, 'pending', 50);

        if (targetId && targetId.length < 36 && pending.length > 0) {
          const refRes = resolveEntityReference({
            userOrPhone: user || phoneNumber,
            reference: String(targetId),
            candidates: pending,
            preferredType: 'reminder',
          });
          if (refRes.status === 'RESOLVED') {
            targetId = refRes.item.internalId;
          }
        }

        let baseReminder = null;
        if (targetId) {
          baseReminder = pending.find(r => r.id === targetId || r.id.startsWith(targetId));
          if (!baseReminder) {
            const { data: rem } = await supabase.from('reminders').select('*').eq('id', targetId).maybeSingle();
            baseReminder = rem;
          }
        } else if (pending.length > 0) {
          // Default to the latest created pending reminder
          baseReminder = pending[0];
        }

        if (baseReminder && baseReminder.send_at) {
          const matchMins = (userMessage || '').match(/(\d+)\s*(minutos?|mins?)/i);
          const matchHours = (userMessage || '').match(/(\d+)\s*(horas?|hrs?)/i);
          let advMins = params.advanceMinutes || 15;
          if (matchMins) advMins = parseInt(matchMins[1], 10);
          else if (matchHours) advMins = parseInt(matchHours[1], 10) * 60;

          const baseDate = new Date(baseReminder.send_at);
          const advDate = new Date(baseDate.getTime() - advMins * 60 * 1000);

          if (advDate.getTime() > Date.now()) {
            const advContent = `🔔 [Aviso Previo] En ${advMins} minutos: ${baseReminder.content}`;
            const advReminder = await saveReminder({
              userId,
              phoneNumber,
              content: advContent,
              sendAt: advDate.toISOString(),
              requiresConfirmation: false,
            });

            if (advReminder) {
              const formattedTime = formatHumanFriendlyDateTime(advDate, timezone, language);
              const summary = `🔔 *Aviso previo programado en WhatsApp*\n\n⏰ *${advContent}*\n📅 ${formattedTime} (${advMins} minutos antes de tu recordatorio principal)`;
              return {
                success: true,
                action: 'created_advance_reminder',
                data: advReminder,
                rawSummary: summary,
                formattedCard: summary,
                confirmation: summary,
              };
            }
          }
        }
      }

      // 1. Missing Target Guard: single-reminder update strictly REQUIRES reminderId
      if (!targetReminderId) {
        return {
          success: false,
          action: 'missing_target_id',
          errorCode: 'MISSING_TARGET_ID',
          error: language === 'en'
            ? 'Missing reminder ID to update. Please specify which reminder you want to update.'
            : 'Falta el ID del recordatorio a actualizar. Por favor especifica cuál recordatorio deseas actualizar.',
          rawSummary: language === 'en'
            ? 'Which reminder would you like me to update?'
            : '¿Cuál recordatorio deseas que actualice?',
          confirmation: language === 'en'
            ? 'Which reminder would you like me to update?'
            : '¿Cuál recordatorio deseas que actualice?',
        };
      }

      const dbUpdates = {};

      // Content update (if specified)
      const newContent = content || text || updates.content || updates.text;
      if (newContent) {
        dbUpdates.content = String(newContent).trim();
      }

      // Time / Date update (if specified)
      const rawTargetTime = targetTime || sendAt || updates.targetTime || updates.sendAt || updates.time || updates.date;
      if (rawTargetTime) {
        const parsedDate = parseTargetTime(rawTargetTime, timezone);
        if (!parsedDate || isNaN(parsedDate.getTime())) {
          return {
            success: false,
            action: 'invalid_time',
            errorCode: 'INVALID_TIME',
            error: language === 'en'
              ? `Could not parse date/time: "${rawTargetTime}"`
              : `No pude entender la fecha/hora: "${rawTargetTime}"`,
            rawSummary: language === 'en'
              ? `Could not parse date/time: "${rawTargetTime}"`
              : `No pude entender la fecha/hora: "${rawTargetTime}"`,
          };
        }

        // Pro tier check for future days
        const enforceBilling = shouldEnforceBillingForUser(user);
        const todayDateStr = new Date().toLocaleDateString('en-CA', { timeZone: timezone });
        const reminderDateStr = parsedDate.toLocaleDateString('en-CA', { timeZone: timezone });
        const isFutureDay = reminderDateStr > todayDateStr;

        if (enforceBilling && isFutureDay && !userHasPro) {
          const errorMsg = language === 'en'
            ? 'Scheduling reminders for future days requires a Reminder Pro subscription.'
            : 'Para programar recordatorios para días futuros, se requiere una suscripción a Reminder Pro.';
          return {
            success: false,
            action: 'pro_tier_required',
            errorCode: 'PRO_TIER_REQUIRED',
            isProFeature: true,
            error: errorMsg,
            rawSummary: errorMsg,
            data: {
              reason: 'pro_tier_limit',
              targetDate: parsedDate.toISOString(),
            },
          };
        }

        dbUpdates.send_at = parsedDate.toISOString();
        dbUpdates.status = 'pending';
      }

      // Recurrence update (if specified)
      const newRecurrence = recurrence || recurrenceRule || updates.recurrence || updates.recurrenceRule || updates.recurrence_rule;
      if (newRecurrence !== undefined) {
        if (enforceBilling && newRecurrence && !userHasPro) {
          const errorMsg = language === 'en'
            ? 'Recurring reminders require a Reminder Pro subscription.'
            : 'Para programar recordatorios recurrentes, se requiere una suscripción a Reminder Pro.';
          return {
            success: false,
            action: 'pro_tier_required',
            errorCode: 'PRO_TIER_REQUIRED',
            isProFeature: true,
            error: errorMsg,
            rawSummary: errorMsg,
          };
        }
        dbUpdates.recurrence_rule = newRecurrence;
      }

      if (Object.keys(dbUpdates).length === 0) {
        return {
          success: false,
          action: 'no_updates_provided',
          errorCode: 'INVALID_PARAMETERS',
          error: language === 'en'
            ? 'No update fields provided.'
            : 'No se especificaron cambios para el recordatorio.',
          rawSummary: language === 'en'
            ? 'No update fields provided.'
            : 'No se especificaron cambios para el recordatorio.',
        };
      }

      const updated = await updateReminder(targetReminderId, dbUpdates, userId, phoneNumber);

      if (!updated) {
        return {
          success: false,
          action: 'reminder_not_found',
          errorCode: 'NOT_FOUND',
          error: language === 'en'
            ? 'Reminder not found or access denied.'
            : 'No se encontró el recordatorio o no tienes permisos sobre él.',
          rawSummary: language === 'en'
            ? 'Reminder not found.'
            : 'No se encontró el recordatorio especificado.',
          confirmation: language === 'en'
            ? '⚠️ Reminder not found.'
            : '⚠️ No se encontró el recordatorio especificado.',
        };
      }

      const formattedTime = formatHumanFriendlyDateTime(new Date(updated.send_at), timezone, language);
      const formattedCard = formatReminderUpdatedCard(updated, formattedTime, timezone, language);

      return {
        success: true,
        action: 'updated_reminder',
        data: {
          id: updated.id,
          content: updated.content,
          sendAt: updated.send_at,
          formattedTime,
          recurrenceRule: updated.recurrence_rule,
        },
        rawSummary: formattedCard,
        formattedCard,
        confirmation: formattedCard,
      };
    }

    case 'cancel': {
      const { reminderId = null, scope = null, cancelAll = false } = params;
      let cancelledCount = 0;
      let targetId = reminderId || params.id || params.target || params.contentQuery || params.query || null;

      if (!targetId && scope !== 'all' && !cancelAll) {
        const refRes = resolveEntityReference({
          userOrPhone: user || phoneNumber,
          reference: userMessage || '',
          preferredType: 'reminder',
        });
        if (refRes.status === 'RESOLVED') {
          targetId = refRes.item.internalId;
        } else if (refRes.status === 'AMBIGUOUS') {
          return {
            success: false,
            action: 'ambiguous_target',
            errorCode: 'AMBIGUOUS_TARGET',
            error: language === 'en'
              ? 'Multiple reminders match your request. Please clarify which one you want to cancel.'
              : 'Hay múltiples recordatorios que coinciden. Por favor aclara cuál deseas cancelar.',
            rawSummary: 'Hay múltiples recordatorios que coinciden. Por favor aclara cuál deseas cancelar.',
            confirmation: 'Hay múltiples recordatorios que coinciden. Por favor aclara cuál deseas cancelar.',
          };
        }
      }

      // 1. Missing Target Guard: single-reminder cancellation strictly REQUIRES reminderId
      if (!targetId && scope !== 'all' && !cancelAll) {
        return {
          success: false,
          action: 'missing_target_id',
          errorCode: 'MISSING_TARGET_ID',
          error: language === 'en' ? 'Missing reminder ID to cancel. Please specify which reminder you want to cancel.' : 'Falta el ID del recordatorio a cancelar. Por favor especifica cuál recordatorio deseas cancelar.',
          rawSummary: language === 'en' ? 'Which reminder would you like me to cancel?' : '¿Cuál recordatorio deseas que cancele?',
          confirmation: language === 'en' ? 'Which reminder would you like me to cancel?' : '¿Cuál recordatorio deseas que cancele?',
        };
      }

      if (targetId) {
        if (targetId.length < 36) {
          const isOrdinal = /^(#?\d+|el\s+\d+|primero|primera|segundo|segunda|tercero|tercera|cuarto|cuarta|quinto|quinta|el\s+primero|la\s+primera|el\s+segundo|la\s+segunda|el\s+mas\s+temprano|el\s+más\s+temprano|el\s+ultimo|el\s+último)$/i.test(targetId);
          const pending = !isOrdinal ? await getRemindersByPhone(phoneNumber, 'pending', 50) : null;
          const matched = pending ? pending.find(r => r.id === targetId || r.id.startsWith(targetId)) : null;
          if (matched) {
            targetId = matched.id;
          } else {
            const refRes = resolveEntityReference({
              userOrPhone: user || phoneNumber,
              reference: targetId,
              candidates: pending,
              preferredType: 'reminder',
            });
            if (refRes.status === 'RESOLVED') {
              targetId = refRes.item.internalId;
            } else if (refRes.status === 'AMBIGUOUS') {
              return {
                success: false,
                action: 'ambiguous_target',
                errorCode: 'AMBIGUOUS_TARGET',
                error: language === 'en'
                  ? 'Multiple reminders match. Please clarify which one you want to cancel.'
                  : 'Hay múltiples recordatorios que coinciden. Por favor aclara cuál deseas cancelar.',
                rawSummary: 'Hay múltiples recordatorios que coinciden.',
                confirmation: 'Hay múltiples recordatorios que coinciden. Por favor aclara cuál deseas cancelar.',
              };
            } else {
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
        confirmation: formattedCard,
      };
    }

    case 'acknowledge': {
      const { reminderId = null, contentQuery = null, query = null, scope = null, acknowledgeAll = false } = params;
      const userId = user?.id || null;
      let rawTarget = reminderId || contentQuery || query || params.target || null;

      const cleanPhone = phoneNumber ? normalizePhoneNumber(phoneNumber) || phoneNumber : null;
      const userPhoneVariants = Array.from(new Set([
        phoneNumber,
        cleanPhone,
        cleanPhone ? `+${cleanPhone}` : null,
      ].filter(Boolean)));

      if (scope === 'all' || acknowledgeAll) {
        const ackRes = await acknowledgeReminders({ userId, phoneNumber });
        return {
          success: true,
          action: 'acknowledged_reminders_batch',
          data: ackRes,
          rawSummary: `Se confirmaron ${ackRes.acknowledgedCount} recordatorio(s).`,
          confirmation: `✅ Se confirmaron ${ackRes.acknowledgedCount} recordatorio(s) pendiente(s).`,
        };
      }

      let matched = null;
      const targetStr = String(rawTarget || userMessage || '').trim();
      const isAffirmative = /^(listo|ok|ya|hecho|completado|ya\s+lo\s+hice|ya\s+fui|fui|ya\s+hable|ya\s+hablé|ya\s+escribi|ya\s+escribí|ya\s+compre|ya\s+compré|ya\s+esta|ya\s+está|terminado|ya\s+termine|ya\s+terminé|si|sí)$/i.test(targetStr);
      const isOrdinal = /^(#?\d+|el\s+\d+|primero|primera|segundo|segunda|tercero|tercera|cuarto|cuarta|quinto|quinta|el\s+primero|la\s+primera|el\s+segundo|la\s+segunda|el\s+mas\s+temprano|el\s+más\s+temprano|el\s+ultimo|el\s+último)$/i.test(targetStr);

      // 1. Direct UUID Lookup: If explicit 36-char UUID is given
      if (rawTarget && String(rawTarget).trim().length === 36) {
        try {
          const { data: directRem } = await supabase
            .from('reminders')
            .select('*')
            .eq('id', String(rawTarget).trim())
            .maybeSingle();
          if (directRem) {
            matched = directRem;
          }
        } catch (_) {}
      }

      // 2. Working Memory Notification Context (Hermes just sent a notification/nudge or relative ref)
      if (!matched) {
        const wm = getWorkingMemory(user || phoneNumber);
        if (wm && wm.items && wm.items.length > 0) {
          if (isAffirmative || isOrdinal || !rawTarget || wm.lastAction === 'nudge' || wm.lastAction === 'reminder_dispatched') {
            let targetWmId = null;
            if (isOrdinal) {
              const ordRes = resolveEntityReference({ userOrPhone: user || phoneNumber, reference: targetStr });
              if (ordRes.status === 'RESOLVED' && ordRes.item?.internalId) {
                targetWmId = ordRes.item.internalId;
              }
            } else {
              targetWmId = wm.items[0].internalId;
            }

            if (targetWmId) {
              try {
                const { data: wmRem } = await supabase
                  .from('reminders')
                  .select('*')
                  .eq('id', targetWmId)
                  .maybeSingle();
                if (wmRem && wmRem.status !== 'cancelled') {
                  matched = wmRem;
                }
              } catch (_) {}
            }
          }
        }
      }

      // 3. Database Candidates Lookup
      if (!matched && (rawTarget || isAffirmative)) {
        let pendingQ = supabase
          .from('reminders')
          .select('*')
          .neq('status', 'cancelled')
          .is('acknowledged_at', null);

        if (userId && userPhoneVariants.length > 0) {
          const phoneConditions = userPhoneVariants.map(p => `phone_number.eq.${p}`).join(',');
          pendingQ = pendingQ.or(`user_id.eq.${userId},${phoneConditions}`);
        } else if (userId) {
          pendingQ = pendingQ.eq('user_id', userId);
        } else if (userPhoneVariants.length > 0) {
          pendingQ = pendingQ.in('phone_number', userPhoneVariants);
        }

        const { data: userReminders } = await pendingQ.limit(50);
        const candidates = userReminders || [];

        if (candidates.length > 0) {
          // A. Exact ID or prefix match
          matched = candidates.find(r => r.id === targetStr || (targetStr.length >= 8 && r.id.startsWith(targetStr)));

          // B. Semantic query matching on reminder content (e.g. "veterinaria", "comprar vendaje")
          if (!matched && targetStr && !isAffirmative && !isOrdinal) {
            const refRes = resolveEntityReference({
              userOrPhone: user || phoneNumber,
              reference: targetStr,
              candidates: candidates,
              preferredType: 'reminder',
            });
            if (refRes.status === 'RESOLVED') {
              matched = candidates.find(r => r.id === refRes.item.internalId) || refRes.item.raw;
            } else if (refRes.status === 'AMBIGUOUS') {
              return {
                success: false,
                action: 'ambiguous_target',
                errorCode: 'AMBIGUOUS_TARGET',
                error: language === 'en'
                  ? 'Multiple reminders match your request. Please clarify which one you completed.'
                  : 'Hay más de un recordatorio que coincide con tu solicitud. Por favor aclara cuál de ellos completaste.',
                rawSummary: 'Hay más de un recordatorio que coincide.',
                confirmation: 'Hay más de un recordatorio que coincide con tu solicitud. Por favor aclara cuál de ellos completaste.',
              };
            }
          }

          // C. If affirmative / single candidate fallback
          if (!matched) {
            const sortedCandidates = candidates.slice().sort((a, b) => {
              const timeA = Math.max(
                a.last_nudged_at ? new Date(a.last_nudged_at).getTime() : 0,
                a.sent_at ? new Date(a.sent_at).getTime() : 0,
                a.send_at ? new Date(a.send_at).getTime() : 0
              );
              const timeB = Math.max(
                b.last_nudged_at ? new Date(b.last_nudged_at).getTime() : 0,
                b.sent_at ? new Date(b.sent_at).getTime() : 0,
                b.send_at ? new Date(b.send_at).getTime() : 0
              );
              return timeB - timeA;
            });

            const activeNudged = sortedCandidates.filter(r => (r.nudge_count && r.nudge_count > 0) || r.last_nudged_at);
            if (activeNudged.length === 1) {
              matched = activeNudged[0];
            } else if (isAffirmative && activeNudged.length > 1) {
              matched = activeNudged[0];
            } else if (candidates.length === 1) {
              matched = candidates[0];
            }
          }
        }
      }

      // 4. Idempotency Fallback: if already acknowledged
      if (!matched && (rawTarget || isAffirmative)) {
        let ackQ = supabase
          .from('reminders')
          .select('*')
          .neq('status', 'cancelled')
          .not('acknowledged_at', 'is', null);

        if (userId && userPhoneVariants.length > 0) {
          const phoneConditions = userPhoneVariants.map(p => `phone_number.eq.${p}`).join(',');
          ackQ = ackQ.or(`user_id.eq.${userId},${phoneConditions}`);
        } else if (userId) {
          ackQ = ackQ.eq('user_id', userId);
        } else if (userPhoneVariants.length > 0) {
          ackQ = ackQ.in('phone_number', userPhoneVariants);
        }

        const { data: ackedReminders } = await ackQ.order('acknowledged_at', { ascending: false }).limit(20);
        const alreadyAcked = ackedReminders || [];
        if (alreadyAcked.length > 0) {
          matched = alreadyAcked.find(r => r.id === targetStr || (targetStr.length >= 8 && r.id.startsWith(targetStr)))
            || alreadyAcked.find(r => r.content && targetStr && r.content.toLowerCase().includes(targetStr.toLowerCase()));

          if (!matched && isAffirmative) {
            matched = alreadyAcked[0];
          }
        }
      }

      // 5. Tenant Validation Guard
      if (matched) {
        const hasTenantInfo = Boolean(matched.user_id || matched.phone_number);
        const matchedPhoneNorm = normalizePhoneNumber(matched.phone_number) || matched.phone_number;
        const userPhoneNorm = normalizePhoneNumber(phoneNumber) || phoneNumber;
        const isOwner = (userId && matched.user_id === userId) ||
                        (userPhoneNorm && matchedPhoneNorm && userPhoneNorm === matchedPhoneNorm) ||
                        (phoneNumber && matched.phone_number === phoneNumber);
        if (hasTenantInfo && !isOwner) {
          matched = null;
        }
      }

      // Missing Target / Not Found Guard
      if (!matched) {
        return {
          success: false,
          action: 'reminder_not_found',
          errorCode: 'NOT_FOUND',
          error: language === 'en' ? 'Reminder not found or access denied.' : 'No se encontró el recordatorio o acceso denegado.',
          rawSummary: language === 'en' ? 'Reminder not found.' : 'No se encontró el recordatorio especificado.',
          confirmation: language === 'en' ? '⚠️ Reminder not found.' : '⚠️ No se encontró el recordatorio especificado.',
        };
      }

      const targetId = matched.id;
      let confirmedReminder = matched;
      if (!matched.acknowledged_at) {
        const acknowledged = await acknowledgeReminder(targetId, userId);
        if (!acknowledged) {
          return {
            success: false,
            action: 'database_error',
            errorCode: 'DATABASE_ERROR',
            error: 'Error de base de datos al confirmar el recordatorio.',
            confirmation: '⚠️ Ocurrió un error al confirmar el recordatorio.',
          };
        }
        confirmedReminder = acknowledged;
      }

      const cleanTitle = stripReminderPrefix(confirmedReminder.content || confirmedReminder.title || '');
      const formattedCard = formatReminderAcknowledgedCard(confirmedReminder, language);

      return {
        success: true,
        action: 'acknowledged_reminder',
        reminderId: confirmedReminder.id,
        title: cleanTitle,
        data: confirmedReminder,
        rawSummary: formattedCard,
        formattedCard,
        confirmation: formattedCard,
      };
    }

    case 'list': {
      const cleanPhone = phoneNumber ? normalizePhoneNumber(phoneNumber) || phoneNumber : null;
      const userPhoneVariants = Array.from(new Set([
        phoneNumber,
        cleanPhone,
        cleanPhone ? `+${cleanPhone}` : null,
      ].filter(Boolean)));

      const bounds = getDayBounds('today', timezone);
      const todayStartIso = bounds.timeMin.toISOString();
      const todayEndIso = bounds.timeMax.toISOString();

      let query = supabase.from('reminders').select('*');
      if (userId && userPhoneVariants.length > 0) {
        const phoneConditions = userPhoneVariants.map(p => `phone_number.eq.${p}`).join(',');
        query = query.or(`user_id.eq.${userId},${phoneConditions}`);
      } else if (userId) {
        query = query.eq('user_id', userId);
      } else if (userPhoneVariants.length > 0) {
        query = query.in('phone_number', userPhoneVariants);
      }

      const rawFilter = String(params.filter || params.type || params.scope || '').toLowerCase().trim();
      const userMsg = (userMessage || '').toLowerCase();

      let listType = 'pending';
      let formattedCard = '';
      let list = [];

      // 1. "Qué completé hoy" -> acknowledged_at in [todayStartIso, todayEndIso)
      if (rawFilter === 'completed_today' || params.status === 'completed' || /\b(complete|completé|completados|hice hoy|confirmados hoy)\b/i.test(userMsg)) {
        listType = 'completed_today';
        query = query
          .not('acknowledged_at', 'is', null)
          .gte('acknowledged_at', todayStartIso)
          .lt('acknowledged_at', todayEndIso)
          .order('acknowledged_at', { ascending: true });
        const { data } = await query;
        list = data || [];
        formattedCard = formatReminderCompletedTodayCard(list, timezone, language);
      }
      // 2. "Qué recordatorios creamos hoy" -> created_at in [todayStartIso, todayEndIso)
      else if (rawFilter === 'created_today' || /\b(creamos hoy|cree hoy|creé hoy|creados hoy|agendamos hoy)\b/i.test(userMsg)) {
        listType = 'created_today';
        query = query
          .neq('status', 'cancelled')
          .gte('created_at', todayStartIso)
          .lt('created_at', todayEndIso)
          .order('created_at', { ascending: true });
        const { data } = await query;
        list = data || [];
        formattedCard = formatReminderCreatedTodayCard(list, timezone, language);
      }
      // 3. "Qué pendientes nos quedan hoy" / "¿Qué falta por hacer hoy?" / "¿Qué queda para hoy?"
      // -> send_at in [nowIso, todayEndIso) AND status != cancelled AND acknowledged_at IS NULL
      else if (
        rawFilter === 'remaining_today' ||
        rawFilter === 'pending_remaining_today' ||
        rawFilter === 'rest_of_today' ||
        /\b(nos quedan hoy|nos queda hoy|nos queda pendiente hoy|nos quedan pendientes hoy|nos queda para hoy|nos quedan para hoy|me queda hoy|me quedan hoy|me queda para hoy|me quedan para hoy|quedan hoy|queda hoy|queda pendiente hoy|quedan pendientes hoy|falta por hacer hoy|faltan por hacer hoy|falta hoy|faltan hoy|queda para hoy|quedan para hoy|resto de hoy|lo que queda de hoy|restante de hoy|restantes de hoy)\b/i.test(userMsg)
      ) {
        listType = 'remaining_today';
        const nowIso = new Date().toISOString();
        query = query
          .neq('status', 'cancelled')
          .is('acknowledged_at', null)
          .gte('send_at', nowIso)
          .lt('send_at', todayEndIso)
          .order('send_at', { ascending: true });
        const { data } = await query;
        list = data || [];
        formattedCard = formatReminderRemainingTodayCard(list, timezone, language);
      }
      // 4. "Dame mis pendientes de hoy" -> send_at in [todayStartIso, todayEndIso) AND status != cancelled AND acknowledged_at IS NULL
      else if (rawFilter === 'pending_today' || rawFilter === 'today' || /\b(pendientes de hoy|para hoy|recordatorios de hoy)\b/i.test(userMsg)) {
        listType = 'pending_today';
        query = query
          .neq('status', 'cancelled')
          .is('acknowledged_at', null)
          .gte('send_at', todayStartIso)
          .lt('send_at', todayEndIso)
          .order('send_at', { ascending: true });
        const { data } = await query;
        list = data || [];
        formattedCard = formatReminderListCard(list, timezone, language);
      }
      // 5. Default / "Todos mis recordatorios pendientes"
      else {
        listType = 'pending_all';
        query = query
          .neq('status', 'cancelled')
          .is('acknowledged_at', null)
          .order('send_at', { ascending: true })
          .limit(50);
        const { data } = await query;
        list = data || [];
        formattedCard = formatReminderListCard(list, timezone, language);
      }

      const structuredItems = list.map((r, idx) => ({
        position: idx + 1,
        type: 'reminder',
        internalId: r.id,
        summary: r.content || r.title,
        time: r.send_at ? formatHumanFriendlyDateTime(new Date(r.send_at), timezone, language) : null,
        source: 'reminder',
        raw: r,
      }));

      return {
        success: true,
        action: 'listed_reminders',
        filter: listType,
        data: { reminders: list, items: structuredItems, filter: listType },
        rawSummary: formattedCard,
        formattedCard,
        confirmation: formattedCard,
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

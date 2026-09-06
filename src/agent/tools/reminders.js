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
} from '../../infrastructure/database/index.js';
import {
  parseTargetTime,
  formatLocalDateTime,
  formatHumanFriendlyDateTime,
  getDayBounds,
  shiftZonedCalendarDays,
  DEFAULT_TIMEZONE,
} from '../../shared/time.js';
import { normalizePhoneNumber, stripReminderPrefix } from '../../integrations/whatsapp/kapso-client.js';
import {
  formatReminderCreatedCard,
  formatReminderCreateOutcomeCard,
  formatReminderCancelledCard,
  formatReminderAcknowledgedCard,
  formatReminderUpdatedCard,
  formatReminderListCard,
  formatReminderCreatedTodayCard,
  formatReminderCompletedTodayCard,
  formatReminderRemainingTodayCard,
} from './formatters.js';
import { resolveEntityReference, getWorkingMemory } from '../core/working-memory.js';
import {
  isStrictUUID,
  UUID_REGEX,
  normalizeTextForMatching,
  stripConversationalWrappers,
  isStandaloneAffirmative,
  parseOrdinalReference,
  calculateMatchScore,
} from '../../shared/entity-resolution.js';
import { getOrCreateCanonicalPlan } from '../../integrations/mercado-pago/client.js';

const PRO_UPGRADE_FALLBACK = {
  price: 49900,
  currency: 'COP',
  reason: 'Hermes TempleLabs Pro',
  fallbackCheckoutUrl: 'https://www.mercadopago.com.co/subscriptions',
  ctaHeader: '💎 Reminder Pro',
};

async function resolveProUpgradeContext(phoneNumber, language = 'es') {
  const context = {
    checkoutUrl: null,
    amount: PRO_UPGRADE_FALLBACK.price,
    currency: PRO_UPGRADE_FALLBACK.currency,
    ctaHeader: PRO_UPGRADE_FALLBACK.ctaHeader,
    ctaButtonText: language === 'en' ? 'Pay now' : 'Pagar ahora',
    fallbackCheckoutUrl: PRO_UPGRADE_FALLBACK.fallbackCheckoutUrl,
  };

  try {
    const plan = await getOrCreateCanonicalPlan({
      reason: PRO_UPGRADE_FALLBACK.reason,
      amount: PRO_UPGRADE_FALLBACK.price,
      currency: PRO_UPGRADE_FALLBACK.currency,
      phoneNumber,
    });

    context.checkoutUrl = plan?.init_point || plan?.checkout_url || null;
    if (plan?.amount) {
      const parsedAmount = Number(plan.amount);
      context.amount = Number.isFinite(parsedAmount) ? parsedAmount : context.amount;
    }

    if (plan?.currency) {
      context.currency = String(plan.currency);
    }
  } catch (err) {
    console.warn('[reminderTools] Failed to resolve Reminder Pro checkout link:', err.message);
  }

  return context;
}

function localDateKey(date, timezone) {
  return date.toLocaleDateString('sv-SE', { timeZone: timezone });
}

function localClock(date, timezone, language) {
  const locale = language === 'en' ? 'en-US' : language === 'pt' ? 'pt-BR' : 'es-CO';
  return date.toLocaleTimeString(locale, {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
  });
}

function buildTemporalRejection({
  content, code, sourceTimeText, advanceMinutes, mainDate, referenceDate,
  timezone, language, proposedReminder = null,
}) {
  const sameLocalDay = mainDate && localDateKey(mainDate, timezone) === localDateKey(referenceDate, timezone);
  const clock = mainDate ? localClock(mainDate, timezone, language) : '';
  const isEnglish = language === 'en';
  const reason = isEnglish ? 'the requested time has already passed.' : 'la hora indicada ya pasó.';
  const question = sameLocalDay && clock
    ? (isEnglish ? `Did you mean tomorrow at ${clock}?` : `¿Quieres que lo programe mañana a las ${clock}?`)
    : (isEnglish ? 'What new date and time should I use?' : '¿Qué nueva fecha y hora quieres usar?');
  return {
    type: 'reminder', content, code, reason, question, sourceTimeText,
    advanceMinutes: advanceMinutes || null,
    proposedReminder,
  };
}

function buildReminderProposal(item, targetDate) {
  if (!targetDate || Number.isNaN(targetDate.getTime())) return null;
  return {
    content: item.content,
    targetTime: targetDate.toISOString(),
    sourceTimeText: item.sourceTimeText,
    advanceMinutes: item.advanceMinutes || null,
    recurrence: item.recurrenceRule || null,
    requiresConfirmation: Boolean(item.requiresConfirmation),
    nudgeIntervalMinutes: item.nudgeIntervalMinutes || null,
    maxNudges: item.maxNudges || null,
    replacePending: Boolean(item.replacePending),
    checklist: Array.isArray(item.checklist) ? item.checklist : null,
  };
}

/**
 * Domain tool for managing reminders.
 */
export async function executeReminderTool(optionsOrAction, legacyParams = {}, legacyUser = null) {
  let action, params, user, isPro, language, correlationId, referenceTime, clarificationResolution;

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
    referenceTime = optionsOrAction?.referenceTime;
    clarificationResolution = optionsOrAction?.clarificationResolution === true;
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
      let itemsCandidate = params.items || params.create || params.reminders || (Array.isArray(params) ? params : null);
      if (itemsCandidate && typeof itemsCandidate === 'object' && !Array.isArray(itemsCandidate) && itemsCandidate.items) {
        itemsCandidate = itemsCandidate.items;
      }
      const rawItems = Array.isArray(itemsCandidate) && itemsCandidate.length > 0
        ? itemsCandidate
        : [params];
      const requestedReference = referenceTime instanceof Date ? referenceTime : new Date(referenceTime || Date.now());
      const referenceDate = Number.isNaN(requestedReference.getTime()) ? new Date() : requestedReference;
      const validatedItems = [];
      const rejectedItems = [];
      const savedReminders = [];

      for (const item of rawItems) {
        const content = item.content || item.reminder || item.text || item.title || '';
        const targetTime = item.targetTime || item.sendAt || item.time || item.date || '';
        const sourceTimeText = item.sourceTimeText || item.source_time_text || '';
        const advanceMinutes = item.advanceMinutes || item.advance_minutes || null;
        const advanceNoticeTime = item.advanceNoticeTime || item.advance_notice_time || null;
        const recurrenceRule = item.recurrence || item.recurrenceRule || item.recurrence_rule || null;
        const requiresConfirmation = item.requiresConfirmation || item.requires_confirmation || false;
        const nudgeIntervalMinutes = item.nudgeIntervalMinutes || item.nudge_interval_minutes || null;
        const maxNudges = item.maxNudges || item.max_nudges || null;
        const replacePending = item.replacePending || item.replace_pending || false;
        const checklist = item.checklist || null;
        const enforceBilling = shouldEnforceBillingForUser(user);

        if (!content) {
          rejectedItems.push({
            type: 'reminder', content: language === 'en' ? 'Untitled reminder' : 'Recordatorio sin título',
            code: 'INVALID_PARAMETERS',
            reason: language === 'en' ? 'the reminder content is missing.' : 'falta el contenido del recordatorio.',
          });
          continue;
        }

        if (!targetTime) {
          rejectedItems.push({
            type: 'reminder', content, code: 'MISSING_REQUIRED_CONTEXT',
            reason: language === 'en' ? 'the date and time are missing.' : 'falta la fecha y hora.',
            question: language === 'en'
              ? `When should I remind you about “${content}”?`
              : `¿Cuándo quieres que te recuerde “${content}”?`,
            sourceTimeText,
            advanceMinutes: advanceMinutes || null,
          });
          continue;
        }

        if (enforceBilling && recurrenceRule && !userHasPro) {
          rejectedItems.push({
            type: 'reminder', content, code: 'PRO_TIER_REQUIRED',
            proFeature: 'recurrence',
            reason: language === 'en'
              ? 'recurring reminders require Reminder Pro.'
              : 'los recordatorios recurrentes requieren Reminder Pro.',
            sourceTimeText, advanceMinutes: advanceMinutes || null,
          });
          continue;
        }

        const mainDate = parseTargetTime(targetTime, timezone, referenceDate, {
          // Native provider calls always carry sourceTimeText and may never
          // roll silently. Legacy direct callers retain their old behavior.
          rollForwardTimeOnly: !sourceTimeText,
        });
        if (!mainDate || isNaN(mainDate.getTime())) {
          rejectedItems.push({
            type: 'reminder', content, code: 'INVALID_TIME_FORMAT',
            reason: language === 'en' ? `I could not interpret “${targetTime}”.` : `no pude interpretar “${targetTime}”.`,
            question: language === 'en'
              ? `What date and time should I use for “${content}”?`
              : `¿Qué fecha y hora quieres usar para “${content}”?`,
            sourceTimeText,
            advanceMinutes: advanceMinutes || null,
          });
          continue;
        }

        if (mainDate.getTime() <= referenceDate.getTime()) {
          const isSameLocalDay = localDateKey(mainDate, timezone) === localDateKey(referenceDate, timezone);
          const proposedDate = isSameLocalDay ? shiftZonedCalendarDays(mainDate, 1, timezone) : null;
          const proposedReminder = buildReminderProposal({
            content, sourceTimeText, advanceMinutes, recurrenceRule, requiresConfirmation,
            nudgeIntervalMinutes, maxNudges, replacePending, checklist,
          }, proposedDate);
          rejectedItems.push(buildTemporalRejection({
            content, code: 'TIME_IN_PAST', sourceTimeText, advanceMinutes,
            mainDate, referenceDate, timezone, language, proposedReminder,
          }));
          continue;
        }

        // Check Pro Tier Restriction (Future Days & Recurrence) if user is subject to billing enforcement
        if (enforceBilling) {
          const userDateStr = referenceDate.toLocaleDateString('sv-SE', { timeZone: timezone });
          const targetDateStr = mainDate.toLocaleDateString('sv-SE', { timeZone: timezone });
          const diffMs = mainDate.getTime() - referenceDate.getTime();
          // Future day if different date and beyond 3 hours from now
          const isFutureDay = (targetDateStr !== userDateStr && diffMs > 3 * 60 * 60 * 1000) || (diffMs > 24 * 60 * 60 * 1000);
          const isRecurring = Boolean(recurrenceRule);

          if ((isFutureDay || isRecurring) && !userHasPro) {
            const proFeature = isRecurring ? 'recurrence' : 'future_day';
            const errorMsg = language === 'en'
              ? (isRecurring
                ? 'recurring reminders require Reminder Pro.'
                : 'reminders for future days require Reminder Pro.')
              : (isRecurring
                ? 'los recordatorios recurrentes requieren Reminder Pro.'
                : 'los recordatorios para días futuros requieren Reminder Pro.');
            rejectedItems.push({
              type: 'reminder', content, code: 'PRO_TIER_REQUIRED', reason: errorMsg,
              proFeature,
              sourceTimeText,
              formattedTime: formatHumanFriendlyDateTime(mainDate, timezone, language),
              advanceMinutes: advanceMinutes || null,
            });
            continue;
          }
        }

        let advDate = null;
        if (advanceNoticeTime) {
          advDate = parseTargetTime(advanceNoticeTime, timezone, referenceDate, { rollForwardTimeOnly: false });
        } else if (advanceMinutes) {
          advDate = new Date(mainDate.getTime() - advanceMinutes * 60 * 1000);
        }

        validatedItems.push({
          content, mainDate, advDate, advanceMinutes, recurrenceRule, requiresConfirmation,
          nudgeIntervalMinutes, maxNudges, replacePending, checklist, sourceTimeText,
        });
      }

      for (const item of validatedItems) {
        const {
          content, mainDate, advDate, advanceMinutes, recurrenceRule, requiresConfirmation,
          nudgeIntervalMinutes, maxNudges, replacePending, checklist, sourceTimeText,
        } = item;

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
        if (advDate) {
          if (advDate.getTime() > referenceDate.getTime()) {
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
                displayContent: content,
                isAdvanceNotice: true,
                sendAt: advDate.toISOString(),
                formattedTime: formatHumanFriendlyDateTime(advDate, timezone, language),
              });
            }
          } else {
            rejectedItems.push({
              type: 'advance_notice',
              content: language === 'en' ? `Advance notice for ${content}` : `Aviso previo de ${content}`,
              code: 'ADVANCE_TIME_IN_PAST',
              reason: language === 'en'
                ? 'the requested advance-notice moment has already passed; the main reminder was still scheduled.'
                : 'el momento del aviso previo ya pasó; el recordatorio principal sí fue programado.',
              sourceTimeText,
            });
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
          isAdvanceNotice: false,
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

      const pendingClarifications = rejectedItems
        .filter((item) => Boolean(item.question))
        .map((item) => ({
          type: 'reminder', content: item.content, sourceTimeText: item.sourceTimeText,
          advanceMinutes: item.advanceMinutes, reason: item.reason, question: item.question,
          proposedReminder: item.proposedReminder || null,
        }));
      const hasProRequirement = rejectedItems.some((item) => item.code === 'PRO_TIER_REQUIRED');
      const proUpgrade = hasProRequirement
        ? await resolveProUpgradeContext(phoneNumber, language)
        : null;
      const formattedCard = formatReminderCreateOutcomeCard(
        {
          created: savedReminders,
          rejected: rejectedItems,
          proUpgrade: proUpgrade
            ? {
              checkoutUrl: proUpgrade.checkoutUrl || proUpgrade.fallbackCheckoutUrl,
              amount: proUpgrade.amount,
              currency: proUpgrade.currency,
            }
            : null,
        }, timezone, language,
      );

      if (savedReminders.length === 0) {
        const firstError = rejectedItems[0] || {};
        const failureAction = firstError.code === 'PRO_TIER_REQUIRED'
          ? 'tier_limit_exceeded'
          : (pendingClarifications.length > 0 ? 'reminder_clarification_required' : 'reminders_not_created');
        return {
          success: false,
          action: failureAction,
          errorCode: firstError.code || 'INVALID_PARAMETERS',
          isProFeature: firstError.code === 'PRO_TIER_REQUIRED',
          error: firstError.reason || (language === 'en' ? 'No reminders were created.' : 'No se creó ningún recordatorio.'),
          rawSummary: formattedCard,
          formattedCard,
          requiresClarification: pendingClarifications.length > 0,
          pendingClarifications,
          data: {
            items: [],
            rejected: rejectedItems,
            pendingClarifications,
            checkout_url: proUpgrade?.checkoutUrl || proUpgrade?.fallbackCheckoutUrl || null,
            checkoutUrl: proUpgrade?.checkoutUrl || proUpgrade?.fallbackCheckoutUrl || null,
          },
          ctaUrl: proUpgrade?.checkoutUrl || proUpgrade?.fallbackCheckoutUrl || null,
          ctaHeader: proUpgrade?.ctaHeader || null,
          ctaButtonText: proUpgrade?.ctaButtonText || null,
          complete: false,
        };
      }

      if (rejectedItems.length > 0) {
        return {
          success: true,
          partialSuccess: true,
          complete: false,
          action: 'partially_created_reminders',
          data: {
            items: savedReminders,
            rejected: rejectedItems,
            pendingClarifications,
            checkout_url: proUpgrade?.checkoutUrl || proUpgrade?.fallbackCheckoutUrl || null,
            checkoutUrl: proUpgrade?.checkoutUrl || proUpgrade?.fallbackCheckoutUrl || null,
          },
          rawSummary: formattedCard,
          formattedCard,
          ctaUrl: proUpgrade?.checkoutUrl || proUpgrade?.fallbackCheckoutUrl || null,
          ctaHeader: proUpgrade?.ctaHeader || null,
          ctaButtonText: proUpgrade?.ctaButtonText || null,
          requiresClarification: pendingClarifications.length > 0,
          pendingClarifications,
        };
      }

      return {
        success: true,
        action: 'created_reminders_batch',
        data: savedReminders,
        rawSummary: formatReminderCreatedCard(savedReminders, timezone, language),
        formattedCard: formatReminderCreatedCard(savedReminders, timezone, language),
      };
    }

    case 'update': {
      const payNowLabel = language === 'en' ? 'Pay now' : 'Pagar ahora';
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

      const targetReminderId = reminderId || params.target || params.id || updates.reminderId || updates.id;

      // 0. Advance Notice Guard ("avísame 15 minutos antes", "recuérdame 30 mins antes"):
      // If the intent is an advance notice relative to an existing reminder, CREATE a new reminder instead of overwriting.
      const isAdvanceNotice = params.advanceMinutes !== undefined ||
                              params.isAdvanceNotice === true;

      if (isAdvanceNotice) {
        let targetId = targetReminderId;
        const pending = await getRemindersByPhone(phoneNumber, 'pending', 50);

        if (targetId && !isStrictUUID(targetId) && pending.length > 0) {
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
        } else {
          const wm = getWorkingMemory(user || phoneNumber);
          const activeReminderId = wm?.entityType === 'reminder' && wm.items?.length === 1
            ? wm.items[0].internalId
            : null;
          if (activeReminderId) {
            baseReminder = pending.find((reminder) => reminder.id === activeReminderId) || null;
          }
        }

        if (baseReminder && baseReminder.send_at) {
          let advMins = params.advanceMinutes || 15;

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

      let resolvedTargetReminderId = targetReminderId;
      if (!isStrictUUID(resolvedTargetReminderId)) {
        const pending = await getRemindersByPhone(phoneNumber, 'pending', 50);
        const refRes = resolveEntityReference({
          userOrPhone: user || phoneNumber,
          reference: String(resolvedTargetReminderId),
          candidates: pending,
          preferredType: 'reminder',
        });
        if (refRes.status === 'RESOLVED') {
          resolvedTargetReminderId = refRes.item.internalId;
        }
      }

      const dbUpdates = {};

      // Content update (if specified)
      const newContent = content || text || updates.content || updates.text;
      if (newContent) {
        dbUpdates.content = String(newContent).trim();
      }

      // Time / Date update (if specified)
      const rawTargetTime = targetTime || sendAt || updates.targetTime || updates.sendAt || updates.time || updates.date;
      const enforceBilling = shouldEnforceBillingForUser(user);
      if (rawTargetTime) {
        const parsedDate = parseTargetTime(rawTargetTime, timezone, referenceTime);
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
        const todayDateStr = new Date().toLocaleDateString('en-CA', { timeZone: timezone });
        const reminderDateStr = parsedDate.toLocaleDateString('en-CA', { timeZone: timezone });
        const isFutureDay = reminderDateStr > todayDateStr;

        if (enforceBilling && isFutureDay && !userHasPro) {
          const proUpgrade = await resolveProUpgradeContext(phoneNumber, language);
          const checkoutUrl = proUpgrade?.checkoutUrl || proUpgrade?.fallbackCheckoutUrl;
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
            formattedCard: `${errorMsg}\n\n💳 *Enlace de pago (Mercado Pago):* ${checkoutUrl || 'https://www.mercadopago.com.co/subscriptions'}\n👉 *${payNowLabel}*`,
            data: {
              reason: 'pro_tier_limit',
              targetDate: parsedDate.toISOString(),
              checkout_url: checkoutUrl || null,
              checkoutUrl,
            },
            ctaUrl: checkoutUrl || null,
            ctaHeader: proUpgrade?.ctaHeader || null,
            ctaButtonText: proUpgrade?.ctaButtonText || null,
          };
        }

        dbUpdates.send_at = parsedDate.toISOString();
        dbUpdates.status = 'pending';
      }

      // Recurrence update (if specified)
      const newRecurrence = recurrence || recurrenceRule || updates.recurrence || updates.recurrenceRule || updates.recurrence_rule;
      if (newRecurrence !== undefined) {
        if (enforceBilling && newRecurrence && !userHasPro) {
          const proUpgrade = await resolveProUpgradeContext(phoneNumber, language);
          const checkoutUrl = proUpgrade?.checkoutUrl || proUpgrade?.fallbackCheckoutUrl;
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
            formattedCard: `${errorMsg}\n\n💳 *Enlace de pago (Mercado Pago):* ${checkoutUrl || 'https://www.mercadopago.com.co/subscriptions'}\n👉 *${payNowLabel}*`,
            data: {
              reason: 'pro_tier_limit',
              checkout_url: checkoutUrl || null,
              checkoutUrl,
            },
            ctaUrl: checkoutUrl || null,
            ctaHeader: proUpgrade?.ctaHeader || null,
            ctaButtonText: proUpgrade?.ctaButtonText || null,
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

      const updated = await updateReminder(resolvedTargetReminderId, dbUpdates, userId, phoneNumber);

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
      const failedCandidates = [];
      let targetId = reminderId || params.id || params.target || params.contentQuery || params.query || null;
      const bulkScope = scope === 'elapsed' ? 'elapsed' : ((scope === 'all' || cancelAll) ? 'all' : null);
      const requestedReference = referenceTime instanceof Date ? referenceTime : new Date(referenceTime || Date.now());
      const cancellationReference = Number.isNaN(requestedReference.getTime()) ? new Date() : requestedReference;
      const suppliedCutoff = params.cutoffAt ? new Date(params.cutoffAt) : null;
      const cutoffDate = suppliedCutoff && !Number.isNaN(suppliedCutoff.getTime())
        ? suppliedCutoff
        : cancellationReference;

      const cleanPhone = phoneNumber ? normalizePhoneNumber(phoneNumber) || phoneNumber : null;
      const userPhoneVariants = Array.from(new Set([
        phoneNumber,
        cleanPhone,
        cleanPhone ? `+${cleanPhone}` : null,
      ].filter(Boolean)));

      // A single/all-active cancellation uses the live lifecycle set. An
      // elapsed cleanup is a temporal collection operation and intentionally
      // includes historical lifecycle states while excluding rows that were
      // already cancelled.
      let cancelableQ = supabase
        .from('reminders')
        .select('*');

      if (bulkScope === 'elapsed') {
        cancelableQ = cancelableQ
          .neq('status', 'cancelled')
          .lt('send_at', cutoffDate.toISOString());
      } else {
        cancelableQ = cancelableQ
          .in('status', ['pending', 'sent'])
          .is('acknowledged_at', null);
      }

      if (userId && userPhoneVariants.length > 0) {
        const phoneConditions = userPhoneVariants.map(p => `phone_number.eq.${p}`).join(',');
        cancelableQ = cancelableQ.or(`user_id.eq.${userId},${phoneConditions}`);
      } else if (userId) {
        cancelableQ = cancelableQ.eq('user_id', userId);
      } else if (userPhoneVariants.length > 0) {
        cancelableQ = cancelableQ.in('phone_number', userPhoneVariants);
      }

      const { data: cancelableReminders, error: cancelableError } = await cancelableQ
        .order('send_at', { ascending: false })
        .limit(bulkScope ? 500 : 50);
      if (cancelableError) {
        const message = language === 'en'
          ? 'I could not verify the reminders to cancel.'
          : 'No pude verificar los recordatorios que se cancelarían.';
        return {
          success: false,
          action: 'database_error',
          errorCode: 'DATABASE_ERROR',
          error: message,
          rawSummary: message,
          confirmation: `⚠️ ${message}`,
        };
      }
      const candidates = cancelableReminders || [];

      if (bulkScope && candidates.length === 0) {
        const message = bulkScope === 'elapsed'
          ? (language === 'en'
            ? 'There are no elapsed reminders to remove.'
            : 'No hay recordatorios cuya hora ya haya pasado para eliminar.')
          : (language === 'en'
            ? 'There are no active reminders to cancel.'
            : 'No hay recordatorios activos para cancelar.');
        return {
          success: true,
          complete: true,
          action: 'no_reminders_to_cancel',
          data: { cancelledCount: 0, remainingCount: 0, scope: bulkScope },
          rawSummary: message,
          formattedCard: message,
          confirmation: message,
        };
      }

      if (bulkScope && !clarificationResolution) {
        const question = bulkScope === 'elapsed'
          ? (language === 'en'
            ? `I found ${candidates.length} reminder${candidates.length === 1 ? '' : 's'} whose scheduled time has passed. Should I remove ${candidates.length === 1 ? 'it' : 'them'} from your list?`
            : `Encontré ${candidates.length} ${candidates.length === 1 ? 'recordatorio cuya hora ya pasó' : 'recordatorios cuya hora ya pasó'}. ¿Quieres que ${candidates.length === 1 ? 'lo elimine' : 'los elimine'} de tu lista?`)
          : (language === 'en'
            ? `Should I cancel all ${candidates.length} active reminder${candidates.length === 1 ? '' : 's'}?`
            : `¿Quieres que cancele los ${candidates.length} recordatorios activos?`);
        const proposedOperation = {
          kind: 'reminder_cancel',
          scope: bulkScope,
          ...(bulkScope === 'elapsed' ? { cutoffAt: cutoffDate.toISOString() } : {}),
        };
        const pendingClarifications = [{
          type: 'reminder_cancellation',
          content: bulkScope === 'elapsed'
            ? (language === 'en' ? 'Remove elapsed reminders' : 'Eliminar recordatorios cuya hora ya pasó')
            : (language === 'en' ? 'Cancel all active reminders' : 'Cancelar todos los recordatorios activos'),
          question,
          proposedOperation,
        }];
        const formattedCard = `⚠️ *${language === 'en' ? 'Confirmation required' : 'Confirmación necesaria'}*\n\n${question}`;
        return {
          success: false,
          complete: false,
          action: 'reminder_cancellation_confirmation_required',
          errorCode: 'CONFIRMATION_REQUIRED',
          error: question,
          rawSummary: formattedCard,
          formattedCard,
          confirmation: formattedCard,
          requiresClarification: true,
          pendingClarifications,
          data: { pendingClarifications, candidateCount: candidates.length },
        };
      }

      if (!targetId && !bulkScope) {
        const refRes = resolveEntityReference({
          userOrPhone: user || phoneNumber,
          reference: userMessage || '',
          candidates,
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
      if (!targetId && !bulkScope) {
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
        let existingReminder = null;
        if (!isStrictUUID(targetId)) {
          const matched = candidates.find(r => r.id === targetId || (targetId.length >= 8 && r.id.startsWith(targetId)));
          if (matched) {
            targetId = matched.id;
          } else {
            const refRes = resolveEntityReference({
              userOrPhone: user || phoneNumber,
              reference: targetId,
              candidates,
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

        // Strict UUID tenant & lifecycle guard
        const { data: existingRem } = await supabase
          .from('reminders')
          .select('id, user_id, phone_number, status, acknowledged_at')
          .eq('id', targetId)
          .maybeSingle();
        existingReminder = existingRem || null;

        if (existingRem) {
          const isOwner = (userId && existingRem.user_id === userId) ||
            (existingRem.phone_number && userPhoneVariants.includes(existingRem.phone_number));
          if (!isOwner) {
            return {
              success: false,
              action: 'access_denied',
              errorCode: 'ACCESS_DENIED',
              error: language === 'en' ? 'Access denied: this reminder belongs to another user.' : 'No tienes permisos sobre este recordatorio.',
              rawSummary: 'Acceso denegado.',
              confirmation: '⚠️ No tienes permisos sobre este recordatorio.',
            };
          }
          if (existingRem.status === 'cancelled') {
            return {
              success: false,
              action: 'reminder_not_found',
              errorCode: 'NOT_FOUND',
              error: language === 'en' ? 'Reminder already cancelled.' : 'El recordatorio ya fue cancelado previamente.',
              rawSummary: 'El recordatorio ya fue cancelado previamente.',
              confirmation: '⚠️ El recordatorio ya fue cancelado previamente.',
            };
          }
        }

        const cancellationUserId = existingReminder
          ? (existingReminder.user_id === userId ? userId : null)
          : userId;
        const cancellationPhone = cancellationUserId
          ? null
          : (existingReminder?.phone_number && userPhoneVariants.includes(existingReminder.phone_number)
            ? existingReminder.phone_number
            : phoneNumber);
        const marked = await markReminderAsCancelled(targetId, cancellationUserId, cancellationUserId ? null : cancellationPhone);
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
      } else if (bulkScope) {
        for (const r of candidates) {
          const cancellationUserId = r.user_id === userId ? userId : null;
          const cancellationPhone = cancellationUserId
            ? null
            : (r.phone_number && userPhoneVariants.includes(r.phone_number) ? r.phone_number : phoneNumber);
          const marked = await markReminderAsCancelled(
            r.id,
            cancellationUserId,
            cancellationPhone,
          );
          if (marked) cancelledCount++;
          else failedCandidates.push(r);
        }
      }

      const remaining = bulkScope ? failedCandidates : candidates.filter(c => c.id !== targetId);
      const failedCount = bulkScope ? failedCandidates.length : 0;
      const formattedCard = bulkScope === 'elapsed'
        ? (language === 'en'
          ? `🗑️ *Elapsed reminders removed*\n\nRemoved ${cancelledCount} reminder${cancelledCount === 1 ? '' : 's'} whose scheduled time had passed.${failedCount ? ` ${failedCount} could not be removed.` : ''}`
          : `🗑️ *Recordatorios anteriores eliminados*\n\nEliminé ${cancelledCount} ${cancelledCount === 1 ? 'recordatorio cuya hora ya había pasado' : 'recordatorios cuya hora ya había pasado'}.${failedCount ? ` No se pudieron eliminar ${failedCount}.` : ''}`)
        : formatReminderCancelledCard(cancelledCount, remaining.length, '', language);

      return {
        success: cancelledCount > 0 || candidates.length === 0,
        complete: failedCount === 0,
        partialSuccess: cancelledCount > 0 && failedCount > 0,
        action: failedCount > 0 ? 'partially_cancelled_reminders' : 'cancelled_reminders',
        data: {
          cancelledCount,
          remainingCount: remaining.length,
          scope: bulkScope || 'single',
          failedCount,
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
      const isAffirmative = isStandaloneAffirmative(targetStr);
      const isOrdinal = parseOrdinalReference(targetStr) !== null;

      // 1. Direct UUID Lookup: If explicit UUID is given
      if (rawTarget && isStrictUUID(String(rawTarget).trim())) {
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
        const notificationId = wm?.notificationReminderId || ((wm?.lastAction === 'nudge' || wm?.lastAction === 'reminder_dispatched') ? wm?.items?.[0]?.internalId : null);

        // If user responds to an active notification context with an affirmative ("Ya", "Listo", "OK") or userMessage is affirmative:
        // Bind strictly to the originating notification reminder ID, never search candidate titles!
        if (notificationId && (isAffirmative || !rawTarget || isStandaloneAffirmative(userMessage))) {
          try {
            const { data: notifRem } = await supabase
              .from('reminders')
              .select('*')
              .eq('id', notificationId)
              .maybeSingle();
            if (notifRem && notifRem.status !== 'cancelled') {
              matched = notifRem;
            }
          } catch (_) {}
        }

        if (!matched && wm && wm.items && wm.items.length > 0) {
          const stripped = stripConversationalWrappers(targetStr);
          const hasExplicitTarget = Boolean(stripped && !isAffirmative && !isOrdinal);

          if (hasExplicitTarget) {
            const ordRes = resolveEntityReference({
              userOrPhone: user || phoneNumber,
              reference: targetStr,
              preferredType: 'reminder',
            });
            if (ordRes.status === 'RESOLVED' && ordRes.item?.internalId) {
              try {
                const { data: wmRem } = await supabase
                  .from('reminders')
                  .select('*')
                  .eq('id', ordRes.item.internalId)
                  .maybeSingle();
                if (wmRem && wmRem.status !== 'cancelled') {
                  matched = wmRem;
                }
              } catch (_) {}
            }
          } else if (isAffirmative || isOrdinal || !rawTarget || wm.lastAction === 'nudge' || wm.lastAction === 'reminder_dispatched') {
            let targetWmId = null;
            if (isOrdinal) {
              const ordRes = resolveEntityReference({ userOrPhone: user || phoneNumber, reference: targetStr, preferredType: 'reminder' });
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
                a.sent_at ? new Date(a.sent_at).getTime() : 0
              );
              const timeB = Math.max(
                b.last_nudged_at ? new Date(b.last_nudged_at).getTime() : 0,
                b.sent_at ? new Date(b.sent_at).getTime() : 0
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
          const normTarget = normalizeTextForMatching(stripConversationalWrappers(targetStr));
          matched = alreadyAcked.find(r => r.id === targetStr || (targetStr.length >= 8 && r.id.startsWith(targetStr)))
            || alreadyAcked.find(r => r.content && normTarget && normalizeTextForMatching(r.content).includes(normTarget));

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
          return {
            success: false,
            action: 'access_denied',
            errorCode: 'ACCESS_DENIED',
            error: language === 'en' ? 'Access denied: this reminder belongs to another user.' : 'No tienes permisos sobre este recordatorio.',
            rawSummary: 'Acceso denegado.',
            confirmation: '⚠️ No tienes permisos sobre este recordatorio.',
          };
        }
      }

      // Missing Target / Not Found Guard
      if (!matched) {
        return {
          success: false,
          action: 'reminder_not_found',
          errorCode: 'NOT_FOUND',
          error: language === 'en' ? 'Reminder not found.' : 'No se encontró el recordatorio especificado.',
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
      const requestedReference = referenceTime instanceof Date ? referenceTime : new Date(referenceTime || Date.now());
      const listReferenceDate = Number.isNaN(requestedReference.getTime()) ? new Date() : requestedReference;
      const nowIso = listReferenceDate.toISOString();
      let listType = 'upcoming';
      let formattedCard = '';
      let list = [];

      // 1. "Qué completé hoy" -> acknowledged_at in [todayStartIso, todayEndIso)
      if (rawFilter === 'completed_today' || params.status === 'completed') {
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
      else if (rawFilter === 'created_today') {
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
      // -> send_at in [nowIso, todayEndIso) AND status=pending AND acknowledged_at IS NULL
      else if (
        rawFilter === 'remaining_today' ||
        rawFilter === 'pending_remaining_today' ||
        rawFilter === 'rest_of_today'
      ) {
        listType = 'remaining_today';
        query = query
          .eq('status', 'pending')
          .is('acknowledged_at', null)
          .gte('send_at', nowIso)
          .lt('send_at', todayEndIso)
          .order('send_at', { ascending: true });
        const { data } = await query;
        list = data || [];
        formattedCard = formatReminderRemainingTodayCard(list, timezone, language);
      }
      // 4. "Dame mis pendientes de hoy" -> send_at in [todayStartIso, todayEndIso) AND status=pending AND acknowledged_at IS NULL
      else if (rawFilter === 'pending_today' || rawFilter === 'today') {
        listType = 'pending_today';
        query = query
          .eq('status', 'pending')
          .is('acknowledged_at', null)
          .gte('send_at', todayStartIso)
          .lt('send_at', todayEndIso)
          .order('send_at', { ascending: true });
        const { data } = await query;
        list = data || [];
        formattedCard = formatReminderListCard(list, timezone, language);
      }
      // 5. Default / "Todos mis recordatorios pendientes"
      // A reminder is pending for delivery only while it is scheduled in the
      // future. Sent, failed, missed, cancelled, and elapsed rows are history,
      // even when an old row has no acknowledged_at value.
      else {
        listType = 'upcoming';
        query = query
          .eq('status', 'pending')
          .is('acknowledged_at', null)
          .gte('send_at', nowIso)
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

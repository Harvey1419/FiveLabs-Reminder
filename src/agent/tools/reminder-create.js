import {
  saveReminder,
  cancelPendingRemindersByContent,
  createTask,
  getUserSubscription,
  hasProAccess,
  shouldEnforceBillingForUser,
} from '../../infrastructure/database/index.js';
import {
  getReminderConfirmationPreference,
  getReminderDispatchPolicy,
} from '../../infrastructure/database/memories.js';
import {
  parseTargetTime,
  formatHumanFriendlyDateTime,
  shiftZonedCalendarDays,
  DEFAULT_TIMEZONE,
} from '../../shared/time.js';
import {
  formatReminderCreatedCard,
  formatReminderCreateOutcomeCard,
} from './formatters.js';
import { resolveReminderProUpgradeContext } from './reminder-pro.js';
import { buildAdvanceNoticeContent } from './reminder-advance.js';
import { computeNextRecurringSendAt } from '../../shared/reminder-recurrence.js';

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

function buildReminderProposal(item, targetDate) {
  if (!targetDate || Number.isNaN(targetDate.getTime())) return null;
  return {
    content: item.content,
    targetTime: targetDate.toISOString(),
    advanceMinutes: item.advanceMinutes || null,
    recurrence: item.recurrenceRule || null,
    requiresConfirmation: Boolean(item.requiresConfirmation),
    nudgeIntervalMinutes: item.nudgeIntervalMinutes || null,
    maxNudges: item.maxNudges || null,
    replacePending: Boolean(item.replacePending),
    checklist: Array.isArray(item.checklist) ? item.checklist : null,
  };
}

function buildTemporalRejection({
  content,
  advanceMinutes,
  mainDate,
  referenceDate,
  timezone,
  language,
  proposedReminder,
}) {
  const sameLocalDay = localDateKey(mainDate, timezone) === localDateKey(referenceDate, timezone);
  const clock = localClock(mainDate, timezone, language);
  const isEnglish = language === 'en';
  return {
    type: 'reminder',
    content,
    code: 'TIME_IN_PAST',
    reason: isEnglish ? 'the requested time has already passed.' : 'la hora indicada ya pasó.',
    question: sameLocalDay && clock
      ? (isEnglish ? `Did you mean tomorrow at ${clock}?` : `¿Quieres que lo programe mañana a las ${clock}?`)
      : (isEnglish ? 'What new date and time should I use?' : '¿Qué nueva fecha y hora quieres usar?'),
    advanceMinutes: advanceMinutes || null,
    proposedReminder,
  };
}

export async function executeReminderCreate({
  params = {},
  user = {},
  isPro = false,
  language = 'es',
  referenceTime = null,
} = {}) {
  const userId = user?.id;
  const phoneNumber = user?.phone_number;
  const timezone = user?.timezone || DEFAULT_TIMEZONE;
  const subscription = user?.subscription || (userId ? await getUserSubscription(userId) : null);
  const userHasPro = isPro || user?.is_admin === true || hasProAccess(subscription, user);
  const enforceBilling = shouldEnforceBillingForUser(user);

  const rawItems = Array.isArray(params.items) && params.items.length > 0 ? params.items : [];

  const requestedReference = referenceTime instanceof Date ? referenceTime : new Date(referenceTime || Date.now());
  const referenceDate = Number.isNaN(requestedReference.getTime()) ? new Date() : requestedReference;
  const validatedItems = [];
  const rejectedItems = [];
  const savedReminders = [];

  let dispatchPolicy = null;
  try {
    dispatchPolicy = (userId && typeof getReminderDispatchPolicy === 'function')
      ? await getReminderDispatchPolicy(userId)
      : null;
  } catch {
    dispatchPolicy = null;
  }

  for (const item of rawItems) {
    const content = item.content || '';
    const targetTime = item.targetTime || '';
    const advanceMinutes = item.advanceMinutes || null;
    const advanceNoticeTime = item.advanceNoticeTime || null;
    const recurrenceRule = item.recurrence || null;
    const isRecurring = Boolean(recurrenceRule);
    const scopePref = isRecurring ? dispatchPolicy?.recurring : dispatchPolicy?.global;
    const hasExplicitConfirmation = item.requiresConfirmation !== undefined && item.requiresConfirmation !== null;
    const requiresConfirmation = hasExplicitConfirmation
      ? Boolean(item.requiresConfirmation)
      : Boolean(scopePref?.requiresConfirmation);
    const nudgeIntervalMinutes = item.nudgeIntervalMinutes || (requiresConfirmation ? (scopePref?.nudgeIntervalMinutes || 15) : null);
    const maxNudges = item.maxNudges || null;
    const replacePending = item.replacePending || false;
    const checklist = item.checklist || null;

    if (!content) {
      rejectedItems.push({
        type: 'reminder',
        content: language === 'en' ? 'Untitled reminder' : 'Recordatorio sin título',
        code: 'INVALID_PARAMETERS',
        reason: language === 'en' ? 'the reminder content is missing.' : 'falta el contenido del recordatorio.',
      });
      continue;
    }

    if (!targetTime) {
      rejectedItems.push({
        type: 'reminder',
        content,
        code: 'MISSING_REQUIRED_CONTEXT',
        reason: language === 'en' ? 'the date and time are missing.' : 'falta la fecha y hora.',
        question: language === 'en'
          ? `When should I remind you about “${content}”?`
          : `¿Cuándo quieres que te recuerde “${content}”?`,
        advanceMinutes,
      });
      continue;
    }

    if (enforceBilling && recurrenceRule && !userHasPro) {
      rejectedItems.push({
        type: 'reminder',
        content,
        code: 'PRO_TIER_REQUIRED',
        proFeature: 'recurrence',
        reason: language === 'en'
          ? 'recurring reminders require Reminder Pro.'
          : 'los recordatorios recurrentes requieren Reminder Pro.',
        advanceMinutes,
      });
      continue;
    }

    const mainDate = parseTargetTime(targetTime, timezone, referenceDate);
    if (!mainDate || Number.isNaN(mainDate.getTime())) {
      rejectedItems.push({
        type: 'reminder',
        content,
        code: 'INVALID_TIME_FORMAT',
        reason: language === 'en' ? `I could not interpret “${targetTime}”.` : `no pude interpretar “${targetTime}”.`,
        question: language === 'en'
          ? `What date and time should I use for “${content}”?`
          : `¿Qué fecha y hora quieres usar para “${content}”?`,
        advanceMinutes,
      });
      continue;
    }

    const timeDiffMs = mainDate.getTime() - referenceDate.getTime();
    if (timeDiffMs < -60_000) {
      // Past time (more than 1 minute ago)
      const sameLocalDay = localDateKey(mainDate, timezone) === localDateKey(referenceDate, timezone);
      // For recurring reminders, compute the next future occurrence dynamically
      // across any frequency (daily, weekly, weekdays, hourly, hourly:N, etc.)
      if (recurrenceRule) {
        const rolledDate = computeNextRecurringSendAt(mainDate, recurrenceRule, referenceDate);
        if (rolledDate && rolledDate.getTime() > referenceDate.getTime()) {
          console.log(`[reminder-create] TIME_IN_PAST auto-rollforward content="${content}" rule=${recurrenceRule} from=${mainDate.toISOString()} to=${rolledDate.toISOString()}`);
          validatedItems.push({
            content,
            mainDate: rolledDate,
            advDate: advanceMinutes ? new Date(rolledDate.getTime() - advanceMinutes * 60 * 1000) : null,
            advanceMinutes,
            recurrenceRule,
            requiresConfirmation,
            nudgeIntervalMinutes,
            maxNudges,
            replacePending,
            checklist,
          });
          continue;
        }
      }
      const proposedDate = sameLocalDay ? shiftZonedCalendarDays(mainDate, 1, timezone) : null;
      rejectedItems.push(buildTemporalRejection({
        content,
        advanceMinutes,
        mainDate,
        referenceDate,
        timezone,
        language,
        proposedReminder: buildReminderProposal({
          content,
          advanceMinutes,
          recurrenceRule,
          requiresConfirmation,
          nudgeIntervalMinutes,
          maxNudges,
          replacePending,
          checklist,
        }, proposedDate),
      }));
      continue;
    } else if (timeDiffMs <= 0) {
      // Immediate time intent ("ya", "ahora", or execution latency <= 60 seconds)
      // Normalize by 1 second to ensure it is strictly future for any clock comparisons
      mainDate = new Date(referenceDate.getTime() + 1000);
    }

    if (enforceBilling) {
      const userDateStr = referenceDate.toLocaleDateString('sv-SE', { timeZone: timezone });
      const targetDateStr = mainDate.toLocaleDateString('sv-SE', { timeZone: timezone });
      const diffMs = mainDate.getTime() - referenceDate.getTime();
      const isFutureDay = (targetDateStr !== userDateStr && diffMs > 3 * 60 * 60 * 1000) || diffMs > 24 * 60 * 60 * 1000;
      if (isFutureDay && !userHasPro) {
        rejectedItems.push({
          type: 'reminder',
          content,
          code: 'PRO_TIER_REQUIRED',
          proFeature: 'future_day',
          reason: language === 'en'
            ? 'reminders for future days require Reminder Pro.'
            : 'los recordatorios para días futuros requieren Reminder Pro.',
          formattedTime: formatHumanFriendlyDateTime(mainDate, timezone, language),
          advanceMinutes,
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
      content,
      mainDate,
      advDate,
      advanceMinutes,
      recurrenceRule,
      requiresConfirmation,
      nudgeIntervalMinutes,
      maxNudges,
      replacePending,
      checklist,
    });
  }

  for (const item of validatedItems) {
    if (item.replacePending) {
      try {
        await cancelPendingRemindersByContent({ phoneNumber, contentQuery: item.content });
      } catch (err) {
        console.warn('[reminder-create] replacePending error:', err.message);
      }
    }

    if (item.advDate) {
      if (item.advDate.getTime() > referenceDate.getTime()) {
        const advContent = buildAdvanceNoticeContent(item.content, item.advanceMinutes || 15);
        const advReminder = await saveReminder({
          userId,
          phoneNumber,
          content: advContent,
          sendAt: item.advDate.toISOString(),
          requiresConfirmation: false,
        });
        if (advReminder) {
          savedReminders.push({
            id: advReminder.id,
            content: advContent,
            displayContent: item.content,
            isAdvanceNotice: true,
            sendAt: item.advDate.toISOString(),
            formattedTime: formatHumanFriendlyDateTime(item.advDate, timezone, language),
          });
        }
      } else {
        rejectedItems.push({
          type: 'advance_notice',
          content: language === 'en' ? `Advance notice for ${item.content}` : `Aviso previo de ${item.content}`,
          code: 'ADVANCE_TIME_IN_PAST',
          reason: language === 'en'
            ? 'the requested advance-notice moment has already passed; the main reminder was still scheduled.'
            : 'el momento del aviso previo ya pasó; el recordatorio principal sí fue programado.',
        });
      }
    }

    const mainReminder = await saveReminder({
      userId,
      phoneNumber,
      content: item.content,
      sendAt: item.mainDate.toISOString(),
      recurrenceRule: item.recurrenceRule || null,
      requiresConfirmation: Boolean(item.requiresConfirmation),
      nudgeIntervalMinutes: item.nudgeIntervalMinutes || (item.requiresConfirmation ? 10 : null),
      maxNudges: item.maxNudges || (item.requiresConfirmation ? 3 : null),
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
      content: item.content,
      isAdvanceNotice: false,
      sendAt: item.mainDate.toISOString(),
      formattedTime: formatHumanFriendlyDateTime(item.mainDate, timezone, language),
      recurrenceRule: item.recurrenceRule,
      recurrence_rule: item.recurrenceRule,
      requiresConfirmation: item.requiresConfirmation,
    });

    if (Array.isArray(item.checklist) && item.checklist.length > 0) {
      for (const checklistItem of item.checklist) {
        const title = typeof checklistItem === 'string' ? checklistItem : checklistItem?.title;
        if (title) {
          await createTask({ userId, title, dueDate: item.mainDate.toISOString() });
        }
      }
    }
  }

  const pendingClarifications = rejectedItems
    .filter((item) => Boolean(item.question))
    .map((item) => ({
      type: 'reminder',
      content: item.content,
      advanceMinutes: item.advanceMinutes,
      reason: item.reason,
      question: item.question,
      proposedReminder: item.proposedReminder || null,
    }));

  const proUpgrade = rejectedItems.some((item) => item.code === 'PRO_TIER_REQUIRED')
    ? await resolveReminderProUpgradeContext(phoneNumber, language, {
        userId: user?.id,
        timezone: user?.timezone,
        country: user?.country,
      })
    : null;

  const formattedCard = formatReminderCreateOutcomeCard({
    created: savedReminders,
    rejected: rejectedItems,
    proUpgrade: proUpgrade ? {
      checkoutUrl: proUpgrade.checkoutUrl || proUpgrade.fallbackCheckoutUrl,
      amount: proUpgrade.amount,
      currency: proUpgrade.currency,
    } : null,
  }, timezone, language);

  if (savedReminders.length === 0) {
    const firstError = rejectedItems[0] || {};
    return {
      success: false,
      action: firstError.code === 'PRO_TIER_REQUIRED'
        ? 'tier_limit_exceeded'
        : (pendingClarifications.length > 0 ? 'reminder_clarification_required' : 'reminders_not_created'),
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

  const createdCard = formatReminderCreatedCard(savedReminders, timezone, language);
  return {
    success: true,
    action: 'created_reminders_batch',
    data: savedReminders,
    rawSummary: createdCard,
    formattedCard: createdCard,
  };
}

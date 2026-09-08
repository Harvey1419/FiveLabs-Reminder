import {
  saveReminder,
  cancelPendingRemindersByContent,
  createTask,
  getUserSubscription,
  hasProAccess,
  shouldEnforceBillingForUser,
} from '../../infrastructure/database/index.js';
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
      const amount = Number(plan.amount);
      if (Number.isFinite(amount)) context.amount = amount;
    }
    if (plan?.currency) context.currency = String(plan.currency);
  } catch (err) {
    console.warn('[reminder-create] Failed to resolve Reminder Pro checkout link:', err.message);
  }
  return context;
}

function localDateKey(date, timezone) {
  return date.toLocaleDateString('sv-SE', { timeZone: timezone });
}

function localClock(date, timezone, language) {
  const locale = language === 'en' ? 'en-US' : language === 'pt' ? 'pt-BR' : 'es-CO';
  return date.toLocaleTimeString(locale, { timeZone: timezone, hour: 'numeric', minute: '2-digit' });
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

function buildTemporalRejection({ content, sourceTimeText, advanceMinutes, mainDate, referenceDate, timezone, language, proposedReminder }) {
  const sameLocalDay = mainDate && localDateKey(mainDate, timezone) === localDateKey(referenceDate, timezone);
  const clock = mainDate ? localClock(mainDate, timezone, language) : '';
  const isEnglish = language === 'en';
  return {
    type: 'reminder',
    content,
    code: 'TIME_IN_PAST',
    reason: isEnglish ? 'the requested time has already passed.' : 'la hora indicada ya pasó.',
    question: sameLocalDay && clock
      ? (isEnglish ? `Did you mean tomorrow at ${clock}?` : `¿Quieres que lo programe mañana a las ${clock}?`)
      : (isEnglish ? 'What new date and time should I use?' : '¿Qué nueva fecha y hora quieres usar?'),
    sourceTimeText,
    advanceMinutes: advanceMinutes || null,
    proposedReminder,
  };
}

/** Canonical reminder creation. No natural-language interpretation happens here. */
export async function executeReminderCreate({ params = {}, user = null, isPro = false, language = 'es', referenceTime = null } = {}) {
  const userId = user?.id;
  const phoneNumber = user?.phone_number;
  const timezone = user?.timezone || DEFAULT_TIMEZONE;
  const subscription = user?.subscription || (userId ? await getUserSubscription(userId) : null);
  const userHasPro = isPro || user?.is_admin === true || hasProAccess(subscription, user);
  const enforceBilling = shouldEnforceBillingForUser(user);

  let itemsCandidate = params.items || params.create || params.reminders || (Array.isArray(params) ? params : null);
  if (itemsCandidate && typeof itemsCandidate === 'object' && !Array.isArray(itemsCandidate) && itemsCandidate.items) {
    itemsCandidate = itemsCandidate.items;
  }
  const rawItems = Array.isArray(itemsCandidate) && itemsCandidate.length > 0 ? itemsCandidate : [params];
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

    if (!content) {
      rejectedItems.push({ type: 'reminder', content: language === 'en' ? 'Untitled reminder' : 'Recordatorio sin título', code: 'INVALID_PARAMETERS', reason: language === 'en' ? 'the reminder content is missing.' : 'falta el contenido del recordatorio.' });
      continue;
    }
    if (!targetTime) {
      rejectedItems.push({
        type: 'reminder', content, code: 'MISSING_REQUIRED_CONTEXT',
        reason: language === 'en' ? 'the date and time are missing.' : 'falta la fecha y hora.',
        question: language === 'en' ? `When should I remind you about “${content}”?` : `¿Cuándo quieres que te recuerde “${content}”?`,
        sourceTimeText, advanceMinutes: advanceMinutes || null,
      });
      continue;
    }
    if (enforceBilling && recurrenceRule && !userHasPro) {
      rejectedItems.push({ type: 'reminder', content, code: 'PRO_TIER_REQUIRED', proFeature: 'recurrence', reason: language === 'en' ? 'recurring reminders require Reminder Pro.' : 'los recordatorios recurrentes requieren Reminder Pro.', sourceTimeText, advanceMinutes: advanceMinutes || null });
      continue;
    }

    const mainDate = parseTargetTime(targetTime, timezone, referenceDate, { rollForwardTimeOnly: !sourceTimeText });
    if (!mainDate || Number.isNaN(mainDate.getTime())) {
      rejectedItems.push({
        type: 'reminder', content, code: 'INVALID_TIME_FORMAT',
        reason: language === 'en' ? `I could not interpret “${targetTime}”.` : `no pude interpretar “${targetTime}”.`,
        question: language === 'en' ? `What date and time should I use for “${content}”?` : `¿Qué fecha y hora quieres usar para “${content}”?`,
        sourceTimeText, advanceMinutes: advanceMinutes || null,
      });
      continue;
    }

    if (mainDate.getTime() <= referenceDate.getTime()) {
      const sameLocalDay = localDateKey(mainDate, timezone) === localDateKey(referenceDate, timezone);
      const proposedDate = sameLocalDay ? shiftZonedCalendarDays(mainDate, 1, timezone) : null;
      rejectedItems.push(buildTemporalRejection({
        content, sourceTimeText, advanceMinutes, mainDate, referenceDate, timezone, language,
        proposedReminder: buildReminderProposal({ content, sourceTimeText, advanceMinutes, recurrenceRule, requiresConfirmation, nudgeIntervalMinutes, maxNudges, replacePending, checklist }, proposedDate),
      }));
      continue;
    }

    if (enforceBilling) {
      const userDateStr = referenceDate.toLocaleDateString('sv-SE', { timeZone: timezone });
      const targetDateStr = mainDate.toLocaleDateString('sv-SE', { timeZone: timezone });
      const diffMs = mainDate.getTime() - referenceDate.getTime();
      const isFutureDay = (targetDateStr !== userDateStr && diffMs > 3 * 60 * 60 * 1000) || diffMs > 24 * 60 * 60 * 1000;
      if ((isFutureDay || recurrenceRule) && !userHasPro) {
        const isRecurring = Boolean(recurrenceRule);
        rejectedItems.push({
          type: 'reminder', content, code: 'PRO_TIER_REQUIRED', proFeature: isRecurring ? 'recurrence' : 'future_day',
          reason: language === 'en' ? (isRecurring ? 'recurring reminders require Reminder Pro.' : 'reminders for future days require Reminder Pro.') : (isRecurring ? 'los recordatorios recurrentes requieren Reminder Pro.' : 'los recordatorios para días futuros requieren Reminder Pro.'),
          sourceTimeText, formattedTime: formatHumanFriendlyDateTime(mainDate, timezone, language), advanceMinutes: advanceMinutes || null,
        });
        continue;
      }
    }

    let advDate = null;
    if (advanceNoticeTime) advDate = parseTargetTime(advanceNoticeTime, timezone, referenceDate, { rollForwardTimeOnly: false });
    else if (advanceMinutes) advDate = new Date(mainDate.getTime() - advanceMinutes * 60 * 1000);

    validatedItems.push({ content, mainDate, advDate, advanceMinutes, recurrenceRule, requiresConfirmation, nudgeIntervalMinutes, maxNudges, replacePending, checklist, sourceTimeText });
  }

  for (const item of validatedItems) {
    const { content, mainDate, advDate, advanceMinutes, recurrenceRule, requiresConfirmation, nudgeIntervalMinutes, maxNudges, replacePending, checklist, sourceTimeText } = item;
    if (replacePending) {
      try { await cancelPendingRemindersByContent({ phoneNumber, contentQuery: content }); }
      catch (err) { console.warn('[reminder-create] replacePending error:', err.message); }
    }

    if (advDate) {
      if (advDate.getTime() > referenceDate.getTime()) {
        const advContent = `🔔 [Aviso Previo] En ${advanceMinutes || 15} minutos: ${content}`;
        const advReminder = await saveReminder({ userId, phoneNumber, content: advContent, sendAt: advDate.toISOString(), requiresConfirmation: false });
        if (advReminder) {
          savedReminders.push({ id: advReminder.id, content: advContent, displayContent: content, isAdvanceNotice: true, sendAt: advDate.toISOString(), formattedTime: formatHumanFriendlyDateTime(advDate, timezone, language) });
        }
      } else {
        rejectedItems.push({ type: 'advance_notice', content: language === 'en' ? `Advance notice for ${content}` : `Aviso previo de ${content}`, code: 'ADVANCE_TIME_IN_PAST', reason: language === 'en' ? 'the requested advance-notice moment has already passed; the main reminder was still scheduled.' : 'el momento del aviso previo ya pasó; el recordatorio principal sí fue programado.', sourceTimeText });
      }
    }

    const mainReminder = await saveReminder({
      userId, phoneNumber, content, sendAt: mainDate.toISOString(), recurrenceRule: recurrenceRule || null,
      requiresConfirmation: Boolean(requiresConfirmation),
      nudgeIntervalMinutes: nudgeIntervalMinutes || (requiresConfirmation ? 10 : null),
      maxNudges: maxNudges || (requiresConfirmation ? 3 : null),
    });
    if (!mainReminder) return { success: false, action: 'database_error', errorCode: 'DATABASE_ERROR', error: 'No se pudo guardar el recordatorio en la base de datos.', rawSummary: 'No se pudo guardar el recordatorio en la base de datos.' };

    savedReminders.push({ id: mainReminder.id, content, isAdvanceNotice: false, sendAt: mainDate.toISOString(), formattedTime: formatHumanFriendlyDateTime(mainDate, timezone, language), recurrenceRule, recurrence_rule: recurrenceRule, requiresConfirmation });

    if (Array.isArray(checklist) && checklist.length > 0) {
      for (const chkItem of checklist) {
        const itemTitle = typeof chkItem === 'string' ? chkItem : chkItem?.title;
        if (itemTitle) await createTask({ userId, title: itemTitle, dueDate: mainDate.toISOString() });
      }
    }
  }

  const pendingClarifications = rejectedItems.filter((item) => Boolean(item.question)).map((item) => ({ type: 'reminder', content: item.content, sourceTimeText: item.sourceTimeText, advanceMinutes: item.advanceMinutes, reason: item.reason, question: item.question, proposedReminder: item.proposedReminder || null }));
  const hasProRequirement = rejectedItems.some((item) => item.code === 'PRO_TIER_REQUIRED');
  const proUpgrade = hasProRequirement ? await resolveProUpgradeContext(phoneNumber, language) : null;
  const formattedCard = formatReminderCreateOutcomeCard({
    created: savedReminders,
    rejected: rejectedItems,
    proUpgrade: proUpgrade ? { checkoutUrl: proUpgrade.checkoutUrl || proUpgrade.fallbackCheckoutUrl, amount: proUpgrade.amount, currency: proUpgrade.currency } : null,
  }, timezone, language);

  if (savedReminders.length === 0) {
    const firstError = rejectedItems[0] || {};
    return {
      success: false,
      action: firstError.code === 'PRO_TIER_REQUIRED' ? 'tier_limit_exceeded' : (pendingClarifications.length > 0 ? 'reminder_clarification_required' : 'reminders_not_created'),
      errorCode: firstError.code || 'INVALID_PARAMETERS',
      isProFeature: firstError.code === 'PRO_TIER_REQUIRED',
      error: firstError.reason || (language === 'en' ? 'No reminders were created.' : 'No se creó ningún recordatorio.'),
      rawSummary: formattedCard, formattedCard,
      requiresClarification: pendingClarifications.length > 0, pendingClarifications,
      data: { items: [], rejected: rejectedItems, pendingClarifications, checkout_url: proUpgrade?.checkoutUrl || proUpgrade?.fallbackCheckoutUrl || null, checkoutUrl: proUpgrade?.checkoutUrl || proUpgrade?.fallbackCheckoutUrl || null },
      ctaUrl: proUpgrade?.checkoutUrl || proUpgrade?.fallbackCheckoutUrl || null,
      ctaHeader: proUpgrade?.ctaHeader || null, ctaButtonText: proUpgrade?.ctaButtonText || null, complete: false,
    };
  }

  if (rejectedItems.length > 0) {
    return {
      success: true, partialSuccess: true, complete: false, action: 'partially_created_reminders',
      data: { items: savedReminders, rejected: rejectedItems, pendingClarifications, checkout_url: proUpgrade?.checkoutUrl || proUpgrade?.fallbackCheckoutUrl || null, checkoutUrl: proUpgrade?.checkoutUrl || proUpgrade?.fallbackCheckoutUrl || null },
      rawSummary: formattedCard, formattedCard,
      ctaUrl: proUpgrade?.checkoutUrl || proUpgrade?.fallbackCheckoutUrl ||
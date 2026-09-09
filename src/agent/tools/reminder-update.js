import {
  supabase,
  saveReminder,
  updateReminder,
  getUserSubscription,
  hasProAccess,
  shouldEnforceBillingForUser,
} from '../../infrastructure/database/index.js';
import {
  parseTargetTime,
  formatHumanFriendlyDateTime,
  DEFAULT_TIMEZONE,
} from '../../shared/time.js';
import { resolveContextReference } from '../core/context-reference.js';
import { isStrictUUID } from '../../shared/entity-resolution.js';
import { formatReminderUpdatedCard } from './formatters.js';
import {
  REMINDER_PRO_FALLBACK,
  resolveReminderProUpgradeContext,
} from './reminder-pro.js';
import { buildAdvanceNoticeContent } from './reminder-advance.js';
import {
  buildReminderOwnerContext,
  scopeReminderQueryToOwner,
} from './reminder-owner.js';

function proRequiredResult({ language, proUpgrade, targetDate = null }) {
  const checkoutUrl = proUpgrade?.checkoutUrl || proUpgrade?.fallbackCheckoutUrl;
  const payNowLabel = language === 'en' ? 'Pay now' : 'Pagar ahora';
  const error = language === 'en'
    ? 'This reminder update requires a Reminder Pro subscription.'
    : 'Este cambio del recordatorio requiere una suscripción a Reminder Pro.';
  return {
    success: false,
    action: 'pro_tier_required',
    errorCode: 'PRO_TIER_REQUIRED',
    isProFeature: true,
    error,
    rawSummary: error,
    formattedCard: `${error}\n\n💳 *Enlace de pago (Mercado Pago):* ${checkoutUrl || REMINDER_PRO_FALLBACK.fallbackCheckoutUrl}\n👉 *${payNowLabel}*`,
    data: {
      reason: 'pro_tier_limit',
      ...(targetDate ? { targetDate } : {}),
      checkout_url: checkoutUrl || null,
      checkoutUrl,
    },
    ctaUrl: checkoutUrl || null,
    ctaHeader: proUpgrade?.ctaHeader || null,
    ctaButtonText: proUpgrade?.ctaButtonText || null,
  };
}

async function resolveTargetReminder({ target, owner, user }) {
  if (!target) return { targetId: null, pending: [] };
  if (!owner?.hasOwner) return { targetId: null, pending: [], missingOwner: true };

  let pendingQuery = supabase.from('reminders').select('*').eq('status', 'pending');
  pendingQuery = scopeReminderQueryToOwner(pendingQuery, owner);
  const { data: pendingRows, error: pendingError } = await pendingQuery
    .order('send_at', { ascending: true })
    .limit(50);

  if (pendingError) {
    return { targetId: null, pending: [], error: pendingError };
  }

  const pending = pendingRows || [];
  const targetText = String(target);

  const exactPending = pending.find((reminder) => (
    reminder.id === targetText
    || (targetText.length >= 8 && reminder.id?.startsWith(targetText))
  ));
  if (exactPending) {
    return { targetId: exactPending.id, pending, exactReminder: exactPending };
  }

  // Preserve direct UUID targeting for owned reminders even when the row is no
  // longer pending. Unlike the legacy fallback, this read is always tenant-scoped.
  if (isStrictUUID(targetText)) {
    let exactQuery = supabase.from('reminders').select('*').eq('id', targetText);
    exactQuery = scopeReminderQueryToOwner(exactQuery, owner);
    const { data: exactReminder, error: exactError } = await exactQuery.maybeSingle();
    if (exactError) return { targetId: null, pending, error: exactError };
    return exactReminder
      ? { targetId: exactReminder.id, pending, exactReminder }
      : { targetId: null, pending, notFound: true };
  }

  const resolution = resolveContextReference({
    userOrPhone: user || owner.phoneNumber,
    reference: targetText,
    candidates: pending,
    preferredType: 'reminder',
  });

  if (resolution.status === 'RESOLVED') {
    const resolvedId = resolution.item?.internalId || resolution.item?.id || null;
    const exactReminder = pending.find((reminder) => reminder.id === resolvedId) || resolution.item?.raw || null;
    return { targetId: resolvedId, pending, exactReminder };
  }
  if (resolution.status === 'AMBIGUOUS') {
    return { targetId: null, pending, ambiguous: true };
  }
  return { targetId: null, pending, notFound: true };
}

export async function executeReminderUpdate({
  params = {},
  user = {},
  isPro = false,
  language = 'es',
  referenceTime = null,
} = {}) {
  const owner = buildReminderOwnerContext(user);
  const { userId, phoneNumber } = owner;
  const timezone = user?.timezone || DEFAULT_TIMEZONE;
  const subscription = user?.subscription || (userId ? await getUserSubscription(userId) : null);
  const userHasPro = isPro || user?.is_admin === true || hasProAccess(subscription, user);
  const enforceBilling = shouldEnforceBillingForUser(user);

  const updates = params.updates || {};
  const targetReminderId = params.reminderId || params.target || params.id || updates.reminderId || updates.id || null;

  if (!targetReminderId) {
    return {
      success: false,
      action: 'missing_target_id',
      errorCode: 'MISSING_TARGET_ID',
      error: language === 'en'
        ? 'Missing reminder target to update.'
        : 'Falta especificar qué recordatorio deseas actualizar.',
      rawSummary: language === 'en'
        ? 'Which reminder would you like me to update?'
        : '¿Cuál recordatorio deseas que actualice?',
    };
  }

  if (!owner.hasOwner) {
    return {
      success: false,
      action: 'missing_owner',
      errorCode: 'ACCESS_DENIED',
      error: language === 'en'
        ? 'I could not verify reminder ownership.'
        : 'No pude verificar la propiedad del recordatorio.',
    };
  }

  const resolved = await resolveTargetReminder({ target: targetReminderId, owner, user });
  if (resolved.error) {
    return {
      success: false,
      action: 'database_error',
      errorCode: 'DATABASE_ERROR',
      error: language === 'en'
        ? 'I could not verify the reminder to update.'
        : 'No pude verificar el recordatorio que quieres actualizar.',
    };
  }
  if (resolved.ambiguous) {
    return {
      success: false,
      action: 'ambiguous_target',
      errorCode: 'AMBIGUOUS_TARGET',
      error: language === 'en'
        ? 'Multiple reminders match. Please clarify which one you want to update.'
        : 'Hay varios recordatorios que coinciden. Dime cuál quieres actualizar.',
      rawSummary: language === 'en'
        ? 'Multiple reminders match.'
        : 'Hay varios recordatorios que coinciden.',
      requiresClarification: true,
    };
  }
  if (!resolved.targetId) {
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
    };
  }

  const resolvedTargetId = resolved.targetId;
  const isAdvanceNotice = params.advanceMinutes !== undefined || params.isAdvanceNotice === true;

  if (isAdvanceNotice) {
    const baseReminder = resolved.exactReminder
      || resolved.pending.find((reminder) => reminder.id === resolvedTargetId)
      || null;

    if (!baseReminder?.send_at) {
      return {
        success: false,
        action: 'reminder_not_found',
        errorCode: 'NOT_FOUND',
        error: language === 'en' ? 'Reminder not found.' : 'No se encontró el recordatorio especificado.',
        rawSummary: language === 'en' ? 'Reminder not found.' : 'No se encontró el recordatorio especificado.',
      };
    }

    const advanceMinutes = Number(params.advanceMinutes || 15);
    const baseDate = new Date(baseReminder.send_at);
    const advanceDate = new Date(baseDate.getTime() - advanceMinutes * 60 * 1000);
    const now = referenceTime instanceof Date ? referenceTime : new Date(referenceTime || Date.now());

    if (advanceDate.getTime() <= now.getTime()) {
      return {
        success: false,
        action: 'advance_time_in_past',
        errorCode: 'ADVANCE_TIME_IN_PAST',
        error: language === 'en'
          ? 'The requested advance-notice time has already passed.'
          : 'El momento solicitado para el aviso previo ya pasó.',
        rawSummary: language === 'en'
          ? 'The requested advance-notice time has already passed.'
          : 'El momento solicitado para el aviso previo ya pasó.',
      };
    }

    const content = buildAdvanceNoticeContent(baseReminder.content, advanceMinutes);
    const reminder = await saveReminder({
      userId,
      phoneNumber,
      content,
      sendAt: advanceDate.toISOString(),
      requiresConfirmation: false,
    });

    if (!reminder) {
      return {
        success: false,
        action: 'database_error',
        errorCode: 'DATABASE_ERROR',
        error: language === 'en' ? 'Could not save the advance notice.' : 'No se pudo guardar el aviso previo.',
        rawSummary: language === 'en' ? 'Could not save the advance notice.' : 'No se pudo guardar el aviso previo.',
      };
    }

    const formattedTime = formatHumanFriendlyDateTime(advanceDate, timezone, language);
    const summary = language === 'en'
      ? `🔔 *Advance notice scheduled*\n\n⏰ *${baseReminder.content}*\n📅 ${formattedTime} (${advanceMinutes} minutes before)`
      : `🔔 *Aviso previo programado*\n\n⏰ *${baseReminder.content}*\n📅 ${formattedTime} (${advanceMinutes} minutos antes)`;
    return {
      success: true,
      action: 'created_advance_reminder',
      data: {
        ...reminder,
        displayContent: baseReminder.content,
        isAdvanceNotice: true,
        advanceMinutes,
        formattedTime,
      },
      rawSummary: summary,
      formattedCard: summary,
    };
  }

  const dbUpdates = {};
  const newContent = params.content || params.text || updates.content || updates.text;
  if (newContent) dbUpdates.content = String(newContent).trim();

  const rawTargetTime = params.targetTime || params.sendAt || updates.targetTime || updates.sendAt || updates.time || updates.date;
  if (rawTargetTime) {
    const parsedDate = parseTargetTime(rawTargetTime, timezone, referenceTime);
    if (!parsedDate || Number.isNaN(parsedDate.getTime())) {
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

    const referenceDate = referenceTime instanceof Date ? referenceTime : new Date(referenceTime || Date.now());
    const currentLocalDate = referenceDate.toLocaleDateString('en-CA', { timeZone: timezone });
    const targetLocalDate = parsedDate.toLocaleDateString('en-CA', { timeZone: timezone });
    if (enforceBilling && targetLocalDate > currentLocalDate && !userHasPro) {
      const proUpgrade = await resolveReminderProUpgradeContext(phoneNumber, language);
      return proRequiredResult({ language, proUpgrade, targetDate: parsedDate.toISOString() });
    }

    dbUpdates.send_at = parsedDate.toISOString();
    dbUpdates.status = 'pending';
  }

  const recurrenceProvided = Object.prototype.hasOwnProperty.call(params, 'recurrence')
    || Object.prototype.hasOwnProperty.call(params, 'recurrenceRule')
    || Object.prototype.hasOwnProperty.call(updates, 'recurrence')
    || Object.prototype.hasOwnProperty.call(updates, 'recurrenceRule')
    || Object.prototype.hasOwnProperty.call(updates, 'recurrence_rule');
  if (recurrenceProvided) {
    const newRecurrence = params.recurrence ?? params.recurrenceRule ?? updates.recurrence ?? updates.recurrenceRule ?? updates.recurrence_rule ?? null;
    if (enforceBilling && newRecurrence && !userHasPro) {
      const proUpgrade = await resolveReminderProUpgradeContext(phoneNumber, language);
      return proRequiredResult({ language, proUpgrade });
    }
    dbUpdates.recurrence_rule = newRecurrence;
  }

  if (Object.keys(dbUpdates).length === 0) {
    return {
      success: false,
      action: 'no_updates_provided',
      errorCode: 'INVALID_PARAMETERS',
      error: language === 'en' ? 'No update fields provided.' : 'No se especificaron cambios para el recordatorio.',
      rawSummary: language === 'en' ? 'No update fields provided.' : 'No se especificaron cambios para el recordatorio.',
    };
  }

  const updated = await updateReminder(resolvedTargetId, dbUpdates, userId, phoneNumber);
  if (!updated) {
    return {
      success: false,
      action: 'reminder_not_found',
      errorCode: 'NOT_FOUND',
      error: language === 'en'
        ? 'Reminder not found or access denied.'
        : 'No se encontró el recordatorio o no tienes permisos sobre él.',
      rawSummary: language === 'en' ? 'Reminder not found.' : 'No se encontró el recordatorio especificado.',
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
  };
}

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
  const isStripe = Boolean(checkoutUrl?.includes('stripe.com') || proUpgrade?.shortCheckoutUrl);
  const displayCheckoutUrl = (isStripe && proUpgrade?.shortCheckoutUrl) || checkoutUrl;
  const isLemon = Boolean(checkoutUrl?.includes('lemonsqueezy'));
  const providerName = proUpgrade?.provider || (isStripe ? 'Stripe' : (isLemon ? 'Lemon Squeezy' : 'Mercado Pago'));
  const payNowLabel = language === 'en' ? 'Pay now' : 'Pagar ahora';
  const error = language === 'en'
    ? 'This reminder update requires a Reminder Pro subscription.'
    : 'Este cambio del recordatorio requiere una suscripción a Reminder Pro.';
  const formattedPaymentLabel = isStripe
    ? (language === 'en' ? 'Secure payment link:' : 'Enlace de pago seguro:')
    : (language === 'en' ? `Secure payment link with ${providerName}:` : `Enlace de pago (${providerName}):`);
  const formattedCard = `${error}\n\n💳 *${formattedPaymentLabel}*\n${displayCheckoutUrl || REMINDER_PRO_FALLBACK.fallbackCheckoutUrl}\n👉 *${payNowLabel}*`;
  return {
    success: false,
    action: 'pro_tier_required',
    errorCode: 'PRO_TIER_REQUIRED',
    isProFeature: true,
    error,
    rawSummary: error,
    formattedCard,
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

/**
 * Strips the gcal companion content noise so the fuzzy scorer can match the
 * user-supplied reference against the underlying event title.
 *
 * Input:  "🔔 [Google Calendar] Reunion del CIDIGRAMA en 30 minutos"
 * Output: "Reunion del CIDIGRAMA"
 */
function normalizeGcalCompanionContent(content) {
  if (!content) return '';
  return content
    .replace(/^🔔\s*\[Google Calendar\]\s*/u, '')
    .replace(/\s+en\s+\d+\s+minutos?\s*$/i, '')
    .trim();
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
    return { targetId: null, pending, ambiguous: true, candidates: resolution.candidates || [] };
  }

  // Secondary pass: try to match against Google Calendar companion reminders by
  // normalizing their content (stripping prefix/suffix noise) before scoring.
  // Companions are hidden from reminder.list but CAN be the user's intended target
  // when they say "modifica el recordatorio de X" alongside a calendar update.
  const gcalCompanions = pending.filter((r) => r.delivery_id?.startsWith('gcal:'));
  if (gcalCompanions.length > 0) {
    const normalized = gcalCompanions.map((r) => ({
      ...r,
      content: normalizeGcalCompanionContent(r.content),
    }));
    const companionResolution = resolveContextReference({
      userOrPhone: user || owner.phoneNumber,
      reference: targetText,
      candidates: normalized,
      preferredType: 'reminder',
    });
    if (companionResolution.status === 'RESOLVED') {
      const resolvedId = companionResolution.item?.internalId || companionResolution.item?.id || null;
      const companionReminder = pending.find((r) => r.id === resolvedId) || null;
      return { targetId: null, pending, isCalendarCompanion: true, companionReminder };
    }
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
  const targetReminderId = params.target || null;

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
    const candidates = Array.isArray(resolved.candidates) && resolved.candidates.length > 0
      ? resolved.candidates
      : (Array.isArray(resolved.pending) ? resolved.pending.slice(0, 5) : []);

    const candidateLines = candidates.map((cand, idx) => {
      const timeVal = cand.time || cand.send_at || cand.localTime || null;
      const timeStr = timeVal ? formatHumanFriendlyDateTime(new Date(timeVal), timezone, language) : '';
      const content = cand.summary || cand.title || cand.content || 'Recordatorio';
      return `${idx + 1}. *${content}*${timeStr ? `\n   🕒 ${timeStr}` : ''}`;
    }).join('\n\n');

    const formattedCard = language === 'en'
      ? `⚠️ *Multiple reminders match*\n\n${candidateLines}\n\nWhich one would you like to update?`
      : `⚠️ *Hay varios recordatorios que coinciden*\n\n${candidateLines}\n\n¿Cuál de ellos deseas actualizar?`;

    return {
      success: false,
      action: 'ambiguous_target',
      errorCode: 'AMBIGUOUS_TARGET',
      error: language === 'en'
        ? 'Multiple reminders match. Please clarify which one you want to update.'
        : 'Hay varios recordatorios que coinciden. Dime cuál quieres actualizar.',
      rawSummary: formattedCard,
      formattedCard,
      requiresClarification: true,
      data: {
        reminders: candidates.map((cand, idx) => ({
          position: idx + 1,
          type: 'reminder',
          internalId: cand.internalId || cand.id,
          id: cand.internalId || cand.id,
          summary: cand.summary || cand.title || cand.content || '',
          title: cand.title || cand.summary || cand.content || '',
          time: cand.time || cand.send_at || null,
        })),
      },
    };
  }
  if (resolved.isCalendarCompanion) {
    const eventTitle = resolved.companionReminder
      ? normalizeGcalCompanionContent(resolved.companionReminder.content)
      : null;
    const eventLabel = eventTitle ? ` *"${eventTitle}"*` : '';
    const msg = language === 'en'
      ? `📅 The reminder for${eventLabel} belongs to Google Calendar and was already updated automatically when the event was modified.`
      : `📅 El recordatorio de${eventLabel} pertenece a Google Calendar y ya fue actualizado automáticamente al modificar el evento.`;
    return {
      success: true,
      action: 'calendar_companion_auto_updated',
      data: { isCalendarCompanion: true, reminderId: resolved.companionReminder?.id || null },
      rawSummary: msg,
      formattedCard: msg,
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
  const isAdvanceNotice = params.advanceMinutes !== undefined;

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
  const newContent = updates.content;
  if (newContent) dbUpdates.content = String(newContent).trim();

  const rawTargetTime = updates.targetTime;
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
      const proUpgrade = await resolveReminderProUpgradeContext(phoneNumber, language, {
        userId: user?.id,
        timezone: user?.timezone,
        country: user?.country,
      });
      return proRequiredResult({ language, proUpgrade, targetDate: parsedDate.toISOString() });
    }

    dbUpdates.send_at = parsedDate.toISOString();
    dbUpdates.status = 'pending';
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'recurrence')) {
    const newRecurrence = updates.recurrence ?? null;
    if (enforceBilling && newRecurrence && !userHasPro) {
      const proUpgrade = await resolveReminderProUpgradeContext(phoneNumber, language, {
        userId: user?.id,
        timezone: user?.timezone,
        country: user?.country,
      });
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

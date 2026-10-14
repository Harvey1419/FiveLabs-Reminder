import type { ReminderClient, ReminderRow, ReminderToolInput, ReminderResolution, ReminderOwner } from './reminder-tool-ports.js';

export interface Dependencies {
  supabase: ReminderClient;
  saveReminder: (...args: unknown[]) => Promise<ReminderRow | null>;
  updateReminder: (...args: unknown[]) => Promise<ReminderRow | null>;
  getUserSubscription: (userId: string) => Promise<unknown>;
  hasProAccess: (...args: unknown[]) => boolean;
  shouldEnforceBillingForUser: (...args: unknown[]) => boolean;
  parseTargetTime: typeof import('../../../shared/time.js').parseTargetTime;
  formatHumanFriendlyDateTime: typeof import('../../../shared/time.js').formatHumanFriendlyDateTime;
  DEFAULT_TIMEZONE: typeof import('../../../shared/time.js').DEFAULT_TIMEZONE;
  resolveContextReference: (input: Record<string, unknown>) => ReminderResolution;
  isStrictUUID: (value: unknown) => boolean;
  PRESENTATION_TOKENS: typeof import('../../../shared/presentation-tokens.js').PRESENTATION_TOKENS;
  formatReminderUpdatedCard: typeof import('../../../agent/tools/formatters.js').formatReminderUpdatedCard;
  REMINDER_PRO_FALLBACK: typeof import('../../../agent/tools/reminder-pro.js').REMINDER_PRO_FALLBACK;
  resolveReminderProUpgradeContext: typeof import('../../../agent/tools/reminder-pro.js').resolveReminderProUpgradeContext;
  buildAdvanceNoticeContent: typeof import('../../../agent/tools/reminder-advance.js').buildAdvanceNoticeContent;
  belongsToMainReminder: typeof import('../../../agent/tools/reminder-advance.js').belongsToMainReminder;
  getAdvanceNoticeMinutes: typeof import('../../../agent/tools/reminder-advance.js').getAdvanceNoticeMinutes;
  buildReminderOwnerContext: typeof import('../../../agent/tools/reminder-owner.js').buildReminderOwnerContext;
  scopeReminderQueryToOwner: typeof import('../../../agent/tools/reminder-owner.js').scopeReminderQueryToOwner;
  logger: Pick<Console, 'log' | 'warn' | 'error'>;
}

export function createReminderUpdateTools(dependencies: Dependencies) {
const { supabase, saveReminder, updateReminder, getUserSubscription, hasProAccess, shouldEnforceBillingForUser, parseTargetTime, formatHumanFriendlyDateTime, resolveContextReference, isStrictUUID, formatReminderUpdatedCard, resolveReminderProUpgradeContext, buildAdvanceNoticeContent, belongsToMainReminder, getAdvanceNoticeMinutes, buildReminderOwnerContext, scopeReminderQueryToOwner, logger } = dependencies;










function proRequiredResult({ language, proUpgrade, targetDate = null }: { language: string; proUpgrade: Awaited<ReturnType<Dependencies['resolveReminderProUpgradeContext']>>; targetDate?: string | null }) {
  const checkoutUrl = proUpgrade?.checkoutUrl || proUpgrade?.fallbackCheckoutUrl;
  const displayCheckoutUrl = proUpgrade?.shortCheckoutUrl || checkoutUrl;
  const payNowLabel = language === 'en' ? 'Pay now' : 'Pagar ahora';
  const error = language === 'en'
    ? 'This reminder update requires a Reminder Pro subscription.'
    : 'Este cambio del recordatorio requiere una suscripción a Reminder Pro.';
  const formattedPaymentLabel = language === 'en' ? 'Secure payment link:' : 'Enlace de pago seguro:';
  const formattedCard = `${error}\n\n💳 *${formattedPaymentLabel}*\n${displayCheckoutUrl || dependencies.REMINDER_PRO_FALLBACK.fallbackCheckoutUrl}\n👉 *${payNowLabel}*`;
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

// Exact prefix written by createCompanionReminder() in calendar.js.
const GCAL_CONTENT_PREFIX = '🔔 [Google Calendar] ';

/**
 * Extracts the underlying event title from a gcal companion content string.
 * No regex — uses the known fixed prefix and the last ' en ' separator.
 *
 * Input:  "🔔 [Google Calendar] Reunion del CIDIGRAMA en 30 minutos"
 * Output: "Reunion del CIDIGRAMA"
 */
function normalizeGcalCompanionContent(content: string | null | undefined) {
  if (!content) return '';
  let title = content.startsWith(GCAL_CONTENT_PREFIX)
    ? content.slice(GCAL_CONTENT_PREFIX.length)
    : content;
  // The suffix is always " en N minutos" appended by our own code.
  // Find the last occurrence of ' en ' and drop everything from there.
  const enIdx = title.lastIndexOf(' en ');
  if (enIdx > 0) title = title.slice(0, enIdx);
  return title.trim();
}

async function resolveTargetReminder({ target, owner, user }: { target: unknown; owner: ReminderOwner; user: ReminderToolInput['user'] }) {
  if (!target) return { targetId: null, pending: [] };
  if (!owner?.hasOwner) return { targetId: null, pending: [], missingOwner: true };

  let pendingQuery = supabase.from('reminders').select('*').eq('status', 'pending');
  pendingQuery = scopeReminderQueryToOwner(pendingQuery, owner)!;
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
    exactQuery = scopeReminderQueryToOwner(exactQuery, owner)!;
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

async function executeReminderUpdate({
  params = {},
  user = {},
  isPro = false,
  language = 'es',
  referenceTime = null,
}: ReminderToolInput = {}) {
  const owner = buildReminderOwnerContext(user);
  const { userId, phoneNumber } = owner;
  const timezone = user?.timezone || dependencies.DEFAULT_TIMEZONE;
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
      return `${idx + 1}. *${content}*${timeStr ? `\n   ${dependencies.PRESENTATION_TOKENS.ICONS.SCHEDULE_TIME} ${timeStr}` : ''}`;
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

  // deliveryPolicy is desired operational state, not language interpretation.
  // Legacy advanceMinutes is accepted at this boundary only for backwards compatibility.
  const deliveryPolicy = params.deliveryPolicy
    || (Number.isInteger(params.advanceMinutes)
      ? { advanceNotice: 'offset', advanceMinutes: params.advanceMinutes }
      : null);
  const explicitDeliveryPolicy = Boolean(deliveryPolicy);
  const existingAdvanceNotices = (resolved.pending || []).filter((reminder) => (
    reminder.id !== baseReminder.id
    && reminder.status === 'pending'
    && reminder.source === 'advance_notice'
    && belongsToMainReminder(reminder, baseReminder)
  ));

  if (deliveryPolicy) {
    const mode = deliveryPolicy!.advanceNotice;
    if (!['none', 'offset'].includes(mode)) {
      return {
        success: false,
        action: 'invalid_delivery_policy',
        errorCode: 'INVALID_PARAMETERS',
        error: language === 'en' ? 'Invalid reminder delivery policy.' : 'La política de entrega del recordatorio no es válida.',
      };
    }
    if (mode === 'offset' && (!Number.isInteger(deliveryPolicy!.advanceMinutes) || deliveryPolicy!.advanceMinutes! <= 0)) {
      return {
        success: false,
        action: 'invalid_delivery_policy',
        errorCode: 'INVALID_PARAMETERS',
        error: language === 'en' ? 'Advance notice needs a positive minute offset.' : 'El aviso previo necesita una cantidad válida de minutos.',
      };
    }
  }

  const dbUpdates: { content?: string; send_at?: string; status?: string; recurrence_rule?: string | null } = {};
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

  if (Object.keys(dbUpdates).length === 0 && !explicitDeliveryPolicy) {
    return {
      success: false,
      action: 'no_updates_provided',
      errorCode: 'INVALID_PARAMETERS',
      error: language === 'en' ? 'No update fields provided.' : 'No se especificaron cambios para el recordatorio.',
      rawSummary: language === 'en' ? 'No update fields provided.' : 'No se especificaron cambios para el recordatorio.',
    };
  }

  const prospectiveMain = {
    ...baseReminder,
    content: dbUpdates.content || baseReminder.content,
    send_at: dbUpdates.send_at || baseReminder.send_at,
  };

  // Validate an explicitly requested advance notice before mutating the primary.
  // Preserved derived state may simply expire when a primary is moved too close.
  const preservedAdvanceMinutes = existingAdvanceNotices.length > 0
    ? getAdvanceNoticeMinutes(existingAdvanceNotices[0]!, baseReminder)
    : null;
  const desiredAdvanceMode = explicitDeliveryPolicy
    ? deliveryPolicy!.advanceNotice
    : (preservedAdvanceMinutes ? 'offset' : 'none');
  const desiredAdvanceMinutes = desiredAdvanceMode === 'offset'
    ? (explicitDeliveryPolicy ? deliveryPolicy!.advanceMinutes : preservedAdvanceMinutes)
    : null;
  const referenceDate = referenceTime instanceof Date ? referenceTime : new Date(referenceTime || Date.now());
  const prospectiveAdvanceDate = desiredAdvanceMinutes
    ? new Date(new Date(prospectiveMain.send_at).getTime() - desiredAdvanceMinutes * 60 * 1000)
    : null;

  if (
    explicitDeliveryPolicy
    && desiredAdvanceMode === 'offset'
    && (!prospectiveAdvanceDate || prospectiveAdvanceDate.getTime() <= referenceDate.getTime())
  ) {
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

  const updated = Object.keys(dbUpdates).length > 0
    ? await updateReminder(resolvedTargetId, dbUpdates, userId, phoneNumber)
    : baseReminder;
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

  const cancelAdvanceNotices = async (notices: ReminderRow[]) => {
    const ids = notices.map((notice) => notice.id).filter(Boolean);
    if (ids.length === 0) return 0;
    let q = supabase.from('reminders').update({ status: 'cancelled' }).in('id', ids);
    q = scopeReminderQueryToOwner(q, owner)!;
    const { data, error } = await q.select('id');
    if (error) throw error;
    return data?.length || 0;
  };

  let activeAdvanceNotice: ReminderRow | null = null;
  let cancelledAdvanceNotices = 0;
  if (desiredAdvanceMode === 'none' || !prospectiveAdvanceDate || prospectiveAdvanceDate.getTime() <= referenceDate.getTime()) {
    cancelledAdvanceNotices = await cancelAdvanceNotices(existingAdvanceNotices);
  } else {
    const desiredContent = buildAdvanceNoticeContent(updated.content, desiredAdvanceMinutes);
    const desiredSendAt = prospectiveAdvanceDate.toISOString();
    activeAdvanceNotice = existingAdvanceNotices.find((notice) => (
      notice.content === desiredContent
      && new Date(notice.send_at).toISOString() === desiredSendAt
    )) || null;

    const staleNotices = existingAdvanceNotices.filter((notice) => notice.id !== activeAdvanceNotice?.id);
    cancelledAdvanceNotices = await cancelAdvanceNotices(staleNotices);

    if (activeAdvanceNotice) {
      if (activeAdvanceNotice.parent_reminder_id !== updated.id) {
        activeAdvanceNotice = await updateReminder(
          activeAdvanceNotice.id,
          { parent_reminder_id: updated.id },
          userId,
          phoneNumber,
        ) || activeAdvanceNotice;
      }
    } else {
      activeAdvanceNotice = await saveReminder({
        userId,
        phoneNumber,
        content: desiredContent,
        sendAt: desiredSendAt,
        parentReminderId: updated.id,
        requiresConfirmation: false,
        source: 'advance_notice',
      });
      if (!activeAdvanceNotice) {
        return {
          success: false,
          complete: false,
          partialSuccess: Object.keys(dbUpdates).length > 0,
          action: 'delivery_policy_reconciliation_failed',
          errorCode: 'DATABASE_ERROR',
          error: language === 'en'
            ? 'The reminder was updated, but its advance notice could not be reconciled.'
            : 'El recordatorio se actualizó, pero no se pudo reconciliar su aviso previo.',
          data: { reminder: updated },
        };
      }
    }
  }

  const formattedTime = formatHumanFriendlyDateTime(new Date(updated.send_at), timezone, language);
  let formattedCard = formatReminderUpdatedCard(updated, formattedTime, timezone, language);
  if (explicitDeliveryPolicy) {
    if (desiredAdvanceMode === 'none') {
      formattedCard = language === 'en'
        ? `✅ *Reminder updated*\n\n⏰ *${updated.content}*\n🔕 No advance notice`
        : `✅ *Recordatorio actualizado*\n\n⏰ *${updated.content}*\n🔕 Sin aviso previo`;
    } else if (activeAdvanceNotice) {
      const advanceFormatted = formatHumanFriendlyDateTime(new Date(activeAdvanceNotice.send_at), timezone, language);
      formattedCard = language === 'en'
        ? `✅ *Reminder updated*\n\n⏰ *${updated.content}*\n🔔 Advance notice · ${advanceFormatted}`
        : `✅ *Recordatorio actualizado*\n\n⏰ *${updated.content}*\n🔔 Aviso previo · ${advanceFormatted}`;
    }
  }

  return {
    success: true,
    action: 'updated_reminder',
    data: {
      id: updated.id,
      content: updated.content,
      sendAt: updated.send_at,
      formattedTime,
      recurrenceRule: updated.recurrence_rule,
      deliveryPolicy: {
        advanceNotice: activeAdvanceNotice ? 'offset' : 'none',
        advanceMinutes: activeAdvanceNotice ? desiredAdvanceMinutes : null,
      },
      advanceNotice: activeAdvanceNotice
        ? {
            id: activeAdvanceNotice.id,
            parentReminderId: updated.id,
            sendAt: activeAdvanceNotice.send_at,
          }
        : null,
      cancelledAdvanceNotices,
    },
    rawSummary: formattedCard,
    formattedCard,
  };
}

return { executeReminderUpdate };
}

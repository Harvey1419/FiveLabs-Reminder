import { supabase, markReminderAsCancelled } from '../../infrastructure/database/index.js';
import { formatReminderCancelledCard } from './formatters.js';
import {
  buildReminderOwnerContext,
  scopeReminderQueryToOwner,
} from './reminder-owner.js';

export async function executeBulkReminderCancellation({
  params = {},
  user = {},
  language = 'es',
  referenceTime = null,
  clarificationResolution = false,
} = {}) {
  const owner = buildReminderOwnerContext(user);
  const { userId, phoneNumber, phoneVariants } = owner;
  const scope = params.scope === 'elapsed' ? 'elapsed' : (params.scope === 'all' ? 'all' : null);

  if (!scope) {
    return {
      success: false,
      action: 'unsupported_action',
      errorCode: 'UNSUPPORTED_ACTION',
      error: language === 'en'
        ? 'Bulk cancellation requires scope "all" or "elapsed".'
        : 'La cancelación masiva requiere scope "all" o "elapsed".',
      rawSummary: language === 'en'
        ? 'Bulk cancellation requires a valid scope.'
        : 'La cancelación masiva requiere un alcance válido.',
    };
  }

  if (!owner.hasOwner) {
    return {
      success: false,
      action: 'missing_owner',
      errorCode: 'ACCESS_DENIED',
      error: language === 'en'
        ? 'I could not verify reminder ownership.'
        : 'No pude verificar la propiedad de los recordatorios.',
    };
  }

  const requestedReference = referenceTime instanceof Date ? referenceTime : new Date(referenceTime || Date.now());
  const cancellationReference = Number.isNaN(requestedReference.getTime()) ? new Date() : requestedReference;
  const suppliedCutoff = params.cutoffAt ? new Date(params.cutoffAt) : null;
  const cutoffDate = suppliedCutoff && !Number.isNaN(suppliedCutoff.getTime())
    ? suppliedCutoff
    : cancellationReference;

  let query = supabase.from('reminders').select('*');
  if (scope === 'elapsed') {
    query = query.neq('status', 'cancelled').lt('send_at', cutoffDate.toISOString());
  } else {
    query = query.in('status', ['pending', 'sent']).is('acknowledged_at', null);
  }
  query = scopeReminderQueryToOwner(query, owner);

  const { data, error } = await query.order('send_at', { ascending: false }).limit(500);
  if (error) {
    const message = language === 'en'
      ? 'I could not verify the reminders to cancel.'
      : 'No pude verificar los recordatorios que se cancelarían.';
    return {
      success: false,
      action: 'database_error',
      errorCode: 'DATABASE_ERROR',
      error: message,
      rawSummary: message,
    };
  }

  const candidates = data || [];
  if (candidates.length === 0) {
    const message = scope === 'elapsed'
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
      data: { cancelledCount: 0, remainingCount: 0, scope },
      rawSummary: message,
      formattedCard: message,
    };
  }

  if (!clarificationResolution) {
    const question = scope === 'elapsed'
      ? (language === 'en'
        ? `I found ${candidates.length} reminder${candidates.length === 1 ? '' : 's'} whose scheduled time has passed. Should I remove ${candidates.length === 1 ? 'it' : 'them'} from your list?`
        : `Encontré ${candidates.length} ${candidates.length === 1 ? 'recordatorio cuya hora ya pasó' : 'recordatorios cuya hora ya pasó'}. ¿Quieres que ${candidates.length === 1 ? 'lo elimine' : 'los elimine'} de tu lista?`)
      : (language === 'en'
        ? `Should I cancel all ${candidates.length} active reminder${candidates.length === 1 ? '' : 's'}?`
        : `¿Quieres que cancele los ${candidates.length} recordatorios activos?`);

    const proposedOperation = {
      kind: 'reminder_cancel',
      scope,
      ...(scope === 'elapsed' ? { cutoffAt: cutoffDate.toISOString() } : {}),
    };
    const pendingClarifications = [{
      type: 'reminder_cancellation',
      content: scope === 'elapsed'
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
      requiresClarification: true,
      pendingClarifications,
      data: { pendingClarifications, candidateCount: candidates.length },
    };
  }

  let cancelledCount = 0;
  const failedCandidates = [];
  for (const reminder of candidates) {
    const cancellationUserId = reminder.user_id === userId ? userId : null;
    const cancellationPhone = cancellationUserId
      ? null
      : (reminder.phone_number && phoneVariants.includes(reminder.phone_number) ? reminder.phone_number : phoneNumber);
    const cancelled = await markReminderAsCancelled(reminder.id, cancellationUserId, cancellationPhone);
    if (cancelled) cancelledCount += 1;
    else failedCandidates.push(reminder);
  }

  const failedCount = failedCandidates.length;
  const formattedCard = scope === 'elapsed'
    ? (language === 'en'
      ? `🗑️ *Elapsed reminders removed*\n\nRemoved ${cancelledCount} reminder${cancelledCount === 1 ? '' : 's'} whose scheduled time had passed.${failedCount ? ` ${failedCount} could not be removed.` : ''}`
      : `🗑️ *Recordatorios anteriores eliminados*\n\nEliminé ${cancelledCount} ${cancelledCount === 1 ? 'recordatorio cuya hora ya había pasado' : 'recordatorios cuya hora ya había pasado'}.${failedCount ? ` No se pudieron eliminar ${failedCount}.` : ''}`)
    : formatReminderCancelledCard(cancelledCount, failedCount, '', language);

  return {
    success: cancelledCount > 0 || candidates.length === 0,
    complete: failedCount === 0,
    partialSuccess: cancelledCount > 0 && failedCount > 0,
    action: failedCount > 0 ? 'partially_cancelled_reminders' : 'cancelled_reminders',
    data: {
      cancelledCount,
      remainingCount: failedCount,
      scope,
      failedCount,
    },
    rawSummary: formattedCard,
    formattedCard,
  };
}

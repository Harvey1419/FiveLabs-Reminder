import { supabase } from '../../infrastructure/database/index.js';
import { normalizePhoneNumber } from '../../integrations/whatsapp/kapso-client.js';
import { resolveEntityReference } from '../core/working-memory.js';
import {
  isStrictUUID,
  calculateMatchScore,
} from '../../shared/entity-resolution.js';

function ownerPhoneVariants(phoneNumber) {
  const clean = phoneNumber ? normalizePhoneNumber(phoneNumber) || phoneNumber : null;
  return Array.from(new Set([
    phoneNumber,
    clean,
    clean ? `+${clean}` : null,
  ].filter(Boolean)));
}

function isOwned(reminder, userId, phoneVariants) {
  return Boolean(
    (userId && reminder?.user_id === userId)
    || (reminder?.phone_number && phoneVariants.includes(reminder.phone_number)),
  );
}

function isActive(reminder) {
  return ['pending', 'sent', 'processing'].includes(reminder?.status)
    && !reminder?.acknowledged_at;
}

function localParts(value, timezone) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  try {
    const parts = {};
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC',
      weekday: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    for (const part of formatter.formatToParts(date)) {
      if (part.type !== 'literal') parts[part.type] = part.value;
    }
    return parts;
  } catch {
    return null;
  }
}

/**
 * Temporary logical-series fingerprint for the existing recurrence model.
 * The scheduler materializes each next occurrence as a new row and does not
 * yet persist a series_id, so content + recurrence + local cadence position
 * is the safest stable identity available without a schema migration.
 */
function recurrenceFingerprint(reminder, timezone) {
  const rule = String(reminder?.recurrence_rule || '').trim().toLowerCase();
  if (!rule) return null;
  const parts = localParts(reminder?.send_at, timezone);
  const clock = parts ? `${parts.hour}:${parts.minute}` : '';

  if (rule === 'daily' || rule === 'weekdays') return `${rule}|${clock}`;
  if (rule === 'monthly') return `${rule}|${parts?.day || ''}|${clock}`;
  if (rule === 'weekly' || rule.startsWith('weekly:')) return `${rule}|${parts?.weekday || ''}|${clock}`;
  return `${rule}|${clock}`;
}

function resolveByScore(reference, reminders) {
  const scored = reminders
    .map((reminder) => ({ reminder, score: calculateMatchScore(reference, reminder.content || '') }))
    .filter(({ score }) => score >= 0.5)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { status: 'NOT_FOUND' };
  if (scored.length === 1) return { status: 'RESOLVED', reminder: scored[0].reminder };

  const [top, runnerUp] = scored;
  if (top.score >= 0.75 && (top.score - runnerUp.score) >= 0.20) {
    return { status: 'RESOLVED', reminder: top.reminder };
  }
  return { status: 'AMBIGUOUS', reminders: scored.map(({ reminder }) => reminder) };
}

function cancellationCard({ reminder, count, recurring, language }) {
  const content = reminder?.content || (language === 'en' ? 'Reminder' : 'Recordatorio');
  if (recurring) {
    return language === 'en'
      ? `🗑️ *Recurring reminder cancelled*\n\n🔁 *${content}*\nThe active series was cancelled and no pending occurrence will remain scheduled.`
      : `🗑️ *Recordatorio recurrente eliminado*\n\n🔁 *${content}*\nLa serie activa quedó cancelada y no quedan ocurrencias pendientes programadas.`;
  }
  return language === 'en'
    ? `🗑️ *Reminder cancelled*\n\n🔔 *${content}*`
    : `🗑️ *Recordatorio eliminado*\n\n🔔 *${content}*`;
}

/**
 * Canonical single reminder cancellation.
 * A recurring target represents its logical active series, not one generated
 * occurrence row. Bulk scopes remain in reminders.js because they own their
 * typed confirmation flow.
 */
export async function executeSingleReminderCancellation({
  params = {},
  user = null,
  language = 'es',
  userMessage = '',
  correlationId = null,
} = {}) {
  const reqId = correlationId ? `[reminder-cancel req=${correlationId}]` : '[reminder-cancel]';
  const userId = user?.id || null;
  const phoneNumber = user?.phone_number || null;
  const timezone = user?.timezone || 'America/Bogota';
  const phoneVariants = ownerPhoneVariants(phoneNumber);
  const rawTarget = params.reminderId || params.id || params.target || params.contentQuery || params.query || userMessage || '';
  const target = String(rawTarget || '').trim();

  console.log(`${reqId} start target=${JSON.stringify(target)} user=${userId || phoneNumber || 'unknown'}`);

  if (!userId && phoneVariants.length === 0) {
    return {
      success: false,
      action: 'missing_owner',
      errorCode: 'ACCESS_DENIED',
      error: language === 'en' ? 'I could not verify reminder ownership.' : 'No pude verificar la propiedad del recordatorio.',
    };
  }

  let query = supabase
    .from('reminders')
    .select('id,user_id,phone_number,status,acknowledged_at,content,recurrence_rule,send_at,created_at');

  if (userId && phoneVariants.length > 0) {
    const phoneConditions = phoneVariants.map((phone) => `phone_number.eq.${phone}`).join(',');
    query = query.or(`user_id.eq.${userId},${phoneConditions}`);
  } else if (userId) {
    query = query.eq('user_id', userId);
  } else {
    query = query.in('phone_number', phoneVariants);
  }

  const { data: rows, error } = await query.order('send_at', { ascending: false }).limit(200);
  if (error) {
    console.error(`${reqId} candidate read failed:`, error.message || error);
    return {
      success: false,
      action: 'database_error',
      errorCode: 'DATABASE_ERROR',
      error: language === 'en' ? 'I could not verify the reminder to cancel.' : 'No pude verificar el recordatorio que quieres eliminar.',
    };
  }

  const owned = (rows || []).filter((row) => isOwned(row, userId, phoneVariants));
  const active = owned.filter(isActive);
  console.log(`${reqId} candidates owned=${owned.length} active=${active.length}`);

  if (!target) {
    return {
      success: false,
      action: 'missing_target',
      errorCode: 'MISSING_TARGET',
      error: language === 'en' ? 'Which reminder should I cancel?' : '¿Cuál recordatorio quieres que elimine?',
      requiresClarification: true,
    };
  }

  let base = null;
  if (isStrictUUID(target)) {
    base = owned.find((row) => row.id === target) || null;
  } else if (target.length >= 8) {
    base = owned.find((row) => row.id.startsWith(target)) || null;
  }

  if (!base) {
    const candidates = active.map((row) => ({
      id: row.id,
      internalId: row.id,
      type: 'reminder',
      content: row.content,
      summary: row.content,
      time: row.send_at,
      raw: row,
    }));
    const resolved = resolveEntityReference({
      userOrPhone: user || phoneNumber,
      reference: target,
      candidates,
      preferredType: 'reminder',
    });
    if (resolved.status === 'RESOLVED' && resolved.item?.internalId) {
      base = owned.find((row) => row.id === resolved.item.internalId) || resolved.item.raw || null;
      console.log(`${reqId} target resolved via entity context id=${base?.id || 'none'} status=${base?.status || 'unknown'}`);
    }
  }

  if (!base) {
    const scored = resolveByScore(target, active);
    if (scored.status === 'RESOLVED') {
      base = scored.reminder;
      console.log(`${reqId} target resolved via semantic score id=${base.id}`);
    } else if (scored.status === 'AMBIGUOUS') {
      console.warn(`${reqId} ambiguous target matches=${scored.reminders.length}`);
      return {
        success: false,
        action: 'ambiguous_target',
        errorCode: 'AMBIGUOUS_TARGET',
        error: language === 'en'
          ? 'Several reminders match. Tell me which one you want to cancel.'
          : 'Hay varios recordatorios que coinciden. Dime cuál quieres eliminar.',
        requiresClarification: true,
      };
    }
  }

  if (!base) {
    console.warn(`${reqId} target not found`);
    return {
      success: false,
      action: 'reminder_not_found',
      errorCode: 'NOT_FOUND',
      error: language === 'en' ? 'Reminder not found.' : 'No encontré ese recordatorio.',
    };
  }

  const recurring = Boolean(base.recurrence_rule);
  let targets = [];

  if (recurring) {
    const fingerprint = recurrenceFingerprint(base, timezone);
    targets = active.filter((row) => (
      row.content === base.content
      && row.recurrence_rule === base.recurrence_rule
      && recurrenceFingerprint(row, timezone) === fingerprint
    ));
    console.log(`${reqId} recurring series rule=${base.recurrence_rule} fingerprint=${fingerprint} activeOccurrences=${targets.length}`);
  } else if (isActive(base)) {
    targets = [base];
  }

  if (targets.length === 0) {
    const message = recurring
      ? (language === 'en' ? 'That recurring reminder is already cancelled.' : 'Ese recordatorio recurrente ya está cancelado.')
      : (language === 'en' ? 'That reminder is already cancelled or completed.' : 'Ese recordatorio ya está cancelado o completado.');
    console.log(`${reqId} nothing active to cancel baseStatus=${base.status}`);
    return {
      success: true,
      complete: true,
      action: 'reminder_already_inactive',
      data: { cancelledCount: 0, recurring, targetId: base.id },
      rawSummary: message,
      formattedCard: message,
      confirmation: message,
    };
  }

  const ids = targets.map((row) => row.id);
  let update = supabase.from('reminders').update({ status: 'cancelled' }).in('id', ids);
  if (userId && phoneVariants.length === 0) update = update.eq('user_id', userId);
  const { data: cancelled, error: updateError } = await update.select('id');
  if (updateError) {
    console.error(`${reqId} cancellation write failed:`, updateError.message || updateError);
    return {
      success: false,
      action: 'database_error',
      errorCode: 'DATABASE_ERROR',
      error: language === 'en' ? 'I could not cancel the reminder.' : 'No pude eliminar el recordatorio.',
    };
  }

  const cancelledCount = cancelled?.length || 0;
  console.log(`${reqId} cancelled count=${cancelledCount} recurring=${recurring} ids=${ids.join(',')}`);
  const card = cancellationCard({ reminder: base, count: cancelledCount, recurring, language });
  return {
    success: cancelledCount > 0,
    complete: cancelledCount === ids.length,
    partialSuccess: cancelledCount > 0 && cancelledCount !== ids.length,
    action: recurring ? 'cancelled_recurring_reminder_series' : 'cancelled_reminder',
    data: {
      cancelledCount,
      recurring,
      recurrenceRule: base.recurrence_rule || null,
      content: base.content,
    },
    rawSummary: card,
    formattedCard: card,
    confirmation: card,
  };
}

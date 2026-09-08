import { supabase, acknowledgeReminder } from '../../infrastructure/database/index.js';
import { normalizePhoneNumber, stripReminderPrefix } from '../../integrations/whatsapp/kapso-client.js';
import { resolveEntityReference } from '../core/working-memory.js';
import { isStrictUUID, calculateMatchScore } from '../../shared/entity-resolution.js';
import { formatReminderAcknowledgedCard } from './formatters.js';

function ownerPhoneVariants(phoneNumber) {
  const clean = phoneNumber ? normalizePhoneNumber(phoneNumber) || phoneNumber : null;
  return Array.from(new Set([phoneNumber, clean, clean ? `+${clean}` : null].filter(Boolean)));
}

function isOwned(reminder, userId, phoneVariants) {
  return Boolean((userId && reminder?.user_id === userId) || (reminder?.phone_number && phoneVariants.includes(reminder.phone_number)));
}

function resolveByScore(reference, reminders) {
  const scored = reminders.map((reminder) => ({ reminder, score: calculateMatchScore(reference, reminder.content || '') })).filter(({ score }) => score >= 0.5).sort((a, b) => b.score - a.score);
  if (scored.length === 0) return { status: 'NOT_FOUND' };
  if (scored.length === 1) return { status: 'RESOLVED', reminder: scored[0].reminder };
  const [top, runnerUp] = scored;
  if (top.score >= 0.75 && (top.score - runnerUp.score) >= 0.20) return { status: 'RESOLVED', reminder: top.reminder };
  return { status: 'AMBIGUOUS' };
}

/** Canonical acknowledgement mutation. Semantic intent is resolved upstream;
 * this module only resolves the structured target against owned reminder rows. */
export async function executeReminderAcknowledgement({ params = {}, user = null, language = 'es', correlationId = null } = {}) {
  const reqId = correlationId ? `[reminder-ack req=${correlationId}]` : '[reminder-ack]';
  const userId = user?.id || null;
  const phoneNumber = user?.phone_number || null;
  const phoneVariants = ownerPhoneVariants(phoneNumber);
  const target = String(params.reminderId || params.id || params.target || params.contentQuery || params.query || '').trim();

  if (!target) return { success: false, action: 'missing_target', errorCode: 'MISSING_TARGET', error: language === 'en' ? 'Which reminder did you complete?' : '¿Cuál recordatorio completaste?', requiresClarification: true };
  if (!userId && phoneVariants.length === 0) return { success: false, action: 'missing_owner', errorCode: 'ACCESS_DENIED', error: language === 'en' ? 'I could not verify reminder ownership.' : 'No pude verificar la propiedad del recordatorio.' };

  let query = supabase.from('reminders').select('*').neq('status', 'cancelled');
  if (userId && phoneVariants.length > 0) {
    const phoneConditions = phoneVariants.map((phone) => `phone_number.eq.${phone}`).join(',');
    query = query.or(`user_id.eq.${userId},${phoneConditions}`);
  } else if (userId) query = query.eq('user_id', userId);
  else query = query.in('phone_number', phoneVariants);

  const { data: rows, error } = await query.order('send_at', { ascending: false }).limit(100);
  if (error) {
    console.error(`${reqId} candidate read failed:`, error.message || error);
    return { success: false, action: 'database_error', errorCode: 'DATABASE_ERROR', error: language === 'en' ? 'I could not verify the reminder.' : 'No pude verificar el recordatorio.' };
  }

  const owned = (rows || []).filter((row) => isOwned(row, userId, phoneVariants));
  const active = owned.filter((row) => !row.acknowledged_at);
  let matched = null;
  if (isStrictUUID(target)) matched = owned.find((row) => row.id === target) || null;
  else if (target.length >= 8) matched = owned.find((row) => row.id.startsWith(target)) || null;

  if (!matched && active.length > 0) {
    const candidates = active.map((row) => ({ id: row.id, internalId: row.id, type: 'reminder', content: row.content, summary: row.content, time: row.send_at, raw: row }));
    const resolved = resolveEntityReference({ userOrPhone: user || phoneNumber, reference: target, candidates, preferredType: 'reminder' });
    if (resolved.status === 'RESOLVED' && resolved.item?.internalId) matched = owned.find((row) => row.id === resolved.item.internalId) || resolved.item.raw || null;
    else if (resolved.status === 'AMBIGUOUS') return { success: false, action: 'ambiguous_target', errorCode: 'AMBIGUOUS_TARGET', error: language === 'en' ? 'Several reminders match. Tell me which one you completed.' : 'Hay varios recordatorios que coinciden. Dime cuál completaste.', requiresClarification: true };
  }

  if (!matched && active.length > 0) {
    const scored = resolveByScore(target, active);
    if (scored.status === 'RESOLVED') matched = scored.reminder;
    else if (scored.status === 'AMBIGUOUS') return { success: false, action: 'ambiguous_target', errorCode: 'AMBIGUOUS_TARGET', error: language === 'en' ? 'Several reminders match. Tell me which one you completed.' : 'Hay varios recordatorios que coinciden. Dime cuál completaste.', requiresClarification: true };
  }

  if (!matched) {
    const scored = resolveByScore(target, owned.filter((row) => row.acknowledged_at));
    if (scored.status === 'RESOLVED') matched = scored.reminder;
  }
  if (!matched) return { success: false, action: 'reminder_not_found', errorCode: 'NOT_FOUND', error: language === 'en' ? 'Reminder not found.' : 'No encontré ese recordatorio.' };

  let confirmed = matched;
  if (!matched.acknowledged_at) {
    const acknowledged = await acknowledgeReminder(matched.id, userId);
    if (!acknowledged) return { success: false, action: 'database_error', errorCode: 'DATABASE_ERROR', error: language === 'en' ? 'I could not confirm the reminder.' : 'No pude confirmar el recordatorio.' };
    confirmed = acknowledged;
  }

  const formattedCard = formatReminderAcknowledgedCard(confirmed, language);
  return { success: true, action: 'acknowledged_reminder', reminderId: confirmed.id, title: stripReminderPrefix(confirmed.content || confirmed.title || ''), data: confirmed, rawSummary: formattedCard, formattedCard, confirmation: formattedCard };
}

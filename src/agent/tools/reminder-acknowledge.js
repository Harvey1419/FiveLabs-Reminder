import { supabase, acknowledgeReminder } from '../../infrastructure/database/index.js';
import { stripReminderPrefix } from '../../integrations/whatsapp/kapso-client.js';
import { resolveContextReference } from '../core/context-reference.js';
import { formatReminderAcknowledgedCard } from './formatters.js';
import {
  buildReminderOwnerContext,
  isReminderOwned,
  scopeReminderQueryToOwner,
} from './reminder-owner.js';
import {
  findReminderByExactReference,
  buildReminderReferenceCandidates,
  resolveReminderByScore,
} from './reminder-reference.js';

/** Canonical acknowledgement mutation. Semantic intent is resolved upstream;
 * this module only resolves the structured target against owned reminder rows. */
export async function executeReminderAcknowledgement({ params = {}, user = null, language = 'es', correlationId = null } = {}) {
  const reqId = correlationId ? `[reminder-ack req=${correlationId}]` : '[reminder-ack]';
  const owner = buildReminderOwnerContext(user);
  const { userId, phoneNumber } = owner;
  const target = String(params.target || '').trim();
  const authoritativeReminderId = String(params.reminderId || '').trim();

  if (!target) return { success: false, action: 'missing_target', errorCode: 'MISSING_TARGET', error: language === 'en' ? 'Which reminder did you complete?' : '¿Cuál recordatorio completaste?', requiresClarification: true };
  if (!owner.hasOwner) return { success: false, action: 'missing_owner', errorCode: 'ACCESS_DENIED', error: language === 'en' ? 'I could not verify reminder ownership.' : 'No pude verificar la propiedad del recordatorio.' };

  let matched = null;
  let owned = [];
  let active = [];

  if (authoritativeReminderId) {
    let exactQuery = supabase
      .from('reminders')
      .select('*')
      .eq('id', authoritativeReminderId)
      .neq('status', 'cancelled');
    exactQuery = scopeReminderQueryToOwner(exactQuery, owner);
    const { data, error } = await exactQuery.maybeSingle();
    if (error) {
      console.error(`${reqId} authoritative reminder read failed:`, error.message || error);
      return { success: false, action: 'database_error', errorCode: 'DATABASE_ERROR', error: language === 'en' ? 'I could not verify the reminder.' : 'No pude verificar el recordatorio.' };
    }
    if (!data || !isReminderOwned(data, owner)) {
      return { success: false, action: 'reminder_not_found', errorCode: 'NOT_FOUND', error: language === 'en' ? 'Reminder not found.' : 'No encontré ese recordatorio.' };
    }
    matched = data;
  } else {
    const query = scopeReminderQueryToOwner(supabase.from('reminders').select('*').neq('status', 'cancelled'), owner);
    const { data: rows, error } = await query.order('send_at', { ascending: false }).limit(100);
    if (error) {
      console.error(`${reqId} candidate read failed:`, error.message || error);
      return { success: false, action: 'database_error', errorCode: 'DATABASE_ERROR', error: language === 'en' ? 'I could not verify the reminder.' : 'No pude verificar el recordatorio.' };
    }
    owned = (rows || []).filter((row) => isReminderOwned(row, owner));
    active = owned.filter((row) => !row.acknowledged_at);
    matched = findReminderByExactReference(target, owned);
  }

  if (!matched && active.length > 0) {
    const resolved = resolveContextReference({
      userOrPhone: user || phoneNumber,
      reference: target,
      candidates: buildReminderReferenceCandidates(active),
      preferredType: 'reminder',
    });
    if (resolved.status === 'RESOLVED' && resolved.item?.internalId) matched = owned.find((row) => row.id === resolved.item.internalId) || resolved.item.raw || null;
    else if (resolved.status === 'AMBIGUOUS') return { success: false, action: 'ambiguous_target', errorCode: 'AMBIGUOUS_TARGET', error: language === 'en' ? 'Several reminders match. Tell me which one you completed.' : 'Hay varios recordatorios que coinciden. Dime cuál completaste.', requiresClarification: true };
  }

  if (!matched && active.length > 0) {
    const scored = resolveReminderByScore(target, active);
    if (scored.status === 'RESOLVED') matched = scored.reminder;
    else if (scored.status === 'AMBIGUOUS') return { success: false, action: 'ambiguous_target', errorCode: 'AMBIGUOUS_TARGET', error: language === 'en' ? 'Several reminders match. Tell me which one you completed.' : 'Hay varios recordatorios que coinciden. Dime cuál completaste.', requiresClarification: true };
  }

  if (!matched) {
    const scored = resolveReminderByScore(target, owned.filter((row) => row.acknowledged_at));
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

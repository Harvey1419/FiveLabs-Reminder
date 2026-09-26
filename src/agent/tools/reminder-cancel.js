import { supabase } from '../../infrastructure/database/index.js';
import { resolveContextReference } from '../core/context-reference.js';
import {
  parseAdvanceNoticeContent,
  isAdvanceNoticeContent,
  belongsToMainReminder,
} from './reminder-advance.js';
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
import { isStrictUUID } from '../../shared/entity-resolution.js';

const PG_TS_CONFIGS = Object.freeze({
  es: 'spanish',
  en: 'english',
  pt: 'portuguese',
  fr: 'french',
  de: 'german',
  it: 'italian',
  ca: 'catalan',
  ru: 'russian',
  ar: 'arabic',
});

function getPostgresTextSearchConfig(lang) {
  if (!lang || typeof lang !== 'string') return 'spanish';
  const prefix = lang.trim().toLowerCase().split(/[-_]/)[0];
  return PG_TS_CONFIGS[prefix] || (prefix === 'en' ? 'english' : 'spanish');
}

function isActive(reminder) {
  return ['pending', 'sent', 'processing'].includes(reminder?.status)
    && !reminder?.acknowledged_at;
}

function isAdvanceNotice(reminder) {
  return isAdvanceNoticeContent(reminder?.content);
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
 * Compatibility fingerprint for recurring rows created before stable recurring
 * IDs were introduced. New recurring reminders retain one UUID, but older data
 * may still contain sibling rows that belong to the same logical routine.
 */
function recurrenceFingerprint(reminder, timezone) {
  const rule = String(reminder?.recurrence_rule || '').trim().toLowerCase();
  if (!rule) return null;
  if (rule.startsWith('hourly') || rule.startsWith('interval')) return rule;
  const parts = localParts(reminder?.send_at, timezone);
  const clock = parts ? `${parts.hour}:${parts.minute}` : '';

  if (rule === 'daily' || rule === 'weekdays') return `${rule}|${clock}`;
  if (rule === 'monthly') return `${rule}|${parts?.day || ''}|${clock}`;
  if (rule === 'weekly' || rule.startsWith('weekly:')) return `${rule}|${parts?.weekday || ''}|${clock}`;
  return `${rule}|${clock}`;
}

function cancellationCard({ reminder, recurring, language }) {
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

function ambiguousCandidateSnapshot(reminders = []) {
  return reminders.map((reminder) => ({
    id: reminder.id,
    type: 'reminder',
    content: reminder.content,
    summary: reminder.content,
    time: reminder.send_at || null,
    send_at: reminder.send_at || null,
    status: reminder.status || null,
  }));
}

/**
 * Canonical single reminder cancellation.
 * A recurring target represents its logical active series. Advance notices are
 * children of their main reminder and never compete as independent human-facing
 * cancellation candidates.
 */
export async function executeSingleReminderCancellation({
  params = {},
  user = null,
  language = 'es',
  correlationId = null,
} = {}) {
  const reqId = correlationId ? `[reminder-cancel req=${correlationId}]` : '[reminder-cancel]';
  const owner = buildReminderOwnerContext(user);
  const { userId, phoneNumber, phoneVariants } = owner;
  const timezone = user?.timezone || 'America/Bogota';
  const target = String(params.target || '').trim();

  console.log(`${reqId} start target=${JSON.stringify(target)} user=${userId || phoneNumber || 'unknown'}`);

  if (!owner.hasOwner) {
    return {
      success: false,
      action: 'missing_owner',
      errorCode: 'ACCESS_DENIED',
      error: language === 'en' ? 'I could not verify reminder ownership.' : 'No pude verificar la propiedad del recordatorio.',
    };
  }

  let query = supabase
    .from('reminders')
    .select('id,user_id,phone_number,status,acknowledged_at,content,recurrence_rule,send_at,created_at,source');
  query = scopeReminderQueryToOwner(query, owner);
  if (typeof query?.neq === 'function') {
    query = query.neq('source', 'gcal_companion');
  } else if (typeof query?.not === 'function') {
    query = query.not('content', 'ilike', '🔔 [Google Calendar]%');
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

  const userRows = (rows || []).filter((row) => (
    row.source !== 'gcal_companion'
    && !row.delivery_id?.startsWith('gcal:')
    && !row.content?.startsWith('🔔 [Google Calendar]')
  ));
  const candidateRows = userRows.length > 0 ? userRows : (rows || []);
  const owned = candidateRows.filter((row) => isReminderOwned(row, owner));
  const active = owned.filter(isActive);
  const activePrimary = active.filter((row) => !isAdvanceNotice(row));
  console.log(`${reqId} candidates owned=${owned.length} active=${active.length} primary=${activePrimary.length}`);

  if (!target) {
    return {
      success: false,
      action: 'missing_target',
      errorCode: 'MISSING_TARGET',
      error: language === 'en' ? 'Which reminder should I cancel?' : '¿Cuál recordatorio quieres que elimine?',
      requiresClarification: true,
    };
  }

  let base = findReminderByExactReference(target, owned);

  if (!base) {
    const resolved = resolveContextReference({
      userOrPhone: user || phoneNumber,
      reference: target,
      candidates: buildReminderReferenceCandidates(activePrimary),
      preferredType: 'reminder',
    });
    if (resolved.status === 'RESOLVED' && resolved.item?.internalId) {
      base = owned.find((row) => row.id === resolved.item.internalId) || resolved.item.raw || null;
      console.log(`${reqId} target resolved via structured context id=${base?.id || 'none'} status=${base?.status || 'unknown'}`);
    }
  }

  if (!base) {
    const scored = resolveReminderByScore(target, activePrimary);
    if (scored.status === 'RESOLVED') {
      base = scored.reminder;
      console.log(`${reqId} target resolved via deterministic score id=${base.id}`);
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
        data: {
          reminders: ambiguousCandidateSnapshot(scored.reminders),
        },
      };
    }
  }

  if (!base && (isStrictUUID(target) || (target.length >= 8 && /^[0-9a-f-]+$/i.test(target)))) {
    let directQ = supabase
      .from('reminders')
      .select('id,user_id,phone_number,status,acknowledged_at,content,recurrence_rule,send_at,created_at');
    if (isStrictUUID(target)) {
      directQ = directQ.eq('id', target);
    } else {
      directQ = directQ.ilike('id', `${target}%`);
    }
    directQ = scopeReminderQueryToOwner(directQ, owner);
    const { data: directRows } = await directQ.limit(5);
    const directOwned = (directRows || []).filter((r) => isReminderOwned(r, owner));
    if (directOwned.length === 1) {
      base = directOwned[0];
      console.log(`${reqId} target resolved via direct DB id lookup id=${base.id}`);
    }
  }

  if (!base && typeof target === 'string' && target.trim().length >= 3 && !/^\d+$/.test(target.trim())) {
    const cleanSearchTarget = target.trim();

    // 1. Primary DB resolution: PostgreSQL Full-Text Search (websearch) for keyword and natural phrasing,
    // with graceful fallback to ilike if FTS returns no matches or is not implemented in test mocks.
    let textRows = null;
    let usedFts = false;
    try {
      let q = supabase
        .from('reminders')
        .select('id,user_id,phone_number,status,acknowledged_at,content,recurrence_rule,send_at,created_at');
      if (typeof q?.textSearch === 'function') {
        usedFts = true;
        const langConfig = getPostgresTextSearchConfig(language);
        q = q.textSearch('content', cleanSearchTarget, { type: 'websearch', config: langConfig });
        q = scopeReminderQueryToOwner(q, owner);
        const { data } = await q.order('created_at', { ascending: false }).limit(10);
        textRows = data;
      } else if (typeof q?.ilike === 'function') {
        q = q.ilike('content', `%${cleanSearchTarget}%`);
        q = scopeReminderQueryToOwner(q, owner);
        const { data } = await q.order('created_at', { ascending: false }).limit(20);
        textRows = data;
      }
    } catch (ftsErr) {
      console.warn(`${reqId} DB text search caught error:`, ftsErr.message);
    }

    // Secondary fallback: if FTS was executed but returned zero rows, try ilike substring search
    if (usedFts && (!textRows || textRows.length === 0)) {
      try {
        let ilikeQ = supabase
          .from('reminders')
          .select('id,user_id,phone_number,status,acknowledged_at,content,recurrence_rule,send_at,created_at')
          .ilike('content', `%${cleanSearchTarget}%`);
        ilikeQ = scopeReminderQueryToOwner(ilikeQ, owner);
        const { data } = await ilikeQ.order('created_at', { ascending: false }).limit(20);
        textRows = data;
      } catch (ilikeErr) {
        console.warn(`${reqId} DB ilike fallback caught error:`, ilikeErr.message);
      }
    }

    const textOwned = (textRows || []).filter((r) => isReminderOwned(r, owner) && isActive(r) && !isAdvanceNotice(r));
    if (textOwned.length === 1) {
      base = textOwned[0];
      console.log(`${reqId} target resolved via DB content lookup id=${base.id} content="${base.content}"`);
    } else if (textOwned.length > 1) {
      const scored = resolveReminderByScore(cleanSearchTarget, textOwned);
      if (scored.status === 'RESOLVED') {
        base = scored.reminder;
        console.log(`${reqId} target resolved via DB scored content lookup id=${base.id} content="${base.content}"`);
      }
    }
  }

  if (!base) {
    const ownedSample = owned.slice(0, 5).map((r) => r.id).join(',');
    const activeSample = active.slice(0, 5).map((r) => r.id).join(',');
    console.warn(`${reqId} target not found. target=${JSON.stringify(target)} owned=${owned.length} active=${active.length} ownedSample=[${ownedSample}] activeSample=[${activeSample}]`);
    return {
      success: false,
      action: 'reminder_not_found',
      errorCode: 'NOT_FOUND',
      error: language === 'en' ? 'Reminder not found.' : 'No encontré ese recordatorio.',
    };
  }

  const recurring = Boolean(base.recurrence_rule);
  let primaryTargets = [];

  if (recurring) {
    const fingerprint = recurrenceFingerprint(base, timezone);
    primaryTargets = activePrimary.filter((row) => (
      row.content === base.content
      && row.recurrence_rule === base.recurrence_rule
      && recurrenceFingerprint(row, timezone) === fingerprint
    ));
    if (isActive(base) && !primaryTargets.some((row) => row.id === base.id)) {
      primaryTargets.push(base);
    }
    if (primaryTargets.length === 0) {
      try {
        let seriesQ = supabase
          .from('reminders')
          .select('id,user_id,phone_number,status,acknowledged_at,content,recurrence_rule,send_at,created_at')
          .eq('content', base.content)
          .eq('recurrence_rule', base.recurrence_rule)
          .in('status', ['pending', 'sent', 'processing']);
        seriesQ = scopeReminderQueryToOwner(seriesQ, owner);
        const { data: dbSeries } = await seriesQ.limit(20);
        const dbActive = (dbSeries || []).filter((row) => isReminderOwned(row, owner) && isActive(row));
        const matched = dbActive.filter((row) => recurrenceFingerprint(row, timezone) === fingerprint);
        if (matched.length > 0) {
          primaryTargets = matched;
        } else if (dbActive.length > 0) {
          primaryTargets = dbActive;
        }
      } catch (seriesErr) {
        console.warn(`${reqId} recurring series DB fallback failed:`, seriesErr.message);
      }
    }
    console.log(`${reqId} recurring series rule=${base.recurrence_rule} fingerprint=${fingerprint} activeOccurrences=${primaryTargets.length}`);
  } else if (isActive(base)) {
    primaryTargets = [base];
  }

  // If an internal UUID explicitly points to an advance notice, honour that
  // exact technical target. Human-facing resolution never chooses notices.
  if (primaryTargets.length === 0 && isAdvanceNotice(base) && isActive(base)) {
    primaryTargets = [base];
  }

  if (primaryTargets.length === 0) {
    const message = recurring
      ? (language === 'en' ? 'That recurring reminder is already cancelled.' : 'Ese recordatorio recurrente ya está cancelado.')
      : (language === 'en' ? 'That reminder is already cancelled or completed.' : 'Ese recordatorio ya está cancelado o completado.');
    console.log(`${reqId} nothing active to cancel baseStatus=${base.status}`);
    return {
      success: false,
      complete: true,
      action: 'reminder_already_inactive',
      data: { cancelledCount: 0, recurring, targetId: base.id, content: base.content },
      rawSummary: message,
      formattedCard: message,
      confirmation: message,
    };
  }

  const childNotices = isAdvanceNotice(base)
    ? []
    : active.filter((row) => isAdvanceNotice(row) && primaryTargets.some((main) => belongsToMainReminder(row, main)));
  const targets = [...primaryTargets, ...childNotices];
  const ids = Array.from(new Set(targets.map((row) => row.id)));

  if (childNotices.length > 0) {
    console.log(`${reqId} linked advance notices=${childNotices.length} ids=${childNotices.map((row) => row.id).join(',')}`);
  }

  // IDs are selected from the owner-scoped read above. Preserve the original
  // write contract so cancellation mocks and the database adapter remain stable.
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
  const card = cancellationCard({ reminder: base, recurring, language });
  return {
    success: cancelledCount > 0,
    complete: cancelledCount === ids.length,
    partialSuccess: cancelledCount > 0 && cancelledCount !== ids.length,
    action: recurring ? 'cancelled_recurring_reminder_series' : 'cancelled_reminder',
    data: {
      cancelledCount,
      logicalCancelledCount: primaryTargets.length,
      linkedAdvanceNoticesCancelled: childNotices.length,
      recurring,
      recurrenceRule: base.recurrence_rule || null,
      content: isAdvanceNotice(base) ? (parseAdvanceNoticeContent(base.content)?.baseContent || base.content) : base.content,
    },
    rawSummary: card,
    formattedCard: card,
    confirmation: card,
  };
}

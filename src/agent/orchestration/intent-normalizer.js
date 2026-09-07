import { getWorkingMemory, resolveEntityReference } from '../core/working-memory.js';
import { parseOrdinalReference } from '../../shared/entity-resolution.js';
import { getLocalDateParts } from '../../shared/time.js';

function resolveWorkingItem(user, target, preferredType) {
  const reference = String(target || '').trim();
  if (!reference) return null;
  const resolved = resolveEntityReference({ userOrPhone: user, reference, preferredType });
  return resolved.status === 'RESOLVED' ? resolved.item : null;
}

function normalizePendingTarget(action, user) {
  if (action.domain !== 'pending') return action;
  const ordinal = parseOrdinalReference(String(action.target || ''));
  if (ordinal !== -1) return action;
  const count = getWorkingMemory(user)?.pendingClarifications?.length || 0;
  return count > 0 ? { ...action, target: String(count) } : action;
}

function normalizeCalendarYear(action, context) {
  if (action.domain !== 'agenda' || action.schedule?.kind !== 'calendar_date_time') return action;
  if (Number.isInteger(action.schedule.year)) return action;
  const parts = getLocalDateParts(context.referenceTime, context.timezone);
  return { ...action, schedule: { ...action.schedule, year: parts.year } };
}

/**
 * Calendar updates are patches. The model should describe only the changed
 * fields, while the executor/domain tool still needs a stable start/title for
 * the Google API. Reuse live Working Memory values rather than asking the
 * model to repeat unchanged data or accidentally renaming an ordinal target.
 */
function normalizeCalendarPatch(action, context) {
  if (action.domain !== 'calendar' || action.action !== 'update') return action;

  const item = resolveWorkingItem(context.user, action.target, 'calendar_event');
  const existingTitle = item?.summary || item?.title || item?.content || item?.raw?.summary || null;
  const normalized = { ...action };

  if (!normalized.title && !normalized.content) {
    normalized.title = existingTitle || (typeof action.target === 'string' ? action.target : undefined);
  }
  if (!normalized.schedule) {
    normalized.schedule = { kind: 'inherit_context' };
  }
  return normalized;
}

/**
 * Add only deterministic runtime context that Node already knows. This is not
 * a second intent classifier and never changes the semantic domain/action.
 */
export function normalizeTurnIntentForRuntime(intent, context) {
  if (!intent || !Array.isArray(intent.actions)) return intent;
  const actions = intent.actions.map((original) => {
    let action = { ...original };
    action = normalizePendingTarget(action, context.user);
    action = normalizeCalendarYear(action, context);
    action = normalizeCalendarPatch(action, context);
    return action;
  });
  return { ...intent, actions };
}

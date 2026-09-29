import { TOOL_NAMES } from '../contracts/tool-names.js';

/**
 * Resolves the Next Best Action (proactive steering) when a user completes a task or confirms a reminder.
 * Operates purely on authoritative backend state (dailyOverview) without relying on LLM hallucination
 * or breaking epistemic state authority.
 *
 * @param {Object} options
 * @param {Array} options.executionFacts - The verified facts produced in this turn.
 * @param {Object} [options.dailyOverview] - Live daily overview containing reminders and tasks.
 * @param {Object} [options.user] - Current user record including preferences.
 * @param {string} [options.language='es'] - Active turn language ('es' | 'en').
 * @param {Date} [options.referenceTime=new Date()] - Local reference time.
 * @param {string} [options.timezone='America/Bogota'] - User timezone.
 * @returns {{ type: string, recommendationText: string, item: Object|null }|null}
 */
export function resolveNextBestAction({
  executionFacts = [],
  dailyOverview = null,
  user = null,
  language = 'es',
  referenceTime = new Date(),
  timezone = 'America/Bogota',
} = {}) {
  const safeFacts = (executionFacts || []).filter(Boolean);
  if (safeFacts.length === 0 || !dailyOverview || typeof dailyOverview !== 'object') {
    return null;
  }

  // 1. Guard: Check for completion actions
  const completionFacts = safeFacts.filter((fact) => {
    if (!fact.success) return false;
    const action = String(fact.action || fact.requestedAction || '').toLowerCase();
    const isTaskComplete = fact.tool === TOOL_NAMES.MANAGE_TASK
      && ['complete', 'completed', 'completed_task'].includes(action);
    const isReminderAcknowledge = fact.tool === TOOL_NAMES.MANAGE_REMINDER
      && ['acknowledge', 'acknowledged', 'acknowledged_reminder'].includes(action);
    return isTaskComplete || isReminderAcknowledge;
  });

  if (completionFacts.length === 0) {
    return null;
  }

  // 2. Guard: Suppress when turn already contains inventory reads (agenda/task/reminder/calendar reads)
  const hasReadActions = safeFacts.some((fact) => {
    const action = String(fact.action || fact.requestedAction || '').toLowerCase();
    return action.includes('list')
      || action.includes('read')
      || action.includes('search')
      || action.includes('agenda')
      || action === 'next'
      || fact.tool === TOOL_NAMES.GET_UNIFIED_AGENDA;
  });

  if (hasReadActions) {
    return null;
  }

  // 3. Guard: Check user preferences
  const userPreferences = Array.isArray(user?.preferences) ? user.preferences : [];
  const hasAntiSuggestionPreference = userPreferences.some((pref) => {
    const content = String(pref?.content || '').toLowerCase();
    return /sin sugerencias|solo tareas|sin proactividad|no sugieras/i.test(content);
  });

  if (hasAntiSuggestionPreference) {
    return null;
  }

  // 4. Collect completed IDs and titles to exclude from recommendations
  const completedIds = new Set();
  const completedNames = new Set();
  for (const fact of completionFacts) {
    const data = fact.presentationData;
    if (data?.id) completedIds.add(String(data.id));
    if (Array.isArray(data)) {
      for (const item of data) {
        if (item?.id) completedIds.add(String(item.id));
        if (item?.title) completedNames.add(String(item.title).trim().toLowerCase());
        if (item?.content) completedNames.add(String(item.content).trim().toLowerCase());
      }
    }
    if (data?.title) completedNames.add(String(data.title).trim().toLowerCase());
    if (data?.content) completedNames.add(String(data.content).trim().toLowerCase());
    const target = fact.presentationParams?.target;
    if (target) completedNames.add(String(target).trim().toLowerCase());
  }

  const isCompleted = (item) => {
    if (!item) return true;
    if (item.id && completedIds.has(String(item.id))) return true;
    const name = String(item.title || item.content || '').trim().toLowerCase();
    if (name && completedNames.has(name)) return true;
    return item.status === 'completed' || item.status === 'cancelled';
  };

  const isEnglish = language === 'en';

  // Priority 1: Active unacknowledged follow-up reminders
  const pendingFollowups = (dailyOverview.pendingConfirmationReminders || []).filter((rem) => !isCompleted(rem));
  if (pendingFollowups.length > 0) {
    const next = pendingFollowups[0];
    const name = next.content || next.title || (isEnglish ? 'reminder' : 'recordatorio');
    const timeStr = next.localTime || next.localFormatted || '';
    const text = isEnglish
      ? `💡 *Next up*: You still have an active follow-up for *${name}*${timeStr ? ` (${timeStr})` : ''}.`
      : `💡 *Siguiente paso*: Todavía tenés pendiente confirmar el seguimiento de *${name}*${timeStr ? ` (${timeStr})` : ''}.`;
    return { type: 'followup', item: next, recommendationText: text };
  }

  // Priority 2: Upcoming timed reminders today
  const remainingReminders = (dailyOverview.timedRemindersToday || []).filter((rem) => !isCompleted(rem));
  if (remainingReminders.length > 0) {
    const next = remainingReminders[0];
    const name = next.title || next.content || (isEnglish ? 'Reminder' : 'Recordatorio');
    const timeStr = next.localTime || next.localFormatted || '';
    const text = isEnglish
      ? `💡 *Next up*: Your next reminder is *${name}*${timeStr ? ` at ${timeStr}` : ''}.`
      : `💡 *Siguiente paso*: Tu próximo recordatorio es *${name}*${timeStr ? ` a las ${timeStr}` : ''}.`;
    return { type: 'reminder', item: next, recommendationText: text };
  }

  // Priority 3: Tasks due today
  const remainingDueTasks = (dailyOverview.tasksDueToday || []).filter((task) => !isCompleted(task));
  if (remainingDueTasks.length > 0) {
    const next = remainingDueTasks[0];
    const entityInfo = next.entityName ? ` (📁 ${next.entityName})` : '';
    const text = isEnglish
      ? `💡 *Next up*: Your next task for today is *${next.title}*${entityInfo}.`
      : `💡 *Siguiente paso*: Tu próxima tarea para hoy es *${next.title}*${entityInfo}.`;
    return { type: 'task_due_today', item: next, recommendationText: text };
  }

  // Priority 4: Open tasks without date
  const remainingOpenTasks = (dailyOverview.openTasks || []).filter((task) => !isCompleted(task));
  if (remainingOpenTasks.length > 0) {
    const next = remainingOpenTasks[0];
    const entityInfo = next.entityName ? ` (📁 ${next.entityName})` : '';
    const text = isEnglish
      ? `💡 *Next up*: If you want to keep momentum, you have *${next.title}*${entityInfo}.`
      : `💡 *Siguiente paso*: Si querés seguir con ritmo, tenés pendiente *${next.title}*${entityInfo}.`;
    return { type: 'open_task', item: next, recommendationText: text };
  }

  // Priority 5: All caught up today
  const tomorrowItems = [
    ...(dailyOverview.tomorrowReminders || []),
    ...(dailyOverview.tomorrowTasks || []),
  ].filter((item) => !isCompleted(item));

  if (tomorrowItems.length > 0) {
    const first = tomorrowItems[0];
    const name = first.title || first.content || (isEnglish ? 'Item' : 'Compromiso');
    const timeStr = first.localTime ? (isEnglish ? ` at ${first.localTime}` : ` a las ${first.localTime}`) : '';
    const text = isEnglish
      ? `🎉 *All done for today!* Your next item tomorrow is *${name}*${timeStr}. Time to rest!`
      : `🎉 *¡Todo listo por hoy!* Tu primer compromiso de mañana es *${name}*${timeStr}. ¡A descansar!`;
    return { type: 'all_caught_up', item: first, recommendationText: text };
  }

  const text = isEnglish
    ? '🎉 *All caught up!* You have no more pending items on your agenda for today.'
    : '🎉 *¡Todo al día!* No tenés más compromisos pendientes en tu agenda por hoy.';
  return { type: 'all_caught_up', item: null, recommendationText: text };
}

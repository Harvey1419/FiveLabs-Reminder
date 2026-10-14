import type { ReminderDependencies, ReminderRow, OwnerInput, ReminderDate, OverviewItem } from './reminder-persistence-client.js';

export function createReminderOverview({ getClient, getNow, formatLocalDateTime, logger }: Pick<ReminderDependencies, 'getClient' | 'getNow' | 'formatLocalDateTime' | 'logger'>) {
  function isReminderAwaitingAcknowledgement(reminder: ReminderRow | null | undefined, referenceTime: ReminderDate | null = null) {
    const wasDispatched = Boolean(
      reminder?.sent_at
      || reminder?.last_nudged_at
      || reminder?.delivery_id,
    );
    if (!wasDispatched) return false;
    if (!reminder?.requires_confirmation) return false;
    if (reminder?.acknowledged_at) return false;
    if (!['sent', 'pending', 'processing'].includes(reminder?.status as string)) return false;

    const maxNudges = Number(reminder?.max_nudges) || 3;
    const nudgeCount = Number(reminder?.nudge_count) || 0;
    if (nudgeCount >= maxNudges) return false;

    if (referenceTime) {
      const lastNotificationAt = reminder?.last_nudged_at || reminder?.sent_at;
      if (lastNotificationAt) {
        const activityMs = new Date(lastNotificationAt).getTime();
        const currentMs = (referenceTime instanceof Date ? referenceTime : new Date(referenceTime)).getTime();
        if (Number.isFinite(activityMs) && Number.isFinite(currentMs)) {
          const elapsedHours = (currentMs - activityMs) / (1000 * 60 * 60);
          if (elapsedHours > 48) return false;
        }
      }
    }

    return true;
  }

  async function getDailyOverview({ userId, phoneNumber, timezone = 'America/Bogota' }: OwnerInput & { timezone?: string }) {
    if (!userId && !phoneNumber) {
      return {
        todayDate: '',
        tomorrowDate: '',
        doneToday: [],
        pendingToday: [],
        timedRemindersToday: [],
        tasksDueToday: [],
        openTasks: [],
        openTasksByEntity: {} as Record<string, OverviewItem[]>,
        openTasksGeneral: [],
        tomorrow: [],
        tomorrowReminders: [],
        tomorrowTasks: [],
        upcoming: [],
      };
    }

    let userRemindersQ = getClient().from('reminders').select('*').neq('status', 'cancelled');
    // Tasks have user ownership, not phone ownership. A phone-only request cannot read every user's tasks.
    let userTasksQ = userId
      ? getClient().from('tasks').select('*, entities:entity_id(id, name, category), projects:project_id(id, name, status)').neq('status', 'cancelled')
      : null;

    if (userId) {
      userRemindersQ = userRemindersQ.eq('user_id', userId);
      userTasksQ = userTasksQ!.eq('user_id', userId);
    } else if (phoneNumber) {
      userRemindersQ = userRemindersQ.eq('phone_number', phoneNumber);
    }

    const [{ data: allReminders }, { data: allTasks }] = await Promise.all([
      userRemindersQ.order('send_at', { ascending: true }),
      userTasksQ ? userTasksQ.order('created_at', { ascending: false }) : Promise.resolve({ data: [] }),
    ]);

    const reminders = allReminders || [];
    const tasks = allTasks || [];

    const formatItem = (item: ReminderRow, isDone = false): OverviewItem => {
      // For reminders: scheduled date is send_at
      // For tasks: scheduled date is due_date
      // For completed: date is acknowledged_at / completed_at / sent_at
      // NEVER fall back to created_at or updated_at for an item's date or time!
      const rawDate = isDone
        ? (item.acknowledged_at || item.completed_at || item.sent_at || null)
        : (item.send_at || item.due_date || null);

      const isTask = !item.send_at && (item.title !== undefined || item.due_date !== undefined);
      const entityName = item.entities?.name || item.projects?.name || null;
      const entityCategory = item.entities?.category || (item.projects?.id || item.project_id ? 'project' : null);

      if (!rawDate) {
        return {
          id: item.id,
          content: item.content || item.title,
          title: item.title || item.content,
          localDate: null,
          localTime: null,
          localFormatted: '(Sin fecha límite)',
          recurrenceRule: item.recurrence_rule || null,
          status: item.status,
          description: item.description || null,
          isTask,
          entityName,
          entityCategory,
        };
      }

      const dateObj = new Date(rawDate);
      const localFormatted = formatLocalDateTime(dateObj, timezone, 'es-CO');

      const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
      const localDateStr = formatter.format(dateObj);

      const timeFormatter = new Intl.DateTimeFormat('es-CO', { timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true });
      const localTimeStr = timeFormatter.format(dateObj);

      return {
        id: item.id,
        content: item.content || item.title,
        title: item.title || item.content,
        description: item.description || null,
        localDate: localDateStr,
        localTime: localTimeStr,
        localFormatted,
        recurrenceRule: item.recurrence_rule || null,
        status: item.status,
        isTask,
        entityName,
        entityCategory,
      };
    };

    const todayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const now = getNow();
    const todayStr = todayFormatter.format(now);

    const tomorrowObj = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const tomorrowStr = todayFormatter.format(tomorrowObj);

    const doneToday: OverviewItem[] = [];
    const pendingConfirmationReminders: OverviewItem[] = [];
    const timedRemindersToday: OverviewItem[] = [];
    const tasksDueToday: OverviewItem[] = [];
    const openTasks: OverviewItem[] = [];
    const tomorrowReminders: OverviewItem[] = [];
    const tomorrowTasks: OverviewItem[] = [];
    const upcoming: OverviewItem[] = [];

    for (const r of reminders) {
      // A scheduled future reminder is not yet an active follow-up. Recurring
      // reminders return to pending after dispatch, so persisted delivery truth
      // (sent_at/last_nudged_at/delivery_id) is the lifecycle boundary here.
      if (isReminderAwaitingAcknowledgement(r, now)) {
        const lastNotificationAt = r.last_nudged_at || r.sent_at || null;
        const formatted = formatItem({ ...r, send_at: lastNotificationAt }, false);
        formatted.nudgeCount = r.nudge_count || 0;
        formatted.maxNudges = r.max_nudges || 3;
        formatted.lastNotificationAt = lastNotificationAt;
        pendingConfirmationReminders.push(formatted);
      }

      if (r.acknowledged_at || (r.status === 'sent' && !r.requires_confirmation)) {
        const formatted = formatItem(r, true);
        if (formatted.localDate === todayStr || (!r.acknowledged_at && !r.sent_at)) {
          doneToday.push(formatted);
        }
      } else if (r.status === 'pending' || r.status === 'processing') {
        const formatted = formatItem(r);
        if (formatted.localDate === todayStr) {
          timedRemindersToday.push(formatted);
        } else if (formatted.localDate === tomorrowStr) {
          tomorrowReminders.push(formatted);
        } else if (formatted.localDate! > tomorrowStr) {
          upcoming.push(formatted);
        }
      }
    }

    for (const t of tasks) {
      if (t.status === 'completed') {
        const formatted = formatItem(t, true);
        if (formatted.localDate === todayStr) {
          doneToday.push(formatted);
        }
      } else if (t.status === 'pending') {
        const formatted = formatItem(t);
        if (formatted.localDate === todayStr) {
          tasksDueToday.push(formatted);
        } else if (!t.due_date) {
          openTasks.push(formatted);
        } else if (formatted.localDate === tomorrowStr) {
          tomorrowTasks.push(formatted);
        } else if (formatted.localDate! > tomorrowStr) {
          upcoming.push(formatted);
        }
      }
    }

    // Group open tasks by entity/project
    const openTasksByEntity: Record<string, OverviewItem[]> = {};
    const openTasksGeneral: OverviewItem[] = [];

    for (const task of openTasks) {
      const groupKey = task.entityName ? task.entityName.trim() : null;
      if (groupKey) {
        if (!openTasksByEntity[groupKey]) {
          openTasksByEntity[groupKey] = [];
        }
        openTasksByEntity[groupKey]!.push(task);
      } else {
        openTasksGeneral.push(task);
      }
    }

    // Group all pending tasks by entity/project (both dated and undated)
    const pendingTasksByEntity: Record<string, OverviewItem[]> = {};
    for (const t of tasks) {
      if (t.status === 'pending') {
        const formatted = formatItem(t);
        const groupKey = formatted.entityName ? formatted.entityName.trim() : null;
        if (groupKey) {
          if (!pendingTasksByEntity[groupKey]) {
            pendingTasksByEntity[groupKey] = [];
          }
          pendingTasksByEntity[groupKey]!.push(formatted);
        }
      }
    }

    const pendingToday = [...timedRemindersToday, ...tasksDueToday, ...openTasks];
    const tomorrow = [...tomorrowReminders, ...tomorrowTasks];
    pendingConfirmationReminders.sort((left, right) => (
      new Date(right.lastNotificationAt || 0).getTime()
      - new Date(left.lastNotificationAt || 0).getTime()
    ));

    return {
      todayDate: todayStr,
      tomorrowDate: tomorrowStr,
      doneToday,
      pendingConfirmationReminders,
      pendingToday,
      timedRemindersToday,
      tasksDueToday,
      openTasks,
      openTasksByEntity,
      pendingTasksByEntity,
      openTasksGeneral,
      tomorrow,
      tomorrowReminders,
      tomorrowTasks,
      upcoming,
    };
  }

  async function getRecentRemindersForPhone(phoneNumber: string | null | undefined, limit: unknown = 10) {
    if (!phoneNumber) return [];
    const safeLimit = Math.min(Math.max(1, Number(limit) || 10), 50);

    const { data, error } = await getClient()
      .from('reminders')
      .select('content, send_at, recurrence_rule, status, created_at, sent_at')
      .eq('phone_number', phoneNumber)
      .order('created_at', { ascending: false })
      .limit(safeLimit);

    if (error) {
      logger.error('getRecentRemindersForPhone failed:', error);
      return [];
    }
    return data || [];
  }

  return { isReminderAwaitingAcknowledgement, getDailyOverview, getRecentRemindersForPhone };
}

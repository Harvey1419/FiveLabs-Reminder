import { formatHumanFriendlyDateTime, DEFAULT_TIMEZONE } from '../../shared/time.js';
import { stripReminderPrefix } from '../../integrations/whatsapp/kapso-client.js';

/**
 * Executive WhatsApp Response Formatters.
 * Generates natural, deterministic, executive cards in the user's language.
 * Never generates interim "processing" messages.
 */

export function formatReminderCreatedCard(savedReminders, timezone = DEFAULT_TIMEZONE, language = 'es') {
  // Support both (savedReminders, language) and (savedReminders, timezone, language) signatures
  if (typeof timezone === 'string' && (timezone === 'es' || timezone === 'en' || timezone === 'pt')) {
    language = timezone;
    timezone = DEFAULT_TIMEZONE;
  }

  if (!Array.isArray(savedReminders) || savedReminders.length === 0) {
    return language === 'en'
      ? '✅ *Reminder scheduled successfully.*'
      : '✅ *Recordatorio programado con éxito.*';
  }

  if (savedReminders.length === 1) {
    const r = savedReminders[0];
    const timeDisplay = r.formattedTime || (r.sendAt ? formatHumanFriendlyDateTime(r.sendAt, timezone, language) : '');
    const header = language === 'en' ? '✅ *Scheduled Reminder*' : '✅ *Recordatorio programado*';
    let card = `${header}\n\n⏰ *${r.content || (language === 'en' ? 'Reminder' : 'Recordatorio')}*`;
    if (timeDisplay) {
      card += `\n📅 ${timeDisplay}`;
    }
    return card;
  }

  const header = language === 'en' ? '✅ *Scheduled Reminders*' : '✅ *Recordatorios programados*';
  const blocks = savedReminders.map(r => {
    const timeDisplay = r.formattedTime || (r.sendAt ? formatHumanFriendlyDateTime(r.sendAt, timezone, language) : '');
    const isNotice = r.isAdvanceNotice === true;
    const icon = isNotice ? '🔔' : '⏰';
    const rawContent = r.displayContent || r.content || (language === 'en' ? 'Reminder' : 'Recordatorio');
    const content = isNotice
      ? `${language === 'en' ? 'Advance notice' : 'Aviso previo'}: ${rawContent}`
      : rawContent;
    return [`${icon} *${content}*`, ...(timeDisplay ? [`📅 ${timeDisplay}`] : [])].join('\n');
  });

  return `${header}\n\n${blocks.join('\n\n')}`;
}

function formatCurrency(amount = 0, currency = 'COP', language = 'es') {
  if (currency === 'USD') {
    return `$${Number(amount).toLocaleString('en-US')}`;
  }

  return `$${Number(amount).toLocaleString(language === 'en' ? 'en-US' : 'es-CO')} ${currency}`;
}

export function formatReminderCreateOutcomeCard({
  created = [],
  rejected = [],
  proUpgrade = null,
} = {}, timezone = DEFAULT_TIMEZONE, language = 'es') {
  const sections = [];
  if (created.length > 0) {
    sections.push(formatReminderCreatedCard(created, timezone, language));
  }

  const proRejected = rejected.filter((item) => item.code === 'PRO_TIER_REQUIRED');
  const ordinaryRejected = rejected.filter((item) => item.code !== 'PRO_TIER_REQUIRED');

  if (ordinaryRejected.length > 0) {
    const header = created.length > 0
      ? (language === 'en' ? '⚠️ *Not scheduled*' : '⚠️ *No programado*')
      : (language === 'en' ? '⚠️ *I did not schedule this yet*' : '⚠️ *Aún no programé esto*');
    const lines = ordinaryRejected.map((item) => `• *${item.content || (language === 'en' ? 'Reminder' : 'Recordatorio')}*: ${item.reason}`);
    const questions = [...new Set(ordinaryRejected.map((item) => item.question).filter(Boolean))];
    sections.push([header, ...lines, ...questions].join('\n'));
  }

  if (proRejected.length > 0) {
    const header = language === 'en'
      ? '✨ *Don\'t let it slip your mind!*'
      : '✨ *¡Que no se te pase!*';
    const firstItem = proRejected[0];
    const firstContent = firstItem.content || (language === 'en' ? 'this reminder' : 'este recordatorio');
    const firstTiming = firstItem.sourceTimeText || firstItem.formattedTime || '';
    let intentLine;

    if (proRejected.length > 1) {
      const itemLines = proRejected.map((item) => {
        const content = item.content || (language === 'en' ? 'Reminder' : 'Recordatorio');
        const timing = item.sourceTimeText || item.formattedTime || '';
        return `• ⏰ *${content}*${timing ? ` — ${timing}` : ''}`;
      });
      intentLine = language === 'en'
        ? `I tried to set up these reminders, but they use Pro features:\n${itemLines.join('\n')}`
        : `Quise dejar listos estos recordatorios, pero usan funciones Pro:\n${itemLines.join('\n')}`;
    } else if (firstItem.proFeature === 'recurrence') {
      intentLine = language === 'en'
        ? `To repeat *${firstContent}* automatically${firstTiming ? ` (${firstTiming})` : ''}, you need Reminder Pro.`
        : `Para repetir *${firstContent}* automáticamente${firstTiming ? ` (${firstTiming})` : ''}, necesitas Reminder Pro.`;
    } else {
      intentLine = language === 'en'
        ? `To remind you about *${firstContent}*${firstTiming ? ` ${firstTiming}` : ' on a future day'}, you need Reminder Pro.`
        : `Para recordarte *${firstContent}*${firstTiming ? ` ${firstTiming}` : ' en un día futuro'}, necesitas Reminder Pro.`;
    }

    const freeLimit = language === 'en'
      ? 'With *Reminder Free* you can create reminders for today.'
      : 'Con *Reminder Free* puedes crear recordatorios para hoy.';
    const value = language === 'en'
      ? 'With *Reminder Pro* you can organize ahead:'
      : 'Con *Reminder Pro* puedes organizarte con anticipación:';
    const valuePoints = language === 'en'
      ? ['🗓️ Schedule reminders for any day', '🔁 Repeat them automatically', '🌟 Organize your routine with more flexibility']
      : ['🗓️ Programa recordatorios para cualquier día', '🔁 Repítelos automáticamente', '🌟 Organiza tu rutina con más flexibilidad'];
    const isStripe = Boolean(proUpgrade?.checkoutUrl?.includes('stripe.com') || proUpgrade?.fallbackCheckoutUrl?.includes('stripe.com'));
    const isLemon = Boolean(proUpgrade?.checkoutUrl?.includes('lemonsqueezy') || proUpgrade?.fallbackCheckoutUrl?.includes('lemonsqueezy'));
    const providerName = proUpgrade?.provider || (isStripe ? 'Stripe' : (isLemon ? 'Lemon Squeezy' : 'Mercado Pago'));
    const payment = proUpgrade?.checkoutUrl
      ? (language === 'en'
        ? `🔒 *Secure payment link with ${providerName}:*\n${proUpgrade.checkoutUrl}`
        : `🔒 *Enlace de pago seguro con ${providerName}:*\n${proUpgrade.checkoutUrl}`)
      : (language === 'en'
        ? `🔒 *Secure payment link:*\n${proUpgrade?.fallbackCheckoutUrl || 'https://www.mercadopago.com.co/subscriptions'}`
        : `🔒 *Enlace de pago seguro:*\n${proUpgrade?.fallbackCheckoutUrl || 'https://www.mercadopago.com.co/subscriptions'}`);
    const pricing = proUpgrade
      ? `${formatCurrency(proUpgrade.amount, proUpgrade.currency || 'COP', language)}${language === 'en' ? '/month' : '/mes'}`
      : (language === 'en' ? '$49,900 COP/month' : '$49.900 COP/mes');
    const priceLine = language === 'en'
      ? `💎 Activate Pro for *${pricing}*`
      : `💎 Activa Pro por *${pricing}*`;
    const actionLine = language === 'en'
      ? '👇 Tap *Pay now* to activate it and keep planning with me.'
      : '👇 Toca *Pagar ahora* para activarlo y seguir organizándote conmigo.';

    sections.push([
      header,
      '',
      intentLine,
      freeLimit,
      '',
      value,
      ...valuePoints,
      '',
      priceLine,
      payment,
      actionLine,
    ].join('\n'));
  }

  return sections.join('\n\n');
}

export function formatReminderListCard(reminders, timezone = DEFAULT_TIMEZONE, language = 'es') {
  if (!Array.isArray(reminders) || reminders.length === 0) {
    return language === 'en'
      ? '🔔 *Pending Reminders*\n\nYou currently have no pending reminders scheduled.'
      : '🔔 *Recordatorios pendientes*\n\nNo tienes recordatorios pendientes en este momento.';
  }

  const header = language === 'en'
    ? '🔔 *Your Pending Reminders*'
    : '🔔 *Tus recordatorios pendientes*';

  const lines = reminders.map(r => {
    let timeDisplay = '';
    if (r.send_at || r.sendAt) {
      const friendly = formatHumanFriendlyDateTime(r.send_at || r.sendAt, timezone, language);
      if (friendly) {
        timeDisplay = ` — ${friendly}`;
      }
    }
    const rec = (r.recurrence_rule || r.recurrenceRule) ? ' _(Recurrente)_' : '';
    const nudge = (r.requires_confirmation || r.requiresConfirmation) ? ' _(Requiere confirmación)_' : '';
    return `• ⏰ *${r.content || r.title || 'Recordatorio'}*${timeDisplay}${rec}${nudge}`;
  });

  return `${header}\n\n` + lines.join('\n');
}

export function formatReminderCreatedTodayCard(reminders, timezone = DEFAULT_TIMEZONE, language = 'es') {
  if (!Array.isArray(reminders) || reminders.length === 0) {
    return language === 'en'
      ? '📝 *Reminders created today*\n\nYou have not created any reminders today.'
      : '📝 *Recordatorios creados hoy*\n\nNo has creado recordatorios el día de hoy.';
  }

  const header = language === 'en'
    ? '📝 *Reminders created today:*'
    : '📝 *Recordatorios creados hoy:*';

  const lines = reminders.map(r => {
    let timeDisplay = '';
    const dateVal = r.send_at || r.sendAt;
    if (dateVal) {
      const friendly = formatHumanFriendlyDateTime(dateVal, timezone, language);
      if (friendly) timeDisplay = ` — Programado para: ${friendly}`;
    }
    const statusTag = r.acknowledged_at ? ' _(Completado)_' : '';
    return `• 📝 *${r.content || r.title || 'Recordatorio'}*${timeDisplay}${statusTag}`;
  });

  return `${header}\n\n` + lines.join('\n');
}

export function formatReminderCompletedTodayCard(reminders, timezone = DEFAULT_TIMEZONE, language = 'es') {
  if (!Array.isArray(reminders) || reminders.length === 0) {
    return language === 'en'
      ? '✅ *Reminders completed today*\n\nYou have not completed any reminders today.'
      : '✅ *Recordatorios completados hoy*\n\nNo tienes recordatorios completados el día de hoy.';
  }

  const header = language === 'en'
    ? '✅ *Recordatorios completados hoy:*'
    : '✅ *Recordatorios completados hoy:*';

  const lines = reminders.map(r => {
    let timeDisplay = '';
    const dateVal = r.acknowledged_at || r.acknowledgedAt;
    if (dateVal) {
      const friendly = formatHumanFriendlyDateTime(dateVal, timezone, language);
      if (friendly) timeDisplay = ` — ${friendly}`;
    }
    return `• ✅ *${r.content || r.title || 'Recordatorio'}*${timeDisplay}`;
  });

  return `${header}\n\n` + lines.join('\n');
}

export function formatReminderRemainingTodayCard(reminders, timezone = DEFAULT_TIMEZONE, language = 'es') {
  if (!Array.isArray(reminders) || reminders.length === 0) {
    return language === 'en'
      ? '⏳ *Remaining reminders for today*\n\nYou have no more reminders scheduled for the rest of today.'
      : '⏳ *Recordatorios que quedan para hoy*\n\nNo te quedan más recordatorios pendientes para el resto del día de hoy.';
  }

  const header = language === 'en'
    ? '⏳ *Recordatorios que quedan para hoy:*'
    : '⏳ *Recordatorios que quedan para hoy:*';

  const lines = reminders.map(r => {
    let timeDisplay = '';
    const dateVal = r.send_at || r.sendAt;
    if (dateVal) {
      const friendly = formatHumanFriendlyDateTime(dateVal, timezone, language);
      if (friendly) {
        timeDisplay = ` — ${friendly}`;
      }
    }
    const rec = (r.recurrence_rule || r.recurrenceRule) ? ' _(Recurrente)_' : '';
    const nudge = (r.requires_confirmation || r.requiresConfirmation) ? ' _(Requiere confirmación)_' : '';
    return `• ⏰ *${r.content || r.title || 'Recordatorio'}*${timeDisplay}${rec}${nudge}`;
  });

  return `${header}\n\n` + lines.join('\n');
}

export function formatReminderCancelledCard(cancelledCount, remainingCount, details = '', language = 'es') {
  if (language === 'en') {
    return `🗑️ *Reminder Cancelled*\n\nCancelled ${cancelledCount} reminder(s). ${remainingCount} remaining in your schedule.${details ? `\n\n${details}` : ''}`;
  }
  return `🗑️ *Recordatorio cancelado*\n\nSe eliminaron ${cancelledCount} recordatorio(s). Restan ${remainingCount} pendientes en tu agenda.${details ? `\n\n${details}` : ''}`;
}

export function formatReminderUpdatedCard(reminder, formattedTime, timezone = DEFAULT_TIMEZONE, language = 'es') {
  const header = language === 'en' ? '🔄 *Reminder updated*' : '🔄 *Recordatorio actualizado*';
  let card = `${header}\n\n⏰ *${reminder.content || (language === 'en' ? 'Reminder' : 'Recordatorio')}*`;
  const timeDisplay = formattedTime || (reminder.send_at ? formatHumanFriendlyDateTime(reminder.send_at, timezone, language) : '');
  if (timeDisplay) {
    card += `\n📅 ${timeDisplay}`;
  }
  return card;
}

export function formatReminderAcknowledgedCard(reminderOrCount, language = 'es') {
  if (typeof reminderOrCount === 'number') {
    if (reminderOrCount <= 0) {
      return language === 'en'
        ? 'There were no pending reminders to acknowledge.'
        : 'No había recordatorios pendientes por confirmar.';
    }
    return language === 'en'
      ? `¡Ready! ✅ Completed ${reminderOrCount} reminder(s) and stopped follow-up nudges.`
      : `¡Listo! ✅ Recordatorio completado y desactivados los avisos pendientes.`;
  }

  const rawContent = reminderOrCount?.content || reminderOrCount?.title || '';
  const content = stripReminderPrefix(String(rawContent))
    .replace(/^(?:Recordatorio\s*(?:diario)?:\s*|🔔\s*Recordatorio\s*pendiente:\s*)/i, '')
    .trim();

  if (language === 'en') {
    return `✅ *Reminder Confirmed*\n\n🔔 *${content || 'Task completed'}*\nMarked as completed and notifications deactivated.`;
  }
  return `✅ *Recordatorio confirmado*\n\n🔔 *${content || 'Completado'}*\nQueda registrado y se desactivan los avisos pendientes.`;
}

export function formatTaskCreatedCard(savedTasks, language = 'es') {
  if (!Array.isArray(savedTasks) || savedTasks.length === 0) {
    return language === 'en' ? '✅ *Task created*' : '✅ *Tarea creada*';
  }

  const entName = savedTasks[0]?.entityName;
  if (savedTasks.length === 1) {
    const t = savedTasks[0];
    if (entName) {
      return language === 'en'
        ? `Done ✅ I added *${t.title}* to *${entName}*.`
        : `Listo ✅ Añadí *${t.title}* a *${entName}*.`;
    }
    return language === 'en'
      ? `Done ✅ I created the task *${t.title}*.`
      : `Listo ✅ Registré la tarea *${t.title}*.`;
  }

  const titleHeader = entName
    ? (language === 'en' ? `✅ *Tasks added*\n\n📂 *Project: ${entName}*` : `✅ *Tareas añadidas*\n\n📂 *Proyecto: ${entName}*`)
    : (language === 'en' ? `✅ *Tasks created*` : `✅ *Tareas creadas*`);

  return `${titleHeader}\n\n` + savedTasks.map(t => `• ${t.title}`).join('\n');
}

export function formatTaskListCard(tasks, projectName = null, language = 'es') {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    if (projectName) {
      return language === 'en'
        ? `📋 *Pending in ${projectName}*\n\nThere are no pending tasks in this project.`
        : `📋 *Pendientes de ${projectName}*\n\nNo hay tareas pendientes en este proyecto.`;
    }
    return language === 'en'
      ? `📂 *Pending Tasks*\n\nYou currently have no pending tasks in your schedule.`
      : `📂 *Tareas pendientes*\n\nActualmente no tienes tareas pendientes registradas en tu agenda.`;
  }

  if (projectName) {
    const header = language === 'en' ? `📋 *Pending in ${projectName}*` : `📋 *Pendientes de ${projectName}*`;
    return `${header}\n\n` + tasks.map(t => `• ${t.title || t.content}`).join('\n');
  }

  const byEntity = {};
  const general = [];
  for (const t of tasks) {
    const ent = t.entities?.name || t.entityName || null;
    if (ent) {
      if (!byEntity[ent]) byEntity[ent] = [];
      byEntity[ent].push(t);
    } else {
      general.push(t);
    }
  }

  let formatted = language === 'en'
    ? `📋 *Your pending tasks*\n\n`
    : `📋 *Tus tareas pendientes*\n\n`;

  for (const [entName, entTasks] of Object.entries(byEntity)) {
    formatted += `📁 *${entName}*:\n` + entTasks.map(t => `• ${t.title || t.content}`).join('\n') + `\n\n`;
  }
  if (general.length > 0) {
    const genHeader = language === 'en' ? '📌 *General Tasks*:' : '📌 *Tareas generales*:';
    formatted += `${genHeader}\n` + general.map(t => `• ${t.title || t.content}`).join('\n') + `\n\n`;
  }

  return formatted.trim();
}

export function formatEntityListCard(entities, category = null, language = 'es') {
  const safeEntities = Array.isArray(entities) ? entities : [];
  const isProjectList = category === 'project';

  if (safeEntities.length === 0) {
    if (language === 'en') {
      return isProjectList
        ? '📁 *Projects*\n\nYou have no registered projects.'
        : '🗂️ *Registered entities*\n\nYou have no registered entities.';
    }
    return isProjectList
      ? '📁 *Proyectos*\n\nNo tienes proyectos registrados.'
      : '🗂️ *Entidades registradas*\n\nNo tienes entidades registradas.';
  }

  const categoryLabels = language === 'en'
    ? { person: 'person', company: 'company', project: 'project', place: 'place', pet: 'pet', asset: 'asset', other: 'other' }
    : { person: 'persona', company: 'empresa', project: 'proyecto', place: 'lugar', pet: 'mascota', asset: 'activo', other: 'otro' };
  const header = language === 'en'
    ? (isProjectList ? '📁 *Your projects*' : '🗂️ *Your registered entities*')
    : (isProjectList ? '📁 *Tus proyectos*' : '🗂️ *Tus entidades registradas*');
  const lines = safeEntities.map((entity) => {
    const name = entity?.name || (language === 'en' ? 'Unnamed' : 'Sin nombre');
    if (isProjectList) return `• *${name}*`;
    const label = categoryLabels[entity?.category] || categoryLabels.other;
    return `• *${name}* — ${label}`;
  });

  return `${header}\n\n${lines.join('\n')}`;
}

export function formatTaskCompletedCard(taskOrCount, language = 'es') {
  if (typeof taskOrCount === 'number' || (typeof taskOrCount === 'object' && taskOrCount !== null && taskOrCount.completedCount !== undefined)) {
    const count = typeof taskOrCount === 'number' ? taskOrCount : (taskOrCount.completedCount || 0);
    const entName = typeof taskOrCount === 'object' ? taskOrCount.entityName : null;

    if (count <= 0) {
      if (entName) {
        return language === 'en'
          ? `📁 *${entName}*\n\nThere were no pending tasks to complete.`
          : `📁 *${entName}*\n\nNo había tareas pendientes por completar en esta lista.`;
      }
      return language === 'en'
        ? 'No pending tasks found to mark as completed.'
        : 'No se encontraron tareas pendientes para completar.';
    }

    if (entName) {
      return language === 'en'
        ? `Done ✅ List completed: *${entName}* (${count} task${count === 1 ? '' : 's'}).`
        : `Listo ✅ Lista completada: *${entName}* (${count} ${count === 1 ? 'tarea' : 'tareas'}).`;
    }

    return language === 'en'
      ? `✅ *Task(s) Completed*\n\nMarked ${count} task(s) as done.`
      : `✅ *Tarea(s) completada(s)*\n\nSe marcaron ${count} tarea(s) como realizada(s).`;
  }

  const title = taskOrCount?.title || taskOrCount?.content || 'Tarea';
  const entName = taskOrCount?.entities?.name || taskOrCount?.entityName || null;
  const projectTag = entName ? `\n📂 *Proyecto:* ${entName}` : '';

  if (language === 'en') {
    return `✅ *Task completed*\n\n*${title}*${projectTag}`;
  }
  return `✅ *Tarea completada*\n\n*${title}*${projectTag}`;
}

export function formatEntityDeletedCard({
  deletedCount = 0,
  entities = [],
  deletedTaskCount = 0,
  cancelledReminderCount = 0,
  preservedCompletedTaskCount = 0,
  reminderCleanupError = null,
  taskCleanupError = null,
}, language = 'es') {
  const names = (entities || []).map((entity) => entity.name).filter(Boolean);
  const header = language === 'en'
    ? `🗑️ *${deletedCount === 1 ? 'Project deleted' : 'Projects deleted'}*`
    : `🗑️ *${deletedCount === 1 ? 'Proyecto eliminado' : 'Proyectos eliminados'}*`;
  const lines = names.map((name) => `• ${name}`);
  const taskNote = deletedTaskCount > 0
    ? (language === 'en'
      ? `\n\n🗑️ ${deletedTaskCount} unfinished task${deletedTaskCount === 1 ? ' was' : 's were'} also deleted.`
      : `\n\n🗑️ También se ${deletedTaskCount === 1 ? 'eliminó' : 'eliminaron'} ${deletedTaskCount} ${deletedTaskCount === 1 ? 'tarea pendiente asociada' : 'tareas pendientes asociadas'}.`)
    : '';
  const historyNote = preservedCompletedTaskCount > 0
    ? (language === 'en'
      ? `\n\n📚 ${preservedCompletedTaskCount} completed task${preservedCompletedTaskCount === 1 ? ' remains' : 's remain'} in history.`
      : `\n\n📚 ${preservedCompletedTaskCount} ${preservedCompletedTaskCount === 1 ? 'tarea completada permanece' : 'tareas completadas permanecen'} en el historial.`)
    : '';
  const reminderNote = cancelledReminderCount > 0
    ? (language === 'en'
      ? `\n\n🔕 ${cancelledReminderCount} related reminder${cancelledReminderCount === 1 ? ' was' : 's were'} cancelled.`
      : `\n\n🔕 Se ${cancelledReminderCount === 1 ? 'canceló' : 'cancelaron'} ${cancelledReminderCount} ${cancelledReminderCount === 1 ? 'recordatorio relacionado' : 'recordatorios relacionados'}.`)
    : '';
  const cleanupWarning = reminderCleanupError || taskCleanupError
    ? (language === 'en'
      ? '\n\n⚠️ The projects were deleted, but their active work could not be cleaned up completely.'
      : '\n\n⚠️ Los proyectos se eliminaron, pero su trabajo activo no pudo limpiarse por completo.')
    : '';
  return `${header}${lines.length > 0 ? `\n\n${lines.join('\n')}` : ''}${taskNote}${reminderNote}${historyNote}${cleanupWarning}`;
}

export function formatTaskUpdatedCard(task, language = 'es') {
  let card = language === 'en'
    ? `Done ✅ Task updated: *${task.title || 'Task'}*.`
    : `Listo ✅ Tarea actualizada: *${task.title || 'Tarea'}*.`;
  if (task.dueDate || task.due_date) {
    card += `\n📅 ${task.dueDate || task.due_date}`;
  }
  if (task.priority && task.priority !== 'medium') {
    card += `\n⚡ Prioridad: ${task.priority}`;
  }
  return card;
}

export function formatMemoryListCard(memories, language = 'es') {
  if (!Array.isArray(memories) || memories.length === 0) {
    return language === 'en'
      ? `🧠 *Assistant Memory*\n\nI currently have no stored facts or preferences about you. As we chat I will remember your projects and preferences.`
      : `🧠 *Memoria del Asistente*\n\nActualmente no tengo recuerdos o preferencias guardadas sobre ti. A medida que hablemos iré recordando tus proyectos y contexto importante.`;
  }

  const header = language === 'en'
    ? `🧠 *What I know and remember about you:*\n\n`
    : `🧠 *Lo que sé y recuerdo sobre ti:*\n\n`;

  const footer = language === 'en'
    ? `\n\n💡 _You can ask me to add details or correct any information anytime._`
    : `\n\n💡 _Puedes pedirme agregar más detalles o corregir cualquier dato cuando quieras._`;

  return header + memories.slice(0, 10).map(m => {
    const cat = m.category ? m.category.charAt(0).toUpperCase() + m.category.slice(1) : 'Dato';
    return `• *${cat}:* ${m.content}`;
  }).join('\n\n') + footer;
}

export function formatErrorCard(errorCode, userMessage, language = 'es') {
  const isTechnical = typeof userMessage === 'string' && (
    /violates .* constraint|check constraint|relation .* does not exist|syntax error|column .* does not exist|duplicate key|foreign key|null value in column/i.test(userMessage)
  );

  const cleanMessage = isTechnical
    ? (language === 'en' ? 'An unexpected error occurred while processing your request. Please try again.' : 'Ocurrió un inconveniente al guardar los datos. Por favor intenta nuevamente.')
    : (userMessage || (language === 'en' ? 'An error occurred while processing your request.' : 'Ocurrió un inconveniente al procesar tu solicitud.'));

  return `⚠️ ${cleanMessage}`;
}

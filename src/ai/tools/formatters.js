/**
 * Executive WhatsApp Response Formatters.
 * Generates natural, deterministic, executive cards in the user's language.
 * Never generates interim "processing" messages.
 */

export function formatReminderCreatedCard(savedReminders, language = 'es') {
  if (!Array.isArray(savedReminders) || savedReminders.length === 0) {
    return language === 'en'
      ? '✅ *Reminder scheduled successfully.*'
      : '✅ *Recordatorio programado con éxito.*';
  }

  if (savedReminders.length === 1) {
    const r = savedReminders[0];
    const timeDisplay = r.formattedTime || r.sendAt || '';
    const header = language === 'en' ? '✅ *Scheduled Reminder*' : '✅ *Recordatorio programado*';
    let card = `${header}\n\n⏰ *${r.content || 'Recordatorio'}*`;
    if (timeDisplay) {
      card += `\n📅 ${timeDisplay}`;
    }
    return card;
  }

  // Multiple reminders (e.g. advance notice + main meeting)
  const header = language === 'en' ? '✅ *Scheduled Reminders*' : '✅ *Recordatorios programados*';
  const lines = savedReminders.map(r => {
    const timeDisplay = r.formattedTime || r.sendAt || '';
    const isNotice = /\b(aviso\s+previo|advance\s+notice)\b/i.test(r.content || '');
    const icon = isNotice ? '🔔' : '⏰';
    return `${icon} *${r.content}* — ${timeDisplay}`;
  });

  return `${header}\n\n` + lines.join('\n');
}

export function formatReminderListCard(reminders, timezone = 'America/Bogota', language = 'es') {
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
      try {
        const dateObj = new Date(r.send_at || r.sendAt);
        const timeFormatter = new Intl.DateTimeFormat('es-CO', {
          timeZone: timezone,
          day: 'numeric',
          month: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        });
        timeDisplay = ` — ${timeFormatter.format(dateObj)}`;
      } catch {
        timeDisplay = '';
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

export function formatReminderUpdatedCard(reminder, formattedTime, language = 'es') {
  const header = language === 'en' ? '🔄 *Reminder updated*' : '🔄 *Recordatorio actualizado*';
  let card = `${header}\n\n⏰ *${reminder.content || 'Recordatorio'}*`;
  if (formattedTime) {
    card += `\n📅 ${formattedTime}`;
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

  const content = reminderOrCount?.content
    ? String(reminderOrCount.content).replace(/^(?:Recordatorio\s*(?:diario)?:\s*|🔔\s*Recordatorio\s*pendiente:\s*)/i, '').trim()
    : '';

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
        ? `✅ *Task added*\n\n📂 *Project: ${entName}*\n• ${t.title}`
        : `✅ *Tarea añadida*\n\n📂 *Proyecto: ${entName}*\n• ${t.title}`;
    }
    return language === 'en'
      ? `✅ *Task created*\n\n• ${t.title}`
      : `✅ *Tarea registrada*\n\n• ${t.title}`;
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
        ? `📁 *${projectName}*\n\nNo pending tasks in this project.`
        : `📁 *${projectName}*\n\nNo hay tareas pendientes en este proyecto.`;
    }
    return language === 'en'
      ? `📂 *Pending Tasks*\n\nYou currently have no pending tasks in your schedule.`
      : `📂 *Tareas pendientes*\n\nActualmente no tienes tareas pendientes registradas en tu agenda.`;
  }

  if (projectName) {
    const header = language === 'en' ? `📁 *Tasks in ${projectName}*` : `📁 *Tareas en ${projectName}*`;
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
    ? `📂 *Your Projects & Pending Tasks* 📋\n\n`
    : `📂 *Tus proyectos y tareas pendientes* 📋\n\n`;

  for (const [entName, entTasks] of Object.entries(byEntity)) {
    formatted += `📁 *${entName}*:\n` + entTasks.map(t => `• ${t.title || t.content}`).join('\n') + `\n\n`;
  }
  if (general.length > 0) {
    const genHeader = language === 'en' ? '📌 *General Tasks*:' : '📌 *Tareas generales*:';
    formatted += `${genHeader}\n` + general.map(t => `• ${t.title || t.content}`).join('\n') + `\n\n`;
  }

  return formatted.trim();
}

export function formatTaskCompletedCard(completedCount, language = 'es') {
  if (completedCount <= 0) {
    return language === 'en'
      ? 'No pending tasks found to mark as completed.'
      : 'No se encontraron tareas pendientes para completar.';
  }
  return language === 'en'
    ? `✅ *Task(s) Completed*\n\nMarked ${completedCount} task(s) as done.`
    : `✅ *Tarea(s) completada(s)*\n\nSe marcaron ${completedCount} tarea(s) como realizada(s).`;
}

export function formatTaskUpdatedCard(task, language = 'es') {
  const header = language === 'en' ? '🔄 *Task updated*' : '🔄 *Tarea actualizada*';
  let card = `${header}\n\n• *${task.title || 'Tarea'}*`;
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
  return `⚠️ ${userMessage || (language === 'en' ? 'An error occurred while processing your request.' : 'Ocurrió un inconveniente al procesar tu solicitud.')}`;
}

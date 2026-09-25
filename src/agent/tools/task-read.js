import { getTaskList } from '../../features/tasks/service.js';

/** Task collection reads return structured truth; presentation happens later. */
export async function executeTaskReadTool({ params = {}, user = null, language = 'es' }) {
  const timezone = user?.timezone || 'America/Bogota';
  const locale = user?.locale || (language === 'en' ? 'en-US' : 'es-CO');

  try {
    const data = await getTaskList({
      userId: user?.id || null,
      timezone,
      locale,
      language,
      status: params.status || 'pending',
      scope: params.scope || 'all_pending',
      entityId: params.entityId || null,
      entityName: params.entityName || null,
      limit: params.limit || 50,
    });

    if (data.ambiguous) {
      const names = (data.candidates || []).slice(0, 5).map((entity) => entity.name).join(', ');
      const question = language === 'en'
        ? `Which project did you mean: ${names}?`
        : `¿A cuál proyecto te refieres: ${names}?`;
      return {
        success: false,
        action: 'ambiguous_entity',
        errorCode: 'AMBIGUOUS_TARGET',
        error: question,
        rawSummary: question,
        confirmation: `⚠️ ${question}`,
        requiresClarification: true,
      };
    }

    const enableFlow = process.env.ENABLE_WHATSAPP_FLOWS === 'true';
    const flowId = enableFlow ? (process.env.KAPSO_TASK_COMPLETION_FLOW_ID || '1599560168243520') : null;
    let flow = null;
    if (flowId && Array.isArray(data.tasks) && data.tasks.length > 0) {
      const flowTasks = data.tasks.slice(0, 20).map((task, idx) => {
        const title = String(task.title || task.content || (language === 'en' ? 'Untitled task' : 'Tarea sin título')).trim();
        const shortTitle = title.length > 27 ? `${title.slice(0, 24)}...` : title;
        const notes = String(task.description || task.notes || '').trim();
        return {
          id: String(task.id),
          title: `${idx + 1}. ${shortTitle}`,
          description: notes ? `📝 ${notes.slice(0, 60)}` : '',
        };
      });

      flow = {
        flowId,
        buttonText: language === 'en' ? 'Complete tasks' : 'Completar tareas',
        flowToken: `task_flow_${Date.now()}`,
        flowAction: 'navigate',
        screen: 'TASK_SELECTION',
        mode: process.env.KAPSO_FLOW_MODE || 'draft',
        data: {
          tasks: flowTasks,
        },
      };
    }

    let list = null;
    if (!flow && Array.isArray(data.tasks) && data.tasks.length > 0) {
      const taskRows = data.tasks.slice(0, 10).map((task) => {
        const title = String(task.title || task.content || (language === 'en' ? 'Task' : 'Tarea')).trim();
        const shortTitle = title.length > 24 ? `${title.slice(0, 21)}...` : title;
        const notes = String(task.description || task.notes || '').trim();
        return {
          id: `task:done:${task.id}`.slice(0, 200),
          title: shortTitle.slice(0, 24),
          ...(notes ? { description: notes.slice(0, 72) } : {}),
        };
      });

      list = {
        buttonText: (language === 'en' ? 'Manage tasks' : 'Gestionar tareas').slice(0, 20),
        headerText: (language === 'en' ? '📋 Pending tasks' : '📋 Tareas pendientes').slice(0, 60),
        sections: [
          {
            title: (language === 'en' ? 'Select to complete' : 'Toca para completar').slice(0, 24),
            rows: taskRows,
          },
        ],
      };
    }

    return {
      success: true,
      action: 'listed_tasks',
      data,
      flow,
      list,
      rawSummary: language === 'en' ? 'Tasks loaded.' : 'Tareas consultadas.',
    };
  } catch (error) {
    console.error('[taskReadTool] Error reading tasks:', error.message);
    return {
      success: false,
      action: 'task_read_error',
      errorCode: 'DATABASE_ERROR',
      error: language === 'en' ? 'I could not read your tasks.' : 'No pude consultar tus tareas.',
      rawSummary: language === 'en' ? 'I could not read your tasks.' : 'No pude consultar tus tareas.',
    };
  }
}

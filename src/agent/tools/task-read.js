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

    return {
      success: true,
      action: 'listed_tasks',
      data,
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

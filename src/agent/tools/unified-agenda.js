import { getUnifiedAgenda } from '../../features/agenda/service.js';

/**
 * Execute unified agenda tool.
 * Reads Calendar, Reminders, and Tasks simultaneously in a pure read-only aggregation.
 *
 * @param {object} params
 * @param {string} [params.action='get_agenda']
 * @param {object} [params.params={}]
 * @param {object} [params.user]
 * @param {string} [params.language='es']
 * @returns {Promise<object>}
 */
export async function executeUnifiedAgendaTool({
  action = 'get_agenda',
  params = {},
  user = null,
  language = 'es',
}) {
  const userId = user?.id || null;
  const phoneNumber = user?.phone_number || null;
  const timezone = user?.timezone || 'America/Bogota';
  const scope = params.scope || 'tomorrow';

  try {
    const agenda = await getUnifiedAgenda({
      userId,
      phoneNumber,
      timezone,
      scope,
      date: params.date || null,
      dateFrom: params.dateFrom || null,
      dateTo: params.dateTo || null,
      query: params.query || null,
      language,
    });

    return {
      success: true,
      action: 'unified_agenda_listed',
      data: agenda,
      rawSummary: agenda.formattedCard,
      formattedCard: agenda.formattedCard,
      confirmation: agenda.formattedCard,
    };
  } catch (err) {
    console.error('[unifiedAgendaTools] Error executing unified agenda:', err);
    return {
      success: false,
      action: 'unified_agenda_error',
      errorCode: 'UNIFIED_AGENDA_ERROR',
      error: 'Error al consultar la agenda unificada.',
      rawSummary: 'Error al consultar la agenda unificada.',
      confirmation: '⚠️ Ocurrió un error al consultar tu agenda.',
    };
  }
}

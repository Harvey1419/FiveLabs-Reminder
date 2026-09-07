import { getUnifiedAgenda } from '../../features/agenda/service.js';
import { formatAgendaWhatsAppCard } from '../../features/agenda/presentation.js';
import { getGoogleConnectUrl } from '../../integrations/google/auth.js';

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
  // A generic agenda read means "what is pending/current". Temporal requests
  // compiled by Hermes pass an explicit scope (today, tomorrow, week, etc.).
  const scope = params.scope || 'all_pending';

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

    const formattedCard = formatAgendaWhatsAppCard({ ...agenda, timezone }, language);
    const needsGoogleAuth = ['AUTH_REQUIRED', 'DISCONNECTED'].includes(agenda.calendar?.state);
    const authUrl = needsGoogleAuth && userId
      ? getGoogleConnectUrl({ userId, phoneNumber })
      : null;

    return {
      success: true,
      action: 'unified_agenda_listed',
      data: { ...agenda, formattedCard },
      ctaUrl: authUrl,
      ctaHeader: authUrl ? '📅 Google Calendar' : null,
      ctaButtonText: authUrl ? (language === 'en' ? 'Connect' : 'Conectar') : null,
      rawSummary: formattedCard,
      formattedCard,
      confirmation: formattedCard,
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

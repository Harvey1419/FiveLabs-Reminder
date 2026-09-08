import { getUnifiedAgenda } from '../../features/agenda/service.js';
import { getGoogleConnectUrl } from '../../integrations/google/auth.js';

/**
 * Unified Agenda is a read-only domain boundary. It returns structured truth;
 * the shared presentation layer owns the final WhatsApp card.
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
  const locale = user?.locale || (language === 'en' ? 'en-US' : 'es-CO');
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

    const needsGoogleAuth = ['AUTH_REQUIRED', 'DISCONNECTED'].includes(agenda.calendar?.state);
    const authUrl = needsGoogleAuth && userId
      ? getGoogleConnectUrl({ userId, phoneNumber })
      : null;

    return {
      success: true,
      action: 'unified_agenda_listed',
      data: { ...agenda, timezone, locale },
      ctaUrl: authUrl,
      // The canonical body owns the visible title. Do not add a second header
      // above it just because the response includes a Google connect CTA.
      ctaHeader: null,
      ctaButtonText: authUrl ? (language === 'en' ? 'Connect' : 'Conectar') : null,
      rawSummary: language === 'en' ? 'Agenda loaded.' : 'Agenda consultada.',
    };
  } catch (err) {
    console.error('[unifiedAgendaTools] Error executing unified agenda:', err);
    return {
      success: false,
      action: 'unified_agenda_error',
      errorCode: 'UNIFIED_AGENDA_ERROR',
      error: language === 'en' ? 'I could not read your agenda.' : 'Error al consultar la agenda unificada.',
      rawSummary: language === 'en' ? 'I could not read your agenda.' : 'Error al consultar la agenda unificada.',
      confirmation: language === 'en' ? '⚠️ I could not read your agenda.' : '⚠️ Ocurrió un error al consultar tu agenda.',
    };
  }
}

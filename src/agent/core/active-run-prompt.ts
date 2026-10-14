import type { JsonObject } from '@templelabs/contracts';
import type { LegacyPreparedAction } from './active-run-executor.js';

export interface ActiveRunPromptInput {
  readonly id: string;
  readonly status: string;
  readonly kind: string;
  readonly waiting_for?: JsonObject | null;
  readonly context?: JsonObject;
  readonly preparedActions?: readonly Pick<LegacyPreparedAction, 'call_id' | 'domain' | 'action' | 'payload' | 'target_name' | 'target_id'>[];
}


/**
 * Format prompt context describing the active run.
 */
export function formatActiveRunPrompt(activeRun: ActiveRunPromptInput | null | undefined, continuationFieldKeys: readonly string[]): string {
  if (!activeRun) return '';
  const lines = [];

  if (activeRun.status === 'waiting_for_approval') {
    lines.push('[OPERACIÓN SUSPENDIDA ESPERANDO APROBACIÓN]');
    lines.push(`runId=${activeRun.id} | kind=${activeRun.kind}`);
    if (activeRun.waiting_for?.question) {
      lines.push(`Pregunta previa al usuario: "${activeRun.waiting_for.question}"`);
    }
    lines.push('Acciones preparadas:');
    for (const a of activeRun.preparedActions || []) {
      lines.push(` - ${a.call_id}: [${a.domain}.${a.action}] ${a.target_name || ''} (ID: ${a.target_id || 'n/a'})`);
    }
    lines.push('Instrucción: Si corrige o reemplaza la solicitud, responde relation="supersede"; nunca apruebes el contenido anterior. Si el usuario aprueba todo, responde con relation="approval" y decision="approve_all". Si aprueba solo algunos, decision="approve_subset" con los selectedCallIds exactos. Si rechaza o cancela, relation="cancel". Si habla de otro tema no relacionado, relation="unrelated". No afirmes ejecución en reply: Node renderiza hechos observados.');
  } else if (activeRun.status === 'waiting_for_input') {
    lines.push('[OPERACIÓN SUSPENDIDA ESPERANDO DATOS FALTANTES]');
    lines.push(`runId=${activeRun.id} | kind=${activeRun.kind}`);
    if (activeRun.waiting_for?.question) {
      lines.push(`Pregunta previa al usuario: "${activeRun.waiting_for.question}"`);
    }
    const fields = activeRun.waiting_for?.fields;
    if (Array.isArray(fields) && fields.length) {
      lines.push(`Campos faltantes: ${fields.join(', ')}`);
    }
    const drafts = (activeRun.preparedActions || []).map((action) => {
      return {
        ...(action.payload || {}),
        callId: action.call_id,
        domain: action.domain,
        action: action.action,
      };
    });
    if (drafts.length > 0) lines.push(`Borrador completo: ${JSON.stringify(drafts)}`);
    const fieldKeys = continuationFieldKeys;
    lines.push(`Formato estricto de cada actionInputs[].fields: ${JSON.stringify(Object.fromEntries(fieldKeys.map(key => [key, null])))}. Incluye TODAS estas claves; sustituye null solo por cambios explícitos. Null no borra campos; para borrar usa clearFields. Los objetos schedule también incluyen todas sus claves con null cuando no aplican.`);
    if (activeRun.context?.referenceTime) lines.push(`Ancla original: ${activeRun.context.referenceTime} | zona horaria: ${activeRun.context.timezone || 'n/a'}`);
    lines.push('Instrucción: Reanuda solo si el mensaje actual aporta datos faltantes al borrador existente; responde relation="resume" y actionInputs con el callId exacto y fields para cada delta; diferentes horarios requieren entradas distintas. Usa únicamente actionInputs; para un valor compartido repítelo en cada callId afectado. Incluye tanto datos faltantes como correcciones explícitas del mensaje actual. Si el usuario cambia de tema, relation="unrelated". Si cancela, relation="cancel". Si el usuario reemplaza explícitamente toda la solicitud, responde relation="supersede"; Node volverá a interpretar el mensaje actual por el flujo canónico completo y no mezclará el borrador anterior.');
  }

  if (activeRun.status === 'waiting_for_approval') {
    lines.push(`Borrador completo: ${JSON.stringify(activeRun.preparedActions || [])}`);
    if (activeRun.context?.referenceTime) lines.push(`Ancla original: ${activeRun.context.referenceTime} | zona horaria: ${activeRun.context.timezone || 'n/a'}`);
  }
  lines.push('FORMATO DE ESTA RESPUESTA: usa únicamente el JSON de decisión suspendida definido por response_format (relation, responseLanguage, profileUpdate, reply y actionInputs o decision/selectedCallIds). No emitas TurnIntent/actions. Incluye todas las propiedades del esquema; usa null para las que no apliquen.');
  return lines.join('\n');
}


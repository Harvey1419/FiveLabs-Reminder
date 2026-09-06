import { findRepairableManifestIssue } from './turn-plan.js';

export const MANIFEST_REPAIR_MODE = Object.freeze({
  REQUIRED: 'required',
  RECONSIDER: 'reconsider',
});

/**
 * Decide whether a rejected manifest must be structurally corrected or whether
 * the model must first reconsider if the current turn needs a tool at all.
 */
export function getManifestRepairDirective(validation, compiled) {
  const issue = findRepairableManifestIssue(validation, compiled);
  if (!issue) return null;

  const entries = compiled?.valid && Array.isArray(compiled.entries)
    ? compiled.entries
    : [];
  const hasOnlyUngroundedOperations = entries.length > 0 && entries.every((entry) => (
    entry?.valid === false && entry?.errorCode === 'UNTRUSTED_SOURCE_QUOTE'
  ));

  return {
    ...issue,
    mode: hasOnlyUngroundedOperations
      ? MANIFEST_REPAIR_MODE.RECONSIDER
      : MANIFEST_REPAIR_MODE.REQUIRED,
  };
}

/** Build provider-facing recovery feedback without leaking validation internals to the user. */
export function buildManifestRecoveryFeedback({ directive, language = 'es', finalAttempt = false }) {
  const isEnglish = language === 'en';

  if (finalAttempt) {
    return {
      outcome: 'manifest_rejected_before_execution',
      ...directive,
      instruction: isEnglish
        ? 'Nothing was executed because the corrected manifest remained invalid. Reply naturally without tools. If the current request needs an action, ask one concise clarification. Do not mention schemas, evidence validation, sourceQuote, or internal errors, and do not claim completion.'
        : 'No se ejecutó nada porque el manifiesto corregido siguió siendo inválido. Responde de forma natural sin tools. Si la petición actual necesita una acción, haz una sola pregunta breve de aclaración. No menciones schemas, validación de evidencia, sourceQuote ni errores internos, y no afirmes que completaste algo.',
    };
  }

  if (directive?.mode === MANIFEST_REPAIR_MODE.RECONSIDER) {
    return {
      outcome: 'manifest_rejected_before_execution',
      ...directive,
      instruction: isEnglish
        ? 'Nothing was executed. None of the proposed operations is grounded in the current user message. Re-read only the current turn. If it does not request a data read or authorize an action, answer naturally without calling a tool. Otherwise return one corrected execute_turn using verbatim evidence from the current message.'
        : 'No se ejecutó nada. Ninguna operación propuesta está respaldada por el mensaje actual. Relee únicamente el turno actual. Si no solicita consultar datos ni autoriza una acción, responde con naturalidad sin llamar una tool. De lo contrario devuelve un solo execute_turn corregido con evidencia literal del mensaje actual.',
    };
  }

  if (directive?.errorCode === 'INVALID_CONTEXT_REFERENCE') {
    return {
      outcome: 'manifest_rejected_before_execution',
      ...directive,
      instruction: isEnglish
        ? 'Nothing was executed. The proposed contextRef does not exist in typed active state. Do not keep or invent a contextual mutation by merely dropping the reference. Re-evaluate the current message: use create for a self-contained new item; use update only when the user truly identifies an existing item and a valid typed reference exists; otherwise ask one clarification.'
        : 'No se ejecutó nada. El contextRef propuesto no existe en el estado tipado activo. No conserves ni inventes una mutación contextual simplemente quitando la referencia. Reevalúa el mensaje actual: usa create para un elemento nuevo y autosuficiente; usa update solo si el usuario identifica realmente uno existente y hay una referencia tipada válida; de lo contrario pide una aclaración.',
    };
  }

  return {
    outcome: 'manifest_rejected_before_execution',
    ...directive,
    instruction: isEnglish
      ? 'Nothing was executed. Return one corrected execute_turn using verbatim evidence from the current user message and every required field.'
      : 'No se ejecutó ninguna operación. Devuelve un execute_turn corregido usando evidencia literal del mensaje actual y todos los campos requeridos.',
  };
}

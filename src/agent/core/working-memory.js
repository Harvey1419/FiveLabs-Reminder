import {
  saveWorkingMemory,
  getWorkingMemory,
  clearWorkingMemory,
  getWorkingMemorySnapshot,
  hydrateWorkingMemoryFromHistory,
  formatWorkingMemoryPrompt as formatWorkingMemoryPromptBase,
  sanitizeResponseText,
  tokenizeText,
} from './working-memory-store.js';

export {
  saveWorkingMemory,
  getWorkingMemory,
  clearWorkingMemory,
  getWorkingMemorySnapshot,
  hydrateWorkingMemoryFromHistory,
  sanitizeResponseText,
  tokenizeText,
};

/**
 * Render Working Memory plus the one semantic state that must be explicit to
 * Hermes: a dispatched reminder currently awaiting acknowledgement.
 *
 * The LLM still decides whether the user's current message semantically means
 * "I completed it". Node receives only the structured reminder.acknowledge
 * action and resolves target "1" against the authoritative Working Memory
 * reference, so no natural-language acknowledgement rules live in backend code.
 */
export function formatWorkingMemoryPrompt(userOrPhone) {
  const base = formatWorkingMemoryPromptBase(userOrPhone);
  const memory = getWorkingMemory(userOrPhone);
  const awaitingAcknowledgement = Boolean(
    memory
    && memory.source === 'reminder'
    && memory.notificationReminderId
    && ['nudge', 'reminder_dispatched'].includes(memory.lastAction),
  );

  if (!awaitingAcknowledgement) return base;

  const humanReference = String(
    memory.notificationContent
      || memory.items?.[0]?.summary
      || memory.items?.[0]?.title
      || '',
  ).trim();
  if (!humanReference) return base;

  const acknowledgementContext = [
    '[Seguimiento activo esperando confirmación]',
    `status=AWAITING_ACKNOWLEDGEMENT | reminder="${humanReference}"`,
    'Este recordatorio fue notificado y sigue esperando confirmación del usuario.',
    'Si el mensaje ACTUAL significa semánticamente que el usuario ya completó este recordatorio, emite únicamente reminder.acknowledge con target="1". No respondas solo con conversation.reply ni afirmes que quedó confirmado sin ejecutar esa acción.',
    'Un asentimiento sobre otro tema NO confirma el recordatorio. Si el mensaje actual no significa que lo completó, interprétalo normalmente.',
  ].join('\n');

  return base ? `${acknowledgementContext}\n${base}` : acknowledgementContext;
}

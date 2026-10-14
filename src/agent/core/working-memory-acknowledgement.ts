import type { WorkingMemoryState } from './working-memory-cache.js';
export interface WorkingMemoryPromptDependencies {
  getWorkingMemory(user: unknown): WorkingMemoryState | null;
  formatWorkingMemoryPromptBase(user: unknown): string;
}
export interface AcknowledgementOverview { pendingConfirmationReminders?: { id?: unknown }[] | null }

export function createWorkingMemoryPrompt({ getWorkingMemory, formatWorkingMemoryPromptBase }: WorkingMemoryPromptDependencies) {
  /**
   * Render Working Memory plus the one semantic state that must be explicit to
   * Hermes: a dispatched reminder currently awaiting acknowledgement.
   *
   * The LLM still decides whether the user's current message semantically means
   * "I completed it". Node receives only the structured reminder.acknowledge
   * action. Node then reconciles that structured action with the authoritative
   * live follow-up identity, so no natural-language acknowledgement rules live
   * in backend code.
   */
  function formatWorkingMemoryPrompt(userOrPhone: unknown, overview: AcknowledgementOverview | null = null): string {
    const base = formatWorkingMemoryPromptBase(userOrPhone);
    const memory = getWorkingMemory(userOrPhone);
    const authoritativeFollowups = Array.isArray(overview?.pendingConfirmationReminders)
      ? overview.pendingConfirmationReminders
      : null;
    const notificationIsStillActive = authoritativeFollowups === null
      || (
        authoritativeFollowups.length === 1
        && authoritativeFollowups[0]?.id === memory?.notificationReminderId
      )
      || (
        memory?.source === 'reminder'
        && memory?.notificationReminderId
        && memory?.lastAction === 'reminder_dispatched'
        && (!authoritativeFollowups || authoritativeFollowups.length <= 1)
      );
    const awaitingAcknowledgement = Boolean(
      memory
      && memory.source === 'reminder'
      && memory.notificationReminderId
      && ['nudge', 'reminder_dispatched'].includes(memory.lastAction)
      && notificationIsStillActive
    );

    if (!awaitingAcknowledgement || !memory) return base;

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
      'Si el mensaje ACTUAL significa semánticamente que el usuario ya completó este recordatorio, emite únicamente reminder.acknowledge (puedes omitir target o usar target="1"). No respondas solo con conversation.reply ni afirmes que quedó confirmado sin ejecutar esa acción.',
      'Un asentimiento sobre otro tema NO confirma el recordatorio. Si el mensaje actual no significa que lo completó, interprétalo normalmente.',
    ].join('\n');

    return base ? `${acknowledgementContext}\n${base}` : acknowledgementContext;
  }
  return { formatWorkingMemoryPrompt };
}

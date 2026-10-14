/** Schema prefetch hints only: never an intent decision, permission or execution. */
export function initialProductivityTools(authoredText: string): readonly string[] {
  const text = authoredText.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const reads = /\b(lista|listar|muestra|muestrame|ver|consulta|que|cuales|list|show|what|which)\b/.test(text);
  const writes = /\b(crea|crear|agrega|anade|recuerdame|programa|elimina|cancela|modifica|actualiza|completa|create|add|remind|schedule|delete|cancel|update|complete)\b/.test(text);
  if (reads && !writes) {
    const tools = [
      /\b(recordatorios?|reminders?)\b/.test(text) ? 'reminder_read' : null,
      /\b(tareas?|tasks?)\b/.test(text) ? 'task_read' : null,
      /\b(calendario|agenda|eventos?|calendar|events?)\b/.test(text) ? 'calendar_read' : null,
    ].filter((name): name is string => name !== null);
    if (tools.length) return tools.slice(0, 2);
  }
  return ['task_create', 'reminder_create'];
}

import { turnMediaInputSchema, type TurnMediaInput, type TurnContext } from '@templelabs/contracts';

/** Clip without splitting a UTF-16 surrogate pair. Raw extraction stays in history. */
function excerpt(text: string, max: number): string {
  let result = '';
  for (const point of text) { if (result.length + point.length > max) break; result += point; }
  return result;
}
export function createFileTurnInput(userId: string, requestId: string, kind: 'image' | 'document', userText: string, extracted: string): TurnMediaInput {
  const value = extracted.trim();
  return turnMediaInputSchema.parse({ version: 1, userId, requestId, userText,
    attachment: { kind, excerpt: excerpt(value, 800), truncated: value.length > 800, coverage: 'extracted_excerpt' } });
}
export function createLocationTurnInput(userId: string, requestId: string, latitude: unknown, longitude: unknown, label: string): TurnMediaInput | null {
  const parsed = turnMediaInputSchema.safeParse({ version: 1, userId, requestId, userText: '',
    attachment: { kind: 'location', latitude, longitude, label: excerpt(label, 120) } });
  return parsed.success ? parsed.data : null;
}
export function readTurnMediaInput(value: unknown, context: Pick<TurnContext, 'userId' | 'requestId'>, modality: unknown): TurnMediaInput | null {
  const parsed = turnMediaInputSchema.safeParse(value);
  return parsed.success && parsed.data.userId === context.userId && parsed.data.requestId === context.requestId
    && parsed.data.attachment.kind === modality ? parsed.data : null;
}
export function mediaModelText(input: TurnMediaInput): string {
  return JSON.stringify({ currentUserText: input.userText, untrustedAttachment: input.attachment });
}

/** Conservative grants from the authored caption only, never OCR, coordinates or quoted text.
 * Ambiguous/indirect instructions require a subsequent explicit text request. */
export function mediaAllowedTools(input: TurnMediaInput): ReadonlySet<string> {
  const caption = input.userText.replace(/"[^"]*"|“[^”]*”|«[^»]*»/gu, ' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const tools = new Set<string>();
  if (!caption || /[<>]/u.test(caption) || /\b(?:no\s+(?:crees|crear|crea|agregues|anotes|elimines|borres|canceles|modifiques)|do not|don't|never|nunca)\b/u.test(caption)) return tools;
  const direct = caption.replace(/^¿/u, '').replace(/^(?:por favor,?\s+|porfa,?\s+|please,?\s+|(?:puedes|podrias|could you|can you)\s+)/u, '').replace(/^¿/u, '');
  if (/^(?:no\b|not\b|don't\b|do not\b|nunca\b)/u.test(direct)) return tools;
  const domains = [
    ['task', /\b(?:tareas?|tasks?)\b/u],
    ['reminder', /\b(?:recordatorios?|reminders?)\b|\b(?:recuerdame|recordame|remind me)\b/u],
    ['calendar', /\b(?:agenda|calendario|calendar|eventos?|events?|reunion|meeting|cita)\b/u],
  ] as const;
  const matchingDomains = domains.filter(([, names]) => names.test(caption));
  for (const [domain] of matchingDomains) {
    tools.add(`${domain}_read`);
    let operation: string | null = null;
    if (/^(?:crea|crear|agrega|agregar|anota|anotar|anade|create|add|recuerdame|recordame|remind me|agenda|agendar|programa|programar|schedule|book)\b/u.test(direct)) operation = 'create';
    else if (/^(?:cambia|cambiar|modifica|modificar|actualiza|actualizar|mueve|mover|reprograma|update|change|move|reschedule)\b/u.test(direct)) operation = 'update';
    else if (/^(?:elimina|eliminar|borra|borrar|cancela|cancelar|quita|delete|remove|cancel)\b/u.test(direct)) operation = domain === 'reminder' ? 'cancel' : 'delete';
    else if (domain === 'task' && /^(?:completa|completar|termina|finaliza|complete|finish)\b/u.test(direct)) operation = 'complete';
    if (operation && matchingDomains.length === 1) tools.add(`${domain}_${operation}`);
  }
  return tools;
}

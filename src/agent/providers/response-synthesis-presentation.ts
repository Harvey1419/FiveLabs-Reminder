import { responseVoice } from '../contracts/response-policy-contract.js';

export interface ResponseSynthesisInput {
  facts?: readonly { tool: string }[];
  excludedClauses?: readonly { quote?: unknown; text?: unknown; sourceQuote?: unknown; reason?: unknown }[];
  language?: string;
}
export interface SynthesisMessage { role: 'system' | 'user'; content: string }

export function buildResponseSynthesisMessages({
  facts,
  excludedClauses = [],
  language = 'es',
}: ResponseSynthesisInput = {}): SynthesisMessage[] | null {
  if (!Array.isArray(facts) || facts.length === 0) return null;
  if (!Array.isArray(excludedClauses) || excludedClauses.length === 0) return null;

  const isEnglish = language === 'en';
  const areaByTool: Record<string, string> = {
    manage_reminder: 'reminders',
    manage_task: 'tasks and projects',
    manage_entity: 'projects and lists',
    manage_google_calendar: 'calendar',
    get_unified_agenda: 'personal agenda',
    manage_memory: 'personal memory',
    manage_subscription: 'Hermes subscription',
  };
  const availableAreas = [...new Set(facts.map((fact) => areaByTool[fact.tool]).filter(Boolean))];
  const messages: SynthesisMessage[] = [
    {
      role: 'system',
      content: isEnglish
        ? `Write one tiny conversational fragment before verified assistant cards. Return JSON only: {"before":"","after":""}. Address only the excluded part. Never restate, reinterpret or claim the result of an action. Never mention internal tools or schemas. "after" must be empty. Each field is at most 160 characters.`
        : `Escribe en ${responseVoice(language)} un fragmento conversacional mínimo antes de cards verificadas del asistente. Devuelve solo JSON: {"before":"","after":""}. Atiende únicamente la parte excluida. Nunca repitas, reinterpretes ni afirmes el resultado de una acción. Nunca menciones herramientas ni esquemas internos. "after" debe quedar vacío. Cada campo admite máximo 160 caracteres.`,
    },
    {
      role: 'user',
      content: JSON.stringify({
        availableAreas,
        excludedClauses: excludedClauses.map((item) => ({
          text: item.quote || item.text || item.sourceQuote || '',
          reason: item.reason || 'out_of_scope',
        })),
      }),
    },
  ];
  return messages;
}

export function normalizeResponseSynthesis(parsed: Record<string, unknown>): { before: string; after: string } {
  const compact = (value: unknown) => typeof value === 'string'
    ? value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
    : '';
  return { before: compact(parsed.before || parsed.after), after: '' };
}


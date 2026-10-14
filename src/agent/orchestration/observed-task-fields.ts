import { matchesSchema } from '../contracts/schema-value-contract.js';
import { TOOL_NAMES } from '../contracts/tool-names-contract.js';
import { sanitizeResponseText } from '../core/working-memory-cache.js';
import type { TaskCardCoverage } from '../core/execution-presentation.js';

export interface ObservedTaskRow extends Record<string, unknown> { id?: unknown; title?: unknown; user_id?: unknown; status?: unknown }
export interface ObservedTaskFact {
  success?: unknown; complete?: unknown; callId?: unknown; tool?: unknown; requestedAction?: unknown;
  presentationData?: { tasks?: unknown } | null;
}
export interface ObservedTaskClaim {
  callId: string; itemId: string; referencePosition: number | null; fields: readonly string[];
}
export interface ObservedTaskAnswer {
  kind: string; answer: string; evidenceCallIds: readonly unknown[]; taskClaims?: readonly ObservedTaskClaim[];
}
export interface ObservedTaskReference { position: number; itemId: string }
export interface SelectedTaskFields { row: ObservedTaskRow; fields: readonly string[]; referenceUnresolved?: boolean }
export interface FrozenTaskReferences { items: { position: number; type: 'task'; internalId: string; title: string }[] }
export type RetainedTaskCoverage = TaskCardCoverage & { callId: unknown };

export function publicReceiptSummary(summary: string) {
  return summary.replace(/(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/gi, '[redacted]').slice(0, 400);
}

export const ANSWER_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['inventory', 'derived', 'insufficient', 'recap', 'task_status'] },
    answer: { type: 'string' },
    evidenceCallIds: { type: 'array', maxItems: 12, items: { type: 'string' } },
    knowledgeRefs: { type: ['array', 'null'], maxItems: 8, items: { type: 'string', pattern: '^pk_[a-f0-9]{8,16}_[1-9][0-9]?$' } },
    taskCoverage: { type: 'string', enum: ['returned_rows', 'both_statuses', 'unknown', 'not_applicable'] },
    taskClaims: { type: 'array', maxItems: 12, items: {
      type: 'object', additionalProperties: false,
      properties: {
        callId: { type: 'string', minLength: 1 }, itemId: { type: 'string', minLength: 1 },
        referencePosition: { type: ['integer', 'null'], minimum: 1 },
        fields: { type: 'array', minItems: 1, maxItems: 5,
          items: { type: 'string', enum: ['status', 'description', 'due_date', 'completed_at', 'priority'] } },
      }, required: ['callId', 'itemId', 'referencePosition', 'fields'],
    } },
  }, required: ['kind', 'answer', 'evidenceCallIds'],
};

// Bind declared identities, never interpretations of generated prose or item titles.
export function taskClaimRows(answer: ObservedTaskAnswer, observed: readonly ObservedTaskFact[], references: readonly ObservedTaskReference[], userId: unknown): SelectedTaskFields[] | null {
  // Inventory displays canonical read cards, not generated task claims. Ignore
  // unused claims instead of retrying a valid listing or publishing their data.
  if (answer.kind === 'inventory') return [];
  if (!answer.taskClaims?.length) return answer.kind === 'task_status' ? null : [];
  if (answer.kind === 'insufficient') return null;
  const selected: SelectedTaskFields[] = [];
  const seen = new Set();
  for (const claim of answer.taskClaims) {
    const fact = observed.find(item => item.callId === claim.callId
      && ([TOOL_NAMES.MANAGE_TASK, TOOL_NAMES.GET_UNIFIED_AGENDA] as readonly unknown[]).includes(item.tool));
    const rows = fact?.presentationData?.tasks;
    if (!answer.evidenceCallIds.includes(claim.callId) || !Array.isArray(rows)) return null;
    const matches = (rows as (ObservedTaskRow | null | undefined)[]).filter(row => row?.id === claim.itemId);
    if (matches.length !== 1 || seen.has(claim.itemId)) return null;
    const row = matches[0]!;
    if (!row.title || typeof row.title !== 'string'
      || (row.user_id != null && row.user_id !== userId)) return null;
    if (new Set(claim.fields).size !== claim.fields.length
      || claim.fields.some(field => row[field] != null && typeof row[field] !== 'string')) return null;
    const reference = claim.referencePosition === null ? null
      : references.find(item => item.position === claim.referencePosition);
    // A read can still establish named fields without establishing an ordinal.
    // This never resolves a mutation target or asserts the requested mapping.
    const referenceUnresolved = claim.referencePosition !== null
      && (!reference || reference.itemId !== claim.itemId);
    seen.add(claim.itemId);
    selected.push({ row, fields: claim.fields, referenceUnresolved });
  }
  return selected;
}

// Freeze only reference identity, never raw Working Memory payloads. Reject an
// oversized view rather than silently dropping or renumbering referents.
export function freezeTaskReferenceSnapshot(memory: unknown): FrozenTaskReferences | false | null {
  if (!memory) return null;
  const state = memory as { items?: unknown };
  if (!Array.isArray(state.items) || state.items.length > 100) return false;
  const items: FrozenTaskReferences['items'] = [], positions = new Set<number>();
  let characters = 0;
  for (const rawItem of state.items) {
    const item = rawItem as { type?: unknown; position?: number; internalId?: unknown; title?: unknown } | null | undefined;
    if (item?.type !== 'task') continue;
    if (!Number.isInteger(item.position) || item.position! < 1 || item.position! > 100
      || positions.has(item.position!) || typeof item.internalId !== 'string' || !item.internalId
      || item.internalId.length > 80 || typeof item.title !== 'string' || item.title.length > 400) return false;
    characters += item.internalId.length + item.title.length + 80;
    if (characters > 8000) return false;
    positions.add(item.position!);
    items.push({ position: item.position!, type: 'task', internalId: item.internalId, title: item.title });
  }
  return { items };
}

/** Simple returned-field projection; no title matching, positional inference or model call. */
export function answerFromTaskReturnFields(action: { domain?: unknown; action?: unknown; returnFields?: readonly string[] }, facts: readonly ObservedTaskFact[], userId: unknown, language: string): string {
  const failure = language === 'en' ? 'I could not verify the requested task fields.' : 'No pude verificar los campos solicitados de las tareas.';
  const fact = facts.length === 1 ? facts[0] : null;
  const rows = fact?.presentationData?.tasks;
  if (action.domain !== 'task' || action.action !== 'list' || !fact?.success || !fact.complete
    || fact.tool !== TOOL_NAMES.MANAGE_TASK || fact.requestedAction !== 'list'
    || !fact.callId || !Array.isArray(rows) || rows.length > 12
    || rows.some(row => !row || row.user_id !== userId)) return failure;
  if (!rows.length) return language === 'en' ? 'No tasks returned for this query.' : 'No se devolvieron tareas para esta consulta.';
  const answer = { kind: 'task_status', answer: '', evidenceCallIds: [fact.callId],
    taskClaims: rows.map(row => ({ callId: fact.callId, itemId: row.id, referencePosition: null, fields: action.returnFields })) };
  if (!matchesSchema(answer, ANSWER_SCHEMA)) return failure;
  // Shape assertion follows the existing schema check; ownership is checked below.
  const selected = taskClaimRows(answer as ObservedTaskAnswer, [fact], [], userId);
  if (!selected) return failure;
  const text = renderTaskFields(selected, language);
  return text.length <= 2400 ? text : failure;
}

export function renderTaskFields(selected: readonly SelectedTaskFields[], language: string): string {
  const spanish = language !== 'en';
  const labels: Readonly<Record<string, string>> = { description: 'descripción', due_date: 'fecha de vencimiento', completed_at: 'fecha de finalización', priority: 'prioridad' };
  const statuses: Readonly<Record<string, string>> = { completed: 'completada', pending: 'pendiente', in_progress: 'en progreso', cancelled: 'cancelada' };
  return selected.map(({ row, fields }) => {
    const values = fields.map(field => {
      let value = row[field] === undefined ? (spanish ? 'desconocido' : 'unknown')
        : row[field] === null ? (spanish ? 'ausente' : 'absent') : publicReceiptSummary(row[field] as string);
      if (field === 'status' && row.status != null) value = Object.hasOwn(statuses, row.status as string)
        ? (spanish ? statuses[row.status as string]! : row.status as string) : (spanish ? 'desconocido' : 'unknown');
      return field === 'status' ? value : `${spanish ? labels[field] : field}: ${value}`;
    });
    return `${sanitizeResponseText(publicReceiptSummary(row.title as string))}: ${values.join('; ')}.`;
  }).join('\n');
}

// On a rejected answer keep useful public facts, without pretending that the
// model's requested comparison or positional binding has been resolved.
export function returnedTaskFacts(facts: readonly ObservedTaskFact[], userId: unknown, language: string, retainedTaskCoverage: readonly RetainedTaskCoverage[] = []): string {
  const selected: string[] = [], seen = new Set<string>();
  let characters = 0;
  for (const fact of facts) {
    if (!fact.success || !fact.complete || !fact.callId
      || !([TOOL_NAMES.MANAGE_TASK, TOOL_NAMES.GET_UNIFIED_AGENDA] as readonly unknown[]).includes(fact.tool)
      || !['read', 'list'].includes(fact.requestedAction as string)) continue;
    const taskRows = fact.presentationData?.tasks;
    if (!Array.isArray(taskRows)) continue;
    const counts = new Map();
    for (const row of taskRows as (ObservedTaskRow | null | undefined)[]) if (typeof row?.id === 'string') counts.set(row.id, (counts.get(row.id) || 0) + 1);
    for (const row of taskRows as (ObservedTaskRow | null | undefined)[]) {
      if (typeof row?.id !== 'string' || !row.id || counts.get(row.id) !== 1
        || typeof row.title !== 'string' || !row.title || seen.has(row.id)
        || (row.user_id != null && row.user_id !== userId)) continue;
      const fields = ['status', 'description', 'due_date', 'completed_at', 'priority']
        .filter(field => Object.hasOwn(row, field) && (row[field] == null || typeof row[field] === 'string'));
      const covered = retainedTaskCoverage.find(item => item.callId === fact.callId && item.itemId === row.id)?.fields || [];
      const available = (fields.length ? fields : Object.hasOwn(row, 'status') ? [] : ['status'])
        .filter(field => !covered.includes(field));
      if (!available.length) continue;
      const text = renderTaskFields([{ row, fields: available }], language);
      if (selected.length === 12 || characters + text.length > 1600) break;
      seen.add(row.id);
      selected.push(text);
      characters += text.length;
    }
    if (selected.length === 12) break;
  }
  if (!selected.length) return '';
  const heading = language === 'en'
    ? 'Available returned facts (bounded; not a resolved comparison or complete inventory):'
    : 'Datos devueltos disponibles (acotados; no resuelven la comparación ni cubren el inventario completo):';
  return [heading, ...selected].join('\n');
}


import { createHash } from 'node:crypto';
import { TOOL_NAMES } from '../contracts/tool-names-contract.js';
import { sanitizeResponseText } from '../core/working-memory-cache.js';
import type { TaskFormatContext } from '../../shared/task-card-presentation.js';
import { publicReceiptSummary } from './observed-task-fields.js';

export interface CreationReceipt { operation: string | undefined; summary: string }
export interface CreationReceiptEvent { eventId: string; receipt: CreationReceipt }
export interface HistoricalOperationalEvent { ref: string; operation: string; outcome: unknown; summary: string; clipped: boolean }
export interface HistoricalEvidenceSnapshot { version: number; owner: string; events: HistoricalOperationalEvent[] }
export interface HistoricalEvidenceFact {
  tool?: unknown; success?: unknown; complete?: unknown; requestedAction?: unknown; outcome?: unknown;
  callId?: unknown; card?: unknown; presentationData?: unknown; presentationContext?: unknown;
}
interface EvidenceRow extends Record<string, unknown> { user_id?: unknown; id?: unknown; title?: unknown; content?: unknown; status?: unknown }
interface EvidenceData extends Record<string, unknown> { tasks?: EvidenceRow[]; reminders?: EvidenceRow[] }
interface HistoricalTurn { role?: unknown; entities?: { _turnMetadata?: {
  kind?: unknown; mutationReceipts?: unknown; creationReceiptEvents?: unknown; operationalEvidence?: unknown;
} } | null }
export interface HistoricalEvidenceDependencies {
  randomUUID(): string;
  formatCanonicalTaskCreate: typeof import('../../shared/task-presentation.js').formatCanonicalTaskCreate;
  formatCanonicalTaskUpdate: typeof import('../../shared/task-presentation.js').formatCanonicalTaskUpdate;
  formatCanonicalTaskComplete: typeof import('../../shared/task-presentation.js').formatCanonicalTaskComplete;
  formatCanonicalTaskList: typeof import('../../shared/agenda-presentation.js').formatCanonicalTaskList;
  formatCanonicalReminderCreate: typeof import('../../shared/reminder-presentation.js').formatCanonicalReminderCreate;
  formatCanonicalReminderList: typeof import('../../shared/reminder-presentation.js').formatCanonicalReminderList;
}

/** Descriptive history remains bounded and owner-scoped; this module grants no execution capability. */
export function createHistoricalEvidence(dependencies: HistoricalEvidenceDependencies) {
  const { randomUUID, formatCanonicalTaskCreate, formatCanonicalTaskUpdate, formatCanonicalTaskComplete,
    formatCanonicalTaskList, formatCanonicalReminderCreate, formatCanonicalReminderList } = dependencies;
  const RECEIPT_OPERATIONS = new Set(['task.create', 'reminder.create']);

  // Receipt copies have their own structural ID boundary: Markdown underscores
  // are not hex-token characters. Mask full UUIDs before clipping their text.

  // Public, already-rendered creation text only; never use fallback tool prose or params.
  function mutationReceiptsFromFacts(facts: readonly HistoricalEvidenceFact[] = []): CreationReceipt[] {
    return facts.filter(fact => fact.success && fact.complete && fact.requestedAction === 'create')
      .flatMap(fact => {
        let operation, summary;
        if (fact.tool === TOOL_NAMES.MANAGE_TASK) {
          operation = 'task.create';
          summary = formatCanonicalTaskCreate(fact.presentationData, fact.presentationContext as TaskFormatContext | undefined);
        } else if (fact.tool === TOOL_NAMES.MANAGE_REMINDER) {
          operation = 'reminder.create';
          summary = formatCanonicalReminderCreate(fact.presentationData, fact.presentationContext as TaskFormatContext | undefined);
        }
        // Match the execution fact's production redaction/whitespace pipeline before
        // strict eligibility comparison. Receipt-local masking happens only afterward,
        // so it cannot make a tampered card eligible.
        summary = sanitizeResponseText(summary);
        return summary && summary === fact.card ? [{ operation, summary: publicReceiptSummary(summary) }] : [];
      }).slice(-6);
  }

  function eligibleStoredReceipts(receipts: unknown = []): CreationReceipt[] {
    return (Array.isArray(receipts) ? receipts.slice(-6) : []).filter(receipt => receipt
      && Object.keys(receipt).length === 2 && RECEIPT_OPERATIONS.has(receipt.operation)
      && typeof receipt.summary === 'string' && receipt.summary.trim())
      .map(({ operation, summary }) => ({ operation, summary: publicReceiptSummary(summary) }));
  }

  // The latest assistant carry is a bounded snapshot, not six new executions.
  // Event identity prevents snapshot replay; equal public cards remain distinct events.
  function historicalReceiptEvents(history: unknown = []): CreationReceiptEvent[] {
    let events: CreationReceiptEvent[] = [];
    for (const turn of (Array.isArray(history) ? history.slice(-30) : []) as (HistoricalTurn | null | undefined)[]) {
      if (turn?.role !== 'assistant') continue;
      const metadata = turn.entities?._turnMetadata;
      if (Array.isArray(metadata?.creationReceiptEvents)) {
        events = metadata.creationReceiptEvents.slice(-6).flatMap(event => {
          if (!event || Object.keys(event).length !== 2 || typeof event.eventId !== 'string'
            || !event.eventId || event.eventId.length > 80) return [];
          return eligibleStoredReceipts([event.receipt]).map(receipt => ({ eventId: event.eventId, receipt }));
        });
      } else if (metadata?.kind === 'operational_result') {
        events.push(...eligibleStoredReceipts(metadata.mutationReceipts)
          .map(receipt => ({ eventId: randomUUID(), receipt })));
      }
      events = [...new Map(events.map(event => [event.eventId, event])).values()].slice(-6);
    }
    return events;
  }

  function carryCreationReceiptEvents(history: unknown = [], newReceipts: unknown = []): CreationReceiptEvent[] {
    return [...historicalReceiptEvents(history), ...eligibleStoredReceipts(newReceipts)
      .map(receipt => ({ eventId: randomUUID(), receipt }))].slice(-6);
  }

  function historicalMutationReceipts(history: unknown = []): CreationReceipt[] {
    return historicalReceiptEvents(history).map(event => event.receipt);
  }

  function receiptBlock(receipts: readonly CreationReceipt[], language: string, failed: unknown): string {
    if (!receipts.length) return '';
    const heading = language === 'en'
      ? 'Historical confirmed actions (quotes, not latest state). Current observations take precedence.'
      : 'Acciones históricas confirmadas (citas, no estado actual). Las observaciones actuales tienen prioridad.';
    const warning = failed ? (language === 'en' ? 'Current status in the failed read domain is unverified.' : 'El estado actual del dominio cuya consulta falló está no verificado.') : '';
    return [heading, ...receipts.map(receipt => `> ${receipt.operation}: ${receipt.summary.replace(/\n/g, '\n> ')}`), warning].filter(Boolean).join('\n');
  }

  function historicalRecap(history: unknown, language: string, content?: unknown): string {
    // Legacy content is not execution evidence, even when historically framed.
    // Operational selections use renderOperationalEvidence instead.
    const summary = '';
    const contextual = language === 'en'
      ? `Historical conversation summary (not current verification):\n${summary || 'No contextual summary was supplied; no discussion or failure is inferred.'}`
      : `Resumen histórico de la conversación (no verifica el estado actual):\n${summary || 'No se proporcionó resumen contextual; no se infieren conversaciones ni fallos.'}`;
    const block = receiptBlock(historicalMutationReceipts(history), language, false);
    const limitation = language === 'en'
      ? 'This creation-only history may be incomplete: at most six receipts, 400 characters each (2400 total); overflow and unavailable history are omitted. Legacy recovery covers only 30 messages. It does not verify updates, completion or current state.'
      : 'Este historial de creaciones puede estar incompleto: hasta seis comprobantes, 400 caracteres cada uno (2400 en total); se omiten excedentes e historia no disponible. La recuperación antigua abarca solo 30 mensajes. No verifica cambios, finalización ni estado actual.';
    const empty = language === 'en' ? 'No eligible creation receipts in the available window.' : 'No hay comprobantes de creación elegibles en la ventana disponible.';
    return [contextual, block || empty, limitation].join('\n\n');
  }

  // Existing trusted assistant entities are the storage boundary. Message bodies
  // and user entities never enter this projection. A carry belongs to one owner.
  const EVIDENCE_LIMIT = 4096; // UTF-8 bytes for the entire stored snapshot.
  const EVIDENCE_ITEMS = 8;
  const EVIDENCE_TEXT = 600; // UTF-8 bytes per public card; clipping is explicit.
  const EVIDENCE_OPERATIONS = new Set(['task.create', 'task.update', 'task.complete', 'reminder.create', 'task.list', 'reminder.list', 'subscription.info', 'interpretation.read']);
  const evidenceOwner = (userId: unknown) => createHash('sha256').update(`operational-evidence:${userId}`).digest('hex');

  function boundedPublicCard(text: unknown) {
    const redacted = sanitizeResponseText(String(text || '').replace(/(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/gi, '[redacted]'));
    let summary = '';
    for (const character of redacted) {
      if (Buffer.byteLength(summary + character) > EVIDENCE_TEXT) break;
      summary += character;
    }
    return { summary, clipped: summary !== redacted };
  }

  function validEvidence(value: unknown): value is HistoricalOperationalEvent {
    const event = value as HistoricalOperationalEvent | null | undefined;
    return Boolean(event && Object.keys(event).sort().join(',') === 'clipped,operation,outcome,ref,summary'
      && typeof event.ref === 'string' && /^[0-9a-f-]{36}$/.test(event.ref)
      && EVIDENCE_OPERATIONS.has(event.operation)
      && ['success', 'partial_success', 'failure', 'unknown'].includes(event.outcome as string)
      && typeof event.clipped === 'boolean' && typeof event.summary === 'string'
      && event.summary.trim() && Buffer.byteLength(event.summary) <= EVIDENCE_TEXT
      && boundedPublicCard(event.summary).summary === event.summary);
  }

  function operationalEvidenceFromHistory(history: unknown = [], userId?: unknown): HistoricalOperationalEvent[] {
    if (typeof userId !== 'string' || !userId) return [];
    let events: HistoricalOperationalEvent[] = [];
    for (const turn of (Array.isArray(history) ? history.slice(-30) : []) as (HistoricalTurn | null | undefined)[]) {
      if (turn?.role !== 'assistant') continue;
      const carry = turn.entities?._turnMetadata?.operationalEvidence as { owner?: unknown; version?: unknown; events?: unknown } | null | undefined;
      if (!carry || carry.owner !== evidenceOwner(userId) || carry.version !== 1
        || Object.keys(carry).sort().join(',') !== 'events,owner,version'
        || !Array.isArray(carry.events) || carry.events.length > EVIDENCE_ITEMS
        || Buffer.byteLength(JSON.stringify(carry)) > EVIDENCE_LIMIT
        || !carry.events.every(validEvidence)
        || new Set(carry.events.map(event => event.ref)).size !== carry.events.length) continue;
      events = carry.events.map(event => ({ ...event }));
    }
    return events;
  }

  function carryOperationalEvidence(history: unknown, facts: readonly HistoricalEvidenceFact[] | null | undefined, userId: unknown, interpretationOutcome?: unknown): HistoricalEvidenceSnapshot {
    let events = operationalEvidenceFromHistory(history, userId);
    for (const fact of (Array.isArray(facts) ? facts : []).slice(0, 12)) {
      const domain = fact.tool === TOOL_NAMES.MANAGE_TASK ? 'task'
        : fact.tool === TOOL_NAMES.MANAGE_REMINDER ? 'reminder'
          : fact.tool === TOOL_NAMES.MANAGE_SUBSCRIPTION ? 'subscription' : null;
      const operation = `${domain}.${fact.requestedAction}`;
      if (!EVIDENCE_OPERATIONS.has(operation)) continue;
      let text = '';
      if (operation === 'task.update' || operation === 'task.complete') {
        // Only actual complete owned executions qualify. Legacy prose, counts
        // without owned rows, partial mutations and unknown calls cannot recover.
        const data = fact.presentationData as EvidenceData | null | undefined;
        const rows = Array.isArray(data) ? data : Array.isArray(data?.tasks) ? data.tasks : data ? [data] : [];
        if (typeof userId !== 'string' || !userId || !fact.success || !fact.complete || fact.outcome !== 'success'
          || typeof fact.callId !== 'string' || !fact.callId || fact.callId.length > 80
          || !rows.length || rows.length > 100 || rows.some(row => !row
            || row.user_id !== userId || typeof row.id !== 'string' || !row.id
            || typeof row.title !== 'string' || !row.title)) continue;
        const card = sanitizeResponseText(operation === 'task.update'
          ? formatCanonicalTaskUpdate(data, fact.presentationContext as TaskFormatContext | undefined)
          : formatCanonicalTaskComplete(data, fact.presentationContext as TaskFormatContext | undefined));
        if (!card || card !== fact.card) continue;
        text = card;
      } else if (!fact.success) {
        // A real failed/unknown tool outcome, never an invalid model interpretation.
        text = fact.outcome === 'unknown' ? 'Resultado de la operación desconocido.' : 'La operación falló.';
      } else if (operation === 'subscription.info') {
        const data = fact.presentationData as EvidenceData | null | undefined;
        // Null capability fields are actual tool information; never recover them
        // from the assistant's historical card or infer a failed payment.
        if (!data || !['price', 'discounts', 'paymentMethods', 'checkoutConfirmation', 'chargeOutcome', 'paymentOutcome', 'subscriptionStatus'].every(key => Object.hasOwn(data, key) && data[key] === null)) continue;
        text = 'Precios, descuentos y métodos de pago no confirmados. Confirmación del checkout, cargo, resultado del pago y suscripción desconocidos. No reintentar pagos hasta resolver el resultado; esta consulta no genera checkout.';
      } else {
        const data = fact.presentationData as EvidenceData | null | undefined;
        const rows = domain === 'task' ? data?.tasks : data?.reminders;
        if (Array.isArray(rows) && (rows.length > 100 || rows.some(row => !row || row.user_id != null && row.user_id !== userId))) continue;
        if (fact.requestedAction === 'create') {
          const receipt = mutationReceiptsFromFacts([fact])[0];
          if (!receipt) continue;
          text = fact.card as string; // Bound the original card, not an already-clipped receipt.
        } else {
          // Recompute canonical public cards, not tool/model fallback prose.
          if (!Array.isArray(rows)) continue;
          const card = sanitizeResponseText(domain === 'task'
            ? formatCanonicalTaskList(data, fact.presentationContext as TaskFormatContext | undefined)
            : formatCanonicalReminderList(data, fact.presentationContext as TaskFormatContext | undefined));
          if (!card || card !== fact.card) continue;
          text = `En la última consulta (${domain}; alcance ${boundedPublicCard(data!.scope || data!.filter || 'devuelto').summary}; filas devueltas/filtradas, no inventario completo):\n${card}`;
          // Retain explicit returned states without pretending list-card formatting
          // alone covers status. No raw row identities enter storage.
          const states = rows.slice(0, 12).map(row => {
            const title = domain === 'task' ? row.title : row.content;
            const status = ({ pending: 'pendiente', completed: 'completada', sent: 'enviado', in_progress: 'en progreso', cancelled: 'cancelada' } as Readonly<Record<string, string>>)[row.status as string];
            return typeof title === 'string' && status ? `${title}: ${status}.` : '';
          }).filter(Boolean);
          text += states.length ? `\n${states.join('\n')}` : '\nNo hay estados elegibles adicionales.';
        }
      }
      const publicCard = boundedPublicCard(text);
      if (!publicCard.summary) continue;
      // Latest observation/uncertainty per domain; creations and genuine failures
      // are distinct events. A later plain assistant turn carries, not remints.
      if (fact.success && ['list', 'info'].includes(fact.requestedAction as string)) events = events.filter(event => event.operation !== operation || event.outcome === 'failure' || event.outcome === 'unknown');
      events.push({ ref: randomUUID(), operation, outcome: fact.outcome, ...publicCard });
      events = events.slice(-EVIDENCE_ITEMS);
    }
    // Generation/validation outcomes are not tool failures. Persist only a fixed
    // public diagnostic; never model prose, errors, row identities or credentials.
    if (['rejected', 'unavailable', 'insufficient'].includes(interpretationOutcome as string)) {
      const successfulRead = (facts || []).some(fact => fact.success && fact.complete
        && ['read', 'list', 'search', 'next', 'status', 'metrics'].includes(fact.requestedAction as string));
      const text = interpretationOutcome === 'insufficient'
        ? 'La interpretación solicitada no quedó respaldada.'
        : 'No se obtuvo una interpretación válida de los datos.';
      events.push({ ref: randomUUID(), operation: 'interpretation.read', outcome: 'failure',
        ...boundedPublicCard(`${text}${successfulRead ? ' Las consultas exitosas conservaron sus resultados.' : ''}`) });
      events = events.slice(-EVIDENCE_ITEMS);
    }
    if (interpretationOutcome === 'reference_unresolved') {
      events.push({ ref: randomUUID(), operation: 'interpretation.read', outcome: 'partial_success',
        ...boundedPublicCard('Las consultas conservaron sus datos observados por nombre; las posiciones solicitadas no se pudieron vincular a la última lista mostrada. No se infiere una correspondencia ordinal.') });
      events = events.slice(-EVIDENCE_ITEMS);
    }
    const snapshot = { version: 1, owner: evidenceOwner(userId), events };
    while (snapshot.events.length && Buffer.byteLength(JSON.stringify(snapshot)) > EVIDENCE_LIMIT) snapshot.events.shift();
    return snapshot;
  }

  function renderOperationalEvidence(history: unknown, references: unknown, userId: unknown, language = 'es'): string {
    const available = operationalEvidenceFromHistory(history, userId);
    const safeFailure = language === 'en' ? 'The selected operational evidence is unavailable; no action or current state is inferred.' : 'La evidencia operativa seleccionada no está disponible; no se infieren acciones ni estado actual.';
    if (!Array.isArray(references) || !references.length || references.length > EVIDENCE_ITEMS
      || new Set(references).size !== references.length || references.some(ref => typeof ref !== 'string')) return safeFailure;
    const selected = references.map(ref => available.find(event => event.ref === ref));
    if (selected.some(event => !event)) return safeFailure;
    return [language === 'en' ? 'Historical summary (partial, bounded history; not current verification). No new verification:' : 'Resumen histórico (parcial, historia acotada; no verificación actual). Sin nueva verificación:',
      ...selected.map(event => `${event!.summary}${event!.clipped || event!.outcome === 'partial_success' ? (language === 'en' ? '\n[Partial/clipped evidence.]' : '\n[Evidencia parcial/recortada.]') : ''}`),
      language === 'en' ? 'Available history only; older evidence or overflow may be missing. Prior reads are not a complete or fresh inventory.' : 'Solo historia disponible; pueden faltar datos antiguos o excedentes. Las lecturas previas no son inventario completo ni actualizado.',
    ].join('\n\n');
  }

  // A historical recap is already an explicit summary request. Selecting refs
  // narrows it; omitting the optional selector must not hide available evidence.
  // Explicit invalid/empty selectors still fail closed, never expand to all.
  function renderHistoricalEvidence(history: unknown, references: unknown, userId: unknown, language: string): string {
    const refs = references === undefined
      ? operationalEvidenceFromHistory(history, userId).map(event => event.ref) : references;
    return renderOperationalEvidence(history, refs, userId, language);
  }

  return { mutationReceiptsFromFacts, carryCreationReceiptEvents, historicalMutationReceipts, receiptBlock,
    historicalRecap, operationalEvidenceFromHistory, carryOperationalEvidence, renderOperationalEvidence, renderHistoricalEvidence };
}

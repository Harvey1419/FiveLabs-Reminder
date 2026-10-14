import {
  jsonObjectSchema, reminderCheckpointSchema, reminderConversationSchema, reminderEffectEvidenceSchema,
  reminderDeliveryEvidenceSchema, reminderResolutionSchema, reminderRecordSchema,
  type AIMessage, type ReminderConversation, type ReminderUiItem, type TurnContext, type ToolCall,
  type ReminderResolution, type ReminderRecord,
} from '@templelabs/contracts';
import { z } from 'zod';
import { requireInboundTurnLease } from '../../agent/core/turn-lease.js';
import { checkpointFingerprint } from './checkpoint-fingerprint.js';
import { reminderStoredTurnSchema, type ReminderStoredTurn } from './reminder-state-recovery.js';

/** These lookups belong to a trusted durable audit/provider source, never model/user prose. */
export interface ReminderResolutionEvidencePort {
  effect(call: ToolCall, context: TurnContext): Promise<unknown>;
  delivery(deliveryId: string, context: TurnContext): Promise<unknown>;
}
export interface LegacyReminderHandoffSource {
  ownsThread(threadId: string, context: TurnContext): Promise<boolean>;
  hasActiveRun(context: TurnContext): Promise<boolean>;
  readOwnedReminder(id: string, context: TurnContext): Promise<{ userId: string; record: ReminderRecord } | null>;
}
function stop(code: string): never { throw Object.assign(new Error(code), { code }); }
function admitted(raw: unknown, context: TurnContext, capability: string) {
  const lease = requireInboundTurnLease();
  const row = reminderStoredTurnSchema.parse(raw);
  if (!context.capabilities.has(capability)) stop('RESOLUTION_ACCESS_DENIED');
  if (lease.inboundTurn.id !== context.runId || lease.inboundTurn.messageId !== context.requestId
    || row.id === context.runId || row.thread_id !== lease.inboundTurn.threadId) stop('RESOLUTION_IDENTITY_MISMATCH');
  if (!row.response || Object.hasOwn(row.response, 'agentCoreResolution')) stop('RESOLUTION_ALREADY_PRESENT');
  if (['agentCoreProductivity','agentCoreActiveRun','agentCoreActiveResolution','agentCoreActiveCompletion','agentCoreDeliveryManifest', 'agentCoreBaseline'].some(key => Object.hasOwn(row.response!,key))) stop('RESOLUTION_ENGINE_MISMATCH');
  context.signal.throwIfAborted(); lease.signal.throwIfAborted();
  return { lease, row };
}
async function persist(row: ReminderStoredTurn, resolution: ReminderResolution, context: TurnContext) {
  const lease = requireInboundTurnLease();
  context.signal.throwIfAborted(); lease.signal.throwIfAborted();
  await lease.assertActive();
  if (!lease.resolvePrior) stop('RESOLUTION_STORAGE_UNAVAILABLE');
  await lease.resolvePrior(row.id, row.response!, jsonObjectSchema.parse(resolution));
  return structuredClone(resolution.conversation);
}
function resolvedConversation(base: ReminderConversation, items: ReminderUiItem[], requestId: string, history: AIMessage[]) {
  const references = new Map(base.references.map(record => [record.id, record]));
  for (const item of items) if (item.status === 'success' || item.status === 'partial') {
    for (const record of item.result!.records) references.set(record.id, record);
  }
  return reminderConversationSchema.parse({ ...base, history, references: [...references.values()].slice(-50),
    handledRequestIds: base.handledRequestIds.includes(requestId) ? base.handledRequestIds : [...base.handledRequestIds, requestId] });
}

/** Closes a prior uncertain turn from authoritative receipts; executes/sends nothing. */
export async function reconcileReminderTurn(raw: unknown, context: TurnContext, evidence: ReminderResolutionEvidencePort) {
  const { lease, row } = admitted(raw, context, 'agent_core.reconcile');
  await lease.assertActive();
  if (row.status !== 'unknown') stop('RESOLUTION_NOT_UNKNOWN');
  const state = reminderCheckpointSchema.parse(row.response!.agentCore);
  if (state.userId !== context.userId || state.runId !== row.id || state.requestId !== row.message_id) stop('RESOLUTION_OWNER_MISMATCH');
  if (!state.completed && !state.start) stop('RESOLUTION_BASELINE_REQUIRED');
  const effectEvidence: ReminderResolution['effectEvidence'] = [];
  const deliveryEvidence: ReminderResolution['deliveryEvidence'] = [];
  const resolved = new Map<string, ReminderUiItem>();
  for (const effect of state.effects) {
    let item = effect.item;
    if (!item || item.status === 'indeterminate') {
      const call = effect.call;
      if (!call) stop('RESOLUTION_CALL_REQUIRED');
      if (call.name === 'reminder_read') item = { callId: call.id, toolName: 'reminder_read', status: 'failed',
        code: 'RECONCILED_READ_INTERRUPTED', result: null, readFilter: null, readQuery: null };
      else {
        const proof = reminderEffectEvidenceSchema.parse(await evidence.effect(structuredClone(call), context));
        if (proof.userId !== context.userId || proof.operationId !== call.id
          || proof.argumentsFingerprint !== checkpointFingerprint(call.arguments) || proof.item.toolName !== call.name) stop('RESOLUTION_EVIDENCE_MISMATCH');
        item = proof.item;
        if (item.status === 'failed') {
          if (item.code !== 'RECONCILED_NO_EFFECT' || item.result !== null) stop('RESOLUTION_NO_EFFECT_PROOF_REQUIRED');
        } else if (!item.result || !item.result.records.length || item.result.operation !== call.name.replace('reminder_', '')
          || ((call.name === 'reminder_update' || call.name === 'reminder_acknowledge')
            && !item.result.records.some(record => record.id === call.arguments.reminderId))) stop('RESOLUTION_RESOURCE_MISMATCH');
        effectEvidence.push(proof);
      }
    }
    resolved.set(item.callId, item);
  }
  for (const delivery of state.deliveries) {
    if (delivery.status !== 'attempted' && delivery.status !== 'unknown') continue;
    const proof = reminderDeliveryEvidenceSchema.parse(await evidence.delivery(delivery.message.id, context));
    if (proof.userId !== context.userId || proof.deliveryId !== delivery.message.id) stop('RESOLUTION_EVIDENCE_MISMATCH');
    deliveryEvidence.push(proof);
  }
  const base = state.completed?.conversation ?? state.start!.conversation;
  let history: AIMessage[];
  if (state.completed) history = base.history.map(message => message.role === 'tool' && resolved.has(message.toolCallId)
    ? { ...message, content: { status: resolved.get(message.toolCallId)!.status, observation: 'Outcome reconciled from durable evidence.' },
      isError: !['success', 'partial'].includes(resolved.get(message.toolCallId)!.status) } : message);
  else {
    const calls = state.effects.flatMap(effect => effect.call ? [effect.call] : []);
    history = [...base.history, { role: 'user', content: state.start!.text }, { role: 'assistant', content: '', toolCalls: calls },
      ...calls.map((call): AIMessage => ({ role: 'tool', toolCallId: call.id,
        content: { status: resolved.get(call.id)!.status, observation: 'Outcome reconciled from durable evidence.' },
        isError: !['success', 'partial'].includes(resolved.get(call.id)!.status) }))];
  }
  const resolution = reminderResolutionSchema.parse({ version: 1, kind: 'reconciliation', userId: context.userId,
    runId: row.id, requestId: row.message_id, threadId: row.thread_id, sourceFingerprint: checkpointFingerprint(row.response!),
    decidedAtIso: context.referenceTimeIso, effectEvidence, deliveryEvidence,
    conversation: resolvedConversation(base, [...resolved.values()], row.message_id, history) });
  return persist(row, resolution, context);
}

const factSchema = z.object({ tool: z.string(), success: z.boolean(), outcome: z.string(), presentationData: z.unknown() });
function legacyIds(value: unknown): string[] {
  const object = z.record(z.string(), z.unknown());
  let rows: unknown[];
  if (Array.isArray(value)) rows = value;
  else {
    const parsed = object.parse(value);
    rows = Array.isArray(parsed.reminders) ? parsed.reminders : parsed.reminder ? [parsed.reminder] : [parsed];
  }
  if (rows.length > 50) stop('HANDOFF_REFERENCE_LIMIT');
  return rows.map(row => z.uuid().parse(object.parse(row).id));
}
/** Imports backend-owned IDs and refreshes each record under exact user ownership. */
export async function handoffLegacyReminderTurn(raw: unknown, context: TurnContext, source: LegacyReminderHandoffSource) {
  const { lease, row } = admitted(raw, context, 'agent_core.handoff');
  await lease.assertActive();
  if (row.status !== 'completed' || Object.hasOwn(row.response!, 'agentCore')) stop('HANDOFF_NOT_LEGACY_COMPLETED');
  if (!await source.ownsThread(row.thread_id, context) || await source.hasActiveRun(context)) stop('HANDOFF_OWNER_OR_ACTIVE_RUN');
  const delivery = z.object({ status: z.literal('accepted'), messageId: z.string().min(1) }).parse(row.response!.delivery);
  const facts = z.array(factSchema).max(20).parse(row.response!.executionFacts);
  if (facts.some(fact => fact.outcome === 'unknown')) stop('HANDOFF_UNKNOWN_EFFECT');
  const ids = new Set<string>();
  for (const fact of facts) if (fact.tool === 'manage_reminder' && fact.success && ['success', 'partial_success'].includes(fact.outcome)) {
    for (const id of legacyIds(fact.presentationData)) ids.add(id);
  }
  if (ids.size > 50) stop('HANDOFF_REFERENCE_LIMIT');
  const references: ReminderRecord[] = [];
  for (const id of ids) {
    const owned = await source.readOwnedReminder(id, context);
    if (!owned || owned.userId !== context.userId || owned.record.id !== id) stop('HANDOFF_REFERENCE_NOT_OWNED');
    references.push(reminderRecordSchema.parse(owned.record));
  }
  const resolution = reminderResolutionSchema.parse({ version: 1, kind: 'legacy_handoff', userId: context.userId,
    runId: row.id, requestId: row.message_id, threadId: row.thread_id, sourceFingerprint: checkpointFingerprint(row.response!),
    decidedAtIso: context.referenceTimeIso, effectEvidence: [], deliveryEvidence: [],
    conversation: { userId: context.userId, history: [], references, handledRequestIds: [row.message_id] } });
  // Delivery is a persisted legacy receipt; preserve it in the original response rather than resending.
  if (!delivery.messageId) stop('HANDOFF_DELIVERY_REQUIRED');
  return persist(row, resolution, context);
}

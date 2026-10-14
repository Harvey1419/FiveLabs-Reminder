import {
  approvalDecisionSchema, continuationDecisionSchema, jsonObjectSchema, suspendedRunSnapshotSchema,
  type JsonObject, type SuspendedRunSnapshot, type TurnContext, type ApprovalDecision, type ContinuationDecision,
} from '@templelabs/contracts';
import { executeApprovalDecision, executeContinuationDecision, type LegacyPreparedAction, type LegacyActiveRunRuntime,
  type LegacyDomainExecutionCall, type LegacyActiveRunResult } from '../../agent/core/agent-run.js';
import { requireInboundTurnLease } from '../../agent/core/turn-lease.js';
import { claimAgentCoreLease } from './inbound-admission.js';
import { checkpointFingerprint } from './checkpoint-fingerprint.js';
import type { ActiveRunDecisionResult } from './active-run-ai-decision.js';
import type { ActiveRunStore } from './active-run-store.js';
import { validateApprovalDecision, validateContinuationDecision } from '../../agent/contracts/agent-run-contracts.js';

function json(value: unknown): JsonObject { return jsonObjectSchema.parse(JSON.parse(JSON.stringify(value))); }
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function fingerprint(snapshot: SuspendedRunSnapshot) { return checkpointFingerprint(json(snapshot)); }
function same(left: unknown, right: unknown) { return checkpointFingerprint(json({ value: left })) === checkpointFingerprint(json({ value: right })); }
/** Planning must use this complete projection before inferring approval/continuation. */
export function projectSuspendedAgentRun(row: JsonObject, actions: readonly JsonObject[]): SuspendedRunSnapshot {
  return suspendedRunSnapshotSchema.parse({ runId: row.id, userId: row.user_id, threadId: row.thread_id,
    status: row.status, expiresAtIso: row.expires_at,
    executionState: { kind: row.kind, context: row.context ?? {}, waitingFor: row.waiting_for ?? null },
    actions: actions.map(action => ({ callId: action.call_id, domain: action.domain, action: action.action,
      targetId: action.target_id ?? null, targetName: action.target_name ?? null, payload: action.payload,
      status: action.status, executionFact: action.execution_fact ?? null })).sort((a,b) => String(a.callId) < String(b.callId) ? -1 : String(a.callId) > String(b.callId) ? 1 : 0),
  });
}
function legacyAction(snapshot: SuspendedRunSnapshot, action: SuspendedRunSnapshot['actions'][number]): LegacyPreparedAction {
  return { run_id: snapshot.runId, call_id: action.callId, domain: action.domain, action: action.action,
    target_id: action.targetId, target_name: action.targetName, payload: action.payload, status: action.status, execution_fact: action.executionFact ?? null };
}
export interface ActiveRunExecutionContext {
  readonly turn: TurnContext; readonly threadId: string; readonly currentUserText: string; readonly deadlineMs: number;
  readonly user: { readonly id: string; readonly timezone?: string }; readonly now?: () => number;
  readonly isPro?: boolean; readonly isAdmin?: boolean;
  readonly authorizeWrite: (call: LegacyDomainExecutionCall, actions: readonly LegacyPreparedAction[]) => boolean | Promise<boolean>;
}
export class ActiveRunExecutionBridge {
  constructor(private readonly store: ActiveRunStore, private readonly executeTool: (call: LegacyDomainExecutionCall) => Promise<JsonObject>) {}
  async apply(rawSnapshot: SuspendedRunSnapshot, rawDecision: ActiveRunDecisionResult<ApprovalDecision | ContinuationDecision>, context: ActiveRunExecutionContext): Promise<LegacyActiveRunResult | { success: false; executed: false; status: 'not_acquired' | 'no_action' }> {
    const snapshot = suspendedRunSnapshotSchema.parse(structuredClone(rawSnapshot)), result = structuredClone(rawDecision);
    const lease = requireInboundTurnLease(), now = context.now ?? Date.now, turn = { ...context.turn };
    const deadline = context.deadlineMs, user = structuredClone(context.user), text = context.currentUserText, authorize = context.authorizeWrite;
    const isPro = context.isPro === true, isAdmin = context.isAdmin === true;
    const binding = result.binding;
    if (!snapshot.executionState || snapshot.actions.some(action => !Object.hasOwn(action,'executionFact') || !/^[\w.:-]+$/.test(action.callId))) fail('INCOMPLETE_EXECUTION_SNAPSHOT');
    if (snapshot.userId !== turn.userId || user.id !== turn.userId || snapshot.threadId !== context.threadId
      || binding.userId !== turn.userId || binding.threadId !== context.threadId || binding.runId !== snapshot.runId
      || binding.inboundRunId !== turn.runId || binding.requestId !== turn.requestId
      || lease.inboundTurn.id !== turn.runId || lease.inboundTurn.messageId !== turn.requestId || lease.inboundTurn.threadId !== context.threadId) fail('ACTIVE_RUN_OWNER_MISMATCH');
    if (binding.freshness !== 'snapshot' || binding.grantsExecution !== false || binding.snapshotFingerprint !== fingerprint(snapshot)) fail('ACTIVE_RUN_PROPOSAL_MISMATCH');
    const signal = AbortSignal.any([turn.signal,lease.signal]);
    const fresh = async () => {
      signal.throwIfAborted(); const clock = now();
      if (!Number.isFinite(clock) || !Number.isFinite(deadline) || clock >= deadline || clock >= Date.parse(snapshot.expiresAtIso)) fail('ACTIVE_RUN_EXECUTION_EXPIRED');
      await lease.assertActive(); signal.throwIfAborted();
      const observed = now();
      if (!Number.isFinite(observed) || observed >= deadline || observed >= Date.parse(snapshot.expiresAtIso)) fail('ACTIVE_RUN_EXECUTION_EXPIRED');
    };
    await fresh();
    if (result.status === 'refused') return { success: false, executed: false, status: 'no_action' };
    const approval = snapshot.status === 'waiting_for_approval';
    const decision = approval ? approvalDecisionSchema.parse(result.decision) : continuationDecisionSchema.parse(result.decision);
    const validated = approval ? validateApprovalDecision(json(decision)) : validateContinuationDecision(json(decision));
    if (!validated.valid || !Number.isFinite(Date.parse(turn.referenceTimeIso))) fail('INVALID_ACTIVE_RUN_DECISION');
    if (decision.profileUpdate && !text.includes(decision.profileUpdate.sourceQuote)) fail('INVALID_PROFILE_SOURCE');
    const pending = snapshot.actions.filter(a => a.status === 'prepared'), ids = new Set(pending.map(a => a.callId));
    if (!pending.length || snapshot.actions.some(a => a.status === 'failed' || a.executionFact?.outcome === 'unknown')) fail('ACTIVE_RUN_RECONCILIATION_REQUIRED');
    if (Object.hasOwn(snapshot.executionState.context,'_agentCoreClaim') || snapshot.actions.some(a => a.payload.domain !== undefined
      && (a.payload.domain !== a.domain || a.payload.action !== a.action))) fail('ACTIVE_RUN_EXECUTION_STATE_MISMATCH');
    if (snapshot.executionState.kind === 'entity_destructive_batch' && pending.some(a => !['project','entity'].includes(a.domain)
      || a.domain !== pending[0]!.domain || a.action !== 'delete' || !a.targetId)) fail('ACTIVE_RUN_EXECUTION_STATE_MISMATCH');
    const cancel = decision.relation === 'cancel' || approval && (decision as ApprovalDecision).decision === 'reject';
    if (!cancel && (approval ? decision.relation !== 'approval' : decision.relation !== 'resume')) return { success: false, executed: false, status: 'no_action' };
    const selected = approval ? (decision as ApprovalDecision).decision === 'approve_all' ? [...ids] : (decision as ApprovalDecision).selectedCallIds
      : (decision as ContinuationDecision).actionInputs?.map(input => input.callId) ?? [];
    if (!cancel && (!selected.length || new Set(selected).size !== selected.length || selected.some(id => !ids.has(id)))) fail('INVALID_ACTIVE_RUN_SELECTION');
    if (!approval && !cancel && (Object.keys((decision as ContinuationDecision).suppliedFields).length
      || (decision as ContinuationDecision).actionInputs?.some(input => !Object.keys(input.fields).length))) fail('INVALID_PENDING_ACTION_DELTA');
    claimAgentCoreLease(lease, 'active_run');
    const claim = await this.store.claim(snapshot, cancel ? 'cancelled' : 'running', json(decision));
    if (!claim) return { success: false, executed: false, status: 'not_acquired' };
    if (fingerprint(claim.snapshot) !== binding.snapshotFingerprint || claim.status !== (cancel ? 'cancelled' : 'running')) fail('INVALID_ACTIVE_RUN_CLAIM');
    const current = new Map(snapshot.actions.map(action => [action.callId, structuredClone(action)]));
    let admitted = false;
    const assertClaim = async () => { await fresh(); await this.store.mutate(claim,'assert',{}); };
    const runtime: LegacyActiveRunRuntime = {
      getPreparedActions: async runId => {
        if (runId !== snapshot.runId) fail('ACTIVE_RUN_OWNER_MISMATCH');
        return snapshot.actions.filter(a => !(approval || cancel) || a.status === 'prepared').map(a => legacyAction(snapshot,a));
      },
      claimRun: async (run, status, _ctx, next = 'running') => {
        if (admitted || run.id !== snapshot.runId || status !== snapshot.status || next !== claim.status) fail('ACTIVE_RUN_GRANT_REUSED');
        await assertClaim(); admitted = true; return true;
      },
      beforeWrite: async (call, actions) => {
        await assertClaim();
        if (call.user?.id !== user.id || actions.some(a => !ids.has(a.call_id)) || !await authorize(structuredClone(call),structuredClone(actions))) fail('ACTIVE_RUN_WRITE_DENIED');
        await assertClaim();
      },
      updatePreparedAction: async (runId, callId, updates) => {
        if (runId !== snapshot.runId || !current.has(callId)) fail('ACTIVE_RUN_OWNER_MISMATCH');
        await fresh(); const expected = current.get(callId)!;
        const wanted = json(updates);
        const value = await this.store.mutate(claim,'action',{ callId, expected: json(expected), updates: wanted });
        if (value.run_id !== snapshot.runId || value.call_id !== callId || value.domain !== expected.domain || value.action !== expected.action
          || value.target_id !== expected.targetId || value.target_name !== expected.targetName || value.status !== wanted.status
          || !same(value.execution_fact ?? null,wanted.executionFact ?? null) || !same(value.payload,wanted.payload ?? expected.payload)) fail('INVALID_ACTIVE_RUN_WRITE_RECEIPT');
        const projected = { ...expected, status: value.status, payload: value.payload, executionFact: value.execution_fact ?? null };
        const checked = suspendedRunSnapshotSchema.parse({ ...snapshot, actions: [projected] }).actions[0]!;
        current.set(callId,checked); return value;
      },
      updateRun: async (runId, updates) => {
        if (runId !== snapshot.runId) fail('ACTIVE_RUN_OWNER_MISMATCH'); await fresh();
        const value = await this.store.mutate(claim,'run',json(updates));
        if (value.id !== snapshot.runId || value.user_id !== snapshot.userId || value.thread_id !== snapshot.threadId || value.status !== updates.status) fail('INVALID_ACTIVE_RUN_WRITE_RECEIPT');
        return value;
      },
      recordEvent: async event => { await fresh(); return this.store.mutate(claim,'event',json(event)); },
    };
    const executionState = snapshot.executionState;
    const run = { id: snapshot.runId, user_id: snapshot.userId, thread_id: snapshot.threadId, status: snapshot.status,
      kind: executionState.kind, context: executionState.context, waiting_for: executionState.waitingFor, expires_at: snapshot.expiresAtIso };
    const executionContext = { user, isPro, isAdmin, timezone: turn.timezone, language: decision.responseLanguage ?? turn.language, referenceTime: new Date(turn.referenceTimeIso) };
    const executeTool = async (call: LegacyDomainExecutionCall) => { await assertClaim(); return this.executeTool(call); };
    let executed: LegacyActiveRunResult;
    if (approval || cancel) {
      // Cancellation uses the same known pending-action bookkeeping; the claim is already status-specific.
      executed = await executeApprovalDecision({ run, decision: cancel ? 'reject' : 'approve_subset', selectedCallIds: selected,
        executionContext, executionRuntime: { ...runtime, claimRun: (r,_s,c,n) => runtime.claimRun(r,snapshot.status,c,n) }, executeTool });
    } else executed = await executeContinuationDecision({ run, actionInputs: (decision as ContinuationDecision).actionInputs ?? [], executionContext, executionRuntime: runtime, executeTool });
    await fresh(); await this.store.mutate(claim,'finish',json(executed));
    if (Array.isArray(executed.facts) && executed.facts.some(fact => fact && typeof fact === 'object' && !Array.isArray(fact) && fact.outcome === 'unknown')) fail('ACTIVE_RUN_RECONCILIATION_REQUIRED');
    return executed;
  }
}

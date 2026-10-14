import { formatActiveRunPrompt as renderActiveRunPrompt, type ActiveRunPromptInput } from './active-run-prompt.js';
export type { ActiveRunPromptInput } from './active-run-prompt.js';
import type { JsonObject } from '@templelabs/contracts';
import type { LegacyActiveRun, LegacyExecutionContext, LegacyPreparedAction } from './active-run-executor.js';

export const AGENT_RUN_TTL_MS = 15 * 60 * 1000;
export type LegacyReferenceTime = Date | string | number;
export type LegacyRunUser = string | { readonly id?: string; readonly phone_number?: string; readonly timezone?: string } | null | undefined;
export interface LegacyPreparedActionInput {
  readonly callId?: string;
  readonly domain: string;
  readonly action: string;
  readonly targetId?: string | null;
  readonly targetName?: string | null;
  readonly payload: JsonObject;
  readonly status?: LegacyPreparedAction['status'];
  readonly executionFact?: JsonObject | null;
}
export interface LegacyDraftAction extends JsonObject {
  readonly domain: string;
  readonly action: string;
}
export interface LegacyStatusChange {
  readonly runId: string;
  readonly userId: string | null;
  readonly threadId: string;
  readonly expectedStatus: string;
  readonly nextStatus: string;
  readonly now: LegacyReferenceTime;
}
export interface LegacyRunLifecycleStorage {
  createRun(input: { userId: string | null; threadId: string; kind: string; waitingFor: JsonObject;
    context: JsonObject; expiresAt: string; initialStatus: 'failed' }): Promise<LegacyActiveRun>;
  getActiveRun(threadId: string, userId: string | null, now: LegacyReferenceTime): Promise<LegacyActiveRun | null>;
  getPreparedActions(runId: string): Promise<readonly LegacyPreparedAction[]>;
  stagePreparedActions(runId: string, actions: readonly LegacyPreparedActionInput[]): Promise<readonly LegacyPreparedAction[]>;
  updateRun(runId: string, updates: JsonObject): Promise<unknown>;
  updateRunIfStatus(input: LegacyStatusChange): Promise<boolean>;
  cancelActiveInputRun(input: Omit<LegacyStatusChange, 'nextStatus'>): Promise<boolean>;
  recordEvent(event: JsonObject): Promise<unknown>;
}
export interface LegacyAgentRunWithActions extends LegacyActiveRun {
  readonly preparedActions: readonly LegacyPreparedAction[];
  readonly activationFailed?: boolean;
  readonly activationStatusUnknown?: boolean;
}
export interface ApprovalRunOptions {
  readonly user: LegacyRunUser;
  readonly kind?: string;
  readonly preparedActions?: readonly LegacyPreparedActionInput[];
  readonly question?: string;
  readonly expiresAtMs?: number | null;
  readonly context?: JsonObject;
  readonly referenceTime?: LegacyReferenceTime | null;
}
export interface InputRunOptions extends Omit<ApprovalRunOptions, 'preparedActions'> {
  readonly partialAction?: LegacyDraftAction | null;
  readonly partialActions?: readonly LegacyDraftAction[];
  readonly missingFields?: readonly string[];
  readonly timezone?: string | null;
  readonly supersedesRunId?: string | null;
  readonly preserveExistingActiveRun?: boolean;
}

/** Persistence is provided by the host; this lifecycle has no database or SDK import. */
export function createLegacyRunLifecycle(storage: LegacyRunLifecycleStorage, continuationFieldKeys: readonly string[]) {
  function resolveThreadId(userOrPhone: LegacyRunUser): string {
    if (!userOrPhone) return 'anonymous';
    if (typeof userOrPhone === 'string') return userOrPhone.trim();
    return String(userOrPhone.phone_number || userOrPhone.id || 'anonymous').trim();
  }

  function resolveUserId(userOrPhone: LegacyRunUser): string | null {
    if (userOrPhone && typeof userOrPhone === 'object' && userOrPhone.id) {
      return String(userOrPhone.id).trim();
    }
    return null;
  }

  async function stagePendingActions(runId: string, actions: readonly LegacyPreparedActionInput[]): Promise<readonly LegacyPreparedAction[]> {
    try {
      return await storage.stagePreparedActions(runId, actions);
    } catch (error) {
      try {
        await storage.updateRun(runId, { status: 'failed' });
      } catch (cleanupError) {
        // Never let a frozen or primitive thrown value hide the original staging failure.
        try {
          if (error && typeof error === 'object') Object.defineProperty(error, 'cleanupError', {
            value: cleanupError, writable: true, configurable: true, enumerable: true,
          });
        } catch { /* preserve the primary staging error */ }
      }
      throw error;
    }
  }

  async function claimPendingRun(run: LegacyActiveRun, expectedStatus: string, executionContext: LegacyExecutionContext, nextStatus = 'running'): Promise<boolean> {
    const caller = executionContext.user;
    if (caller?.id && run.user_id && String(caller.id) !== String(run.user_id)) return false;
    return storage.updateRunIfStatus({
      runId: run.id, userId: run.user_id, threadId: run.thread_id,
      expectedStatus, nextStatus, now: executionContext.referenceTime || new Date(),
    });
  }

  /**
   * Retrieve the active AgentRun with its prepared actions.
   */
  async function getActiveAgentRun(userOrPhone: LegacyRunUser, now: LegacyReferenceTime = new Date()): Promise<LegacyAgentRunWithActions | null> {
    const threadId = resolveThreadId(userOrPhone);
    const userId = resolveUserId(userOrPhone);
    const run = await storage.getActiveRun(threadId, userId, now);
    if (!run) return null;

    const preparedActions = await storage.getPreparedActions(run.id);
    return {
      ...run,
      preparedActions: preparedActions || [],
    };
  }

  /**
   * Create an AgentRun in waiting_for_approval state for batch destructive operations.
   */
  async function createApprovalRun({
    user,
    kind = 'entity_destructive_batch',
    preparedActions = [],
    question = '',
    expiresAtMs = null,
    context = {},
    referenceTime = null,
  }: ApprovalRunOptions): Promise<LegacyAgentRunWithActions | null> {
    const threadId = resolveThreadId(user);
    const userId = resolveUserId(user);
    const baseNow = referenceTime
      ? (referenceTime instanceof Date ? referenceTime.getTime() : new Date(referenceTime).getTime())
      : Date.now();
    const expiresAt = new Date(baseNow + (expiresAtMs || AGENT_RUN_TTL_MS)).toISOString();

    const existingRun = await getActiveAgentRun(user, new Date(baseNow));
    if (existingRun?.status === 'running') return null;

    const run = await storage.createRun({
      userId,
      threadId,
      kind,
      waitingFor: {
        type: 'approval',
        question: String(question || '').trim(),
      },
      context: { ...context, referenceTime: new Date(baseNow).toISOString(), timezone: user && typeof user === 'object' ? user.timezone || null : null },
      expiresAt,
      initialStatus: 'failed',
    });

    const staged = await stagePendingActions(run.id, preparedActions);
    if (existingRun && !await storage.updateRunIfStatus({
      runId: existingRun!.id, userId, threadId, expectedStatus: existingRun!.status,
      nextStatus: 'cancelled', now: new Date(baseNow),
    })) return null;
    if (!await storage.updateRunIfStatus({
      runId: run.id, userId, threadId, expectedStatus: 'failed',
      nextStatus: 'waiting_for_approval', now: new Date(baseNow),
    })) return null;
    await storage.recordEvent({
      runId: run.id,
      userId,
      threadId,
      eventType: 'run_created_waiting_approval',
      factPayload: { kind, actionCount: preparedActions.length, question },
    });

    return {
      ...run,
      status: 'waiting_for_approval',
      preparedActions: staged,
    };
  }

  /**
   * Create an AgentRun in waiting_for_input state for incomplete operations (e.g. reminder without time).
   */
  async function createInputRun({
    user,
    kind = 'reminder_creation',
    partialAction = null,
    partialActions = [],
    missingFields = [],
    question = '',
    expiresAtMs = null,
    context = {},
    referenceTime = null,
    timezone = null,
    supersedesRunId = null,
    preserveExistingActiveRun = false,
  }: InputRunOptions): Promise<LegacyAgentRunWithActions | null> {
    const threadId = resolveThreadId(user);
    const userId = resolveUserId(user);
    const baseNow = referenceTime
      ? (referenceTime instanceof Date ? referenceTime.getTime() : new Date(referenceTime).getTime())
      : Date.now();
    const expiresAt = new Date(baseNow + (expiresAtMs || AGENT_RUN_TTL_MS)).toISOString();

    // Invariant 1: Ensure any previous active run on this thread is cancelled before creating a new one
    const currentTime = referenceTime || new Date();
    const existingRun = await getActiveAgentRun(user, currentTime);
    if (existingRun?.status === 'running') return null;
    const referenceAnchor = referenceTime != null && Number.isFinite(baseNow)
      ? new Date(baseNow).toISOString()
      : null;
    const run = await storage.createRun({
      userId,
      threadId,
      kind,
      waitingFor: {
        type: 'missing_fields',
        fields: [...missingFields],
        question: String(question || '').trim(),
      },
      context: {
        ...context,
        ...(referenceAnchor ? { referenceTime: referenceAnchor } : {}),
        ...(timezone ? { timezone } : {}),
      },
      expiresAt,
      // Keep the candidate out of active-run lookups until staging and retirement
      // have both succeeded. `failed` is an existing durable status, not a new FSM state.
      initialStatus: 'failed',
    });

    const drafts: readonly LegacyDraftAction[] = Array.isArray(partialActions) && partialActions.length > 0
      ? partialActions
      : (partialAction ? [partialAction] : []);

    const prepared: LegacyPreparedActionInput[] = drafts.map((draft, idx) => ({
      callId: `call-${idx + 1}`,
      domain: draft.domain,
      action: draft.action,
      targetId: null,
      targetName: typeof (draft.target || draft.content || draft.title) === 'string' ? String(draft.target || draft.content || draft.title) : null,
      payload: draft,
      status: 'prepared',
    }));

    const staged = await stagePendingActions(run.id, prepared);
    if (supersedesRunId || (existingRun && !preserveExistingActiveRun)) {
      let retired = false;
      try {
        retired = supersedesRunId
          ? await storage.cancelActiveInputRun({
            runId: supersedesRunId,
            expectedStatus: existingRun?.status || 'waiting_for_input',
            userId,
            threadId,
            now: currentTime,
          })
          : await storage.updateRunIfStatus({
            runId: existingRun!.id,
            userId,
            threadId,
            expectedStatus: existingRun!.status,
            nextStatus: 'cancelled',
            now: currentTime,
          });
      } catch (error) {
        // The candidate is already inert. Do not attempt a second cleanup write;
        // the retirement operation may have an unknown outcome.
        throw error;
      }
      if (!retired) {
        return null;
      }
    }
    let activated = false;
    try {
      activated = await storage.updateRunIfStatus({
        runId: run.id,
        userId,
        threadId,
        expectedStatus: 'failed',
        nextStatus: 'waiting_for_input',
        now: currentTime,
      });
    } catch (error) {
      // The activation write may have reached storage despite an error response.
      // Make one bounded fail-closed demotion attempt and preserve the staged payload.
      try {
        await storage.updateRunIfStatus({
          runId: run.id,
          userId,
          threadId,
          expectedStatus: 'waiting_for_input',
          nextStatus: 'failed',
          now: currentTime,
        });
      } catch { /* keep the activation outcome explicitly unknown */ }
      return {
        ...run,
        activationFailed: true,
        activationStatusUnknown: true,
        preparedActions: staged,
      };
    }
    if (!activated) {
      return {
        ...run,
        activationFailed: true,
        preparedActions: staged,
      };
    }
    await storage.recordEvent({
      runId: run.id,
      userId,
      threadId,
      eventType: 'run_created_waiting_input',
      factPayload: { kind, missingFields: [...missingFields], question, draftCount: drafts.length },
    });

    return {
      ...run,
      status: 'waiting_for_input',
      preparedActions: staged,
    };
  }

  /** Cancel the exact active input run only after its replacement has validated. */
  async function cancelSupersededInputRun(user: LegacyRunUser, runId: string | null | undefined, now: LegacyReferenceTime = new Date()): Promise<boolean> {
    if (!user || !runId) return false;
    const existing = await getActiveAgentRun(user, now);
    if (existing?.id !== runId || !['waiting_for_input', 'waiting_for_approval'].includes(existing.status)) return false;
    return storage.cancelActiveInputRun({
      expectedStatus: existing.status,
      runId,
      userId: resolveUserId(user),
      threadId: resolveThreadId(user),
      now,
    });
  }

  const formatActiveRunPrompt = (activeRun: ActiveRunPromptInput | null | undefined): string =>
    renderActiveRunPrompt(activeRun, continuationFieldKeys);

  return { getActiveAgentRun, createApprovalRun, createInputRun, cancelSupersededInputRun, formatActiveRunPrompt, claimPendingRun };
}

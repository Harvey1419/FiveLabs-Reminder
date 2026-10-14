import type { JsonObject } from '@templelabs/contracts';
export interface LegacyPreparedAction {
  readonly run_id: string; readonly call_id: string; readonly domain: string; readonly action: string;
  readonly target_id: string | null; readonly target_name: string | null; readonly payload: JsonObject;
  readonly status: 'prepared' | 'executed' | 'skipped' | 'failed'; readonly execution_fact: JsonObject | null;
}
export interface LegacyActiveRun {
  readonly id: string; readonly user_id: string; readonly thread_id: string; readonly status: string;
  readonly kind: string; readonly context: JsonObject; readonly waiting_for: JsonObject | null; readonly expires_at: string;
}
export interface LegacyActiveRunRuntime {
  getPreparedActions(runId: string): Promise<readonly LegacyPreparedAction[]>;
  updatePreparedAction(runId: string, callId: string, updates: JsonObject): Promise<JsonObject>;
  updateRun(runId: string, updates: JsonObject): Promise<JsonObject>;
  recordEvent(event: JsonObject): Promise<JsonObject>;
  claimRun(run: LegacyActiveRun, expectedStatus: string, context: LegacyExecutionContext, nextStatus?: string): Promise<boolean>;
  beforeWrite(call: LegacyDomainExecutionCall, actions: readonly LegacyPreparedAction[]): Promise<void>;
}
export interface LegacyDomainExecutionCall extends LegacyExecutionContext { readonly clarificationResolution?: boolean; readonly toolName: string; readonly params: JsonObject; readonly user?: { readonly id: string }; }
export interface LegacyActiveRunResult extends Record<string, unknown> { readonly success: boolean }

export interface LegacyExecutionContext {
  readonly user?: { readonly id?: string; readonly timezone?: string } | undefined;
  readonly language?: string | undefined;
  readonly timezone?: string | undefined;
  readonly referenceTime?: Date | string | undefined;
  readonly [key: string]: unknown;
}
export interface LegacyDomainCall {
  readonly valid?: boolean;
  readonly toolName?: string | undefined;
  readonly params?: JsonObject | undefined;
  readonly orchestrationOnly?: boolean;
  readonly error?: string;
  readonly errorCode?: string;
  readonly result?: JsonObject;
}
export interface LegacyExecutionDependencies {
  readonly toolNames: Readonly<{ MANAGE_PROJECT: string; MANAGE_ENTITY: string; MANAGE_REMINDER: string; MANAGE_TASK: string }>;
  readonly buildDomainCall: (payload: JsonObject, context: LegacyExecutionContext) => LegacyDomainCall;
  readonly mergePendingSchedule: (original: JsonObject[string] | undefined, delta: JsonObject[string] | undefined) => JsonObject[string];
  readonly pendingInputForValidation: (call: LegacyDomainCall, language: string | undefined) => { fields: string[]; question: string } | null;
  readonly createExecutionFact: (input: { toolName?: string | undefined; params?: JsonObject | undefined; result: JsonObject; callId: string; language?: string | undefined; timezone?: string | undefined }) => JsonObject;
  readonly updateWorkingMemoryFromFacts: (user: { readonly id: string }, facts: readonly JsonObject[]) => void;
  readonly executeTool: (call: LegacyDomainExecutionCall) => Promise<JsonObject>;
  readonly executionRuntime: LegacyActiveRunRuntime;
}
export interface ApprovalExecutionOptions {
  readonly run: LegacyActiveRun;
  readonly decision: string;
  readonly selectedCallIds?: readonly string[];
  readonly executionContext?: LegacyExecutionContext;
  readonly executeTool?: LegacyExecutionDependencies['executeTool'];
  readonly executionRuntime?: LegacyActiveRunRuntime;
}
export interface ContinuationExecutionOptions {
  readonly run: LegacyActiveRun;
  readonly suppliedFields?: JsonObject;
  readonly actionInputs?: readonly { readonly callId: string; readonly fields: JsonObject }[];
  readonly executionContext?: LegacyExecutionContext;
  readonly executeTool?: LegacyExecutionDependencies['executeTool'];
  readonly executionRuntime?: LegacyActiveRunRuntime;
}
function object(value: JsonObject[string] | undefined): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function strings(value: JsonObject[string] | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
/** Strict execution implementation. The host owns persistence, presentation and tool dispatch. */
export function createLegacyRunExecutor(dependencies: LegacyExecutionDependencies) {
  const { toolNames: TOOL_NAMES, buildDomainCall, mergePendingSchedule, pendingInputForValidation,
    createExecutionFact, updateWorkingMemoryFromFacts, executeTool, executionRuntime: legacyExecutionRuntime } = dependencies;
  function storedDomainCall(action: LegacyPreparedAction, executionContext: LegacyExecutionContext): LegacyDomainCall {
    const call = object(action.execution_fact?._domainCall);
    if (typeof call.toolName === 'string' && call.toolName && call.params && typeof call.params === 'object' && !Array.isArray(call.params)) return { toolName: call.toolName, params: call.params };
    return buildDomainCall(action.payload || {}, executionContext);
  }

  function approvedDomainCall(action: LegacyPreparedAction, context: LegacyExecutionContext): LegacyDomainCall {
    if (action.payload?.domain) return buildDomainCall(action.payload, context);
    // Compatibility with already persisted, fully resolved approval payloads.
    const names: Readonly<Record<string, string>> = {
      project: TOOL_NAMES.MANAGE_PROJECT, entity: TOOL_NAMES.MANAGE_ENTITY,
      reminder: TOOL_NAMES.MANAGE_REMINDER, task: TOOL_NAMES.MANAGE_TASK,
    };
    const toolName = names[action.domain] || 'orchestrator';
    return { valid: Boolean(names[action.domain]), toolName, params: action.payload };
  }

  function toolResultFromExecutionFact(executionFact: JsonObject): JsonObject {
    if (!executionFact || typeof executionFact !== 'object') return executionFact;
    const { _domainCall: _storedCall, ...toolResult } = executionFact;
    return toolResult;
  }

  function executionFactWithDomainCall(result: JsonObject, toolName: string, params: JsonObject): JsonObject {
    return {
      ...result,
      _domainCall: { toolName, params },
    };
  }

  async function observedRunResult(run: LegacyActiveRun, executionContext: LegacyExecutionContext, runtime: LegacyActiveRunRuntime): Promise<LegacyActiveRunResult> {
    if (executionContext.user?.id && run.user_id && String(executionContext.user.id) !== String(run.user_id)) {
      return { success: false, executed: false, facts: [], results: [], error: 'Request owner mismatch.' };
    }
    const actions = await runtime.getPreparedActions(run.id);
    const results = actions.filter(action => action.execution_fact).map(action => ({
      callId: action.call_id, result: toolResultFromExecutionFact(action.execution_fact!),
    }));
    const facts = actions.filter(action => action.execution_fact).map(action => {
      const call = storedDomainCall(action, executionContext);
      return createExecutionFact({ ...call, result: toolResultFromExecutionFact(action.execution_fact!), callId: action.call_id, language: executionContext.language, timezone: executionContext.timezone || executionContext.user?.timezone });
    });
    return { success: false, executed: false, status: 'not_acquired', results, facts,
      error: executionContext.language === 'en'
        ? 'This request is already being processed or is no longer pending. I did not repeat it.'
        : 'Esta solicitud ya se está procesando o dejó de estar pendiente. No la repetí.' };
  }

  async function executeApprovalDecision({
    run,
    decision, // 'approve_all' | 'approve_subset' | 'reject'
    selectedCallIds = [],
    executionContext = {},
    executeTool: injectedExecuteTool = executeTool,
    executionRuntime = legacyExecutionRuntime,
  }: ApprovalExecutionOptions): Promise<LegacyActiveRunResult> {
    const { getPreparedActions: getPreparedActionsFromDb, updatePreparedAction: updatePreparedActionInDb,
      updateRun: updateAgentRunInDb, recordEvent: recordExecutionEventInDb, claimRun: claimPendingRun,
      beforeWrite } = executionRuntime;
    const preparedActions = await getPreparedActionsFromDb(run.id);
    const threadId = run.thread_id;
    const userId = run.user_id;

    if (decision === 'reject') {
      if (!await claimPendingRun(run, 'waiting_for_approval', executionContext, 'cancelled')) return observedRunResult(run, executionContext, executionRuntime);
      for (const action of preparedActions) {
        await updatePreparedActionInDb(run.id, action.call_id, { status: 'skipped' });
      }
      await recordExecutionEventInDb({
        runId: run.id,
        userId,
        threadId,
        eventType: 'run_rejected_by_user',
        factPayload: {},
      });
      return {
        success: true,
        executed: false,
        status: 'cancelled',
        facts: [],
        message: 'Operación cancelada por el usuario.',
      };
    }

    if (!Array.isArray(preparedActions) || preparedActions.length === 0) {
      return {
        success: false,
        executed: false,
        status: run.status,
        executedCount: 0,
        results: [],
        facts: [],
        message: 'No durably prepared actions are available for approval.',
      };
    }

    const actionsToExecute = decision === 'approve_all'
      ? preparedActions
      : preparedActions.filter((a) => selectedCallIds.includes(a.call_id));

    if (decision === 'approve_subset' && selectedCallIds.some(id => !preparedActions.some(action => action.call_id === id))) {
      return { success: false, executed: false, facts: [], results: [], error: 'The selection contains an unknown prepared action.' };
    }

    if (actionsToExecute.length === 0) {
      return {
        success: false,
        executed: false,
        status: run.status,
        executedCount: 0,
        results: [],
        facts: [],
        message: 'No matching prepared actions found for selection.',
      };
    }

    const actionsToSkip = preparedActions.filter((a) => !actionsToExecute.includes(a));

    if (!await claimPendingRun(run, 'waiting_for_approval', executionContext)) return observedRunResult(run, executionContext, executionRuntime);

    for (const action of actionsToSkip) {
      await updatePreparedActionInDb(run.id, action.call_id, { status: 'skipped' });
    }

    const executedResults: { callId: string; result: JsonObject }[] = [];
    const executedFacts: JsonObject[] = [];
    const executionUser = (executionContext.user && typeof executionContext.user === 'object' && executionContext.user.id)
      ? { ...executionContext.user, id: executionContext.user.id }
      : { ...(typeof executionContext.user === 'object' ? executionContext.user : {}), id: userId || threadId };

    // Persist an unknown outcome before each external write. An interrupted
    // execution remains observable and is never automatically replayed.
    const executeApprovedTool = async (call: LegacyDomainExecutionCall, actions: readonly LegacyPreparedAction[]): Promise<JsonObject> => {
      await beforeWrite(call, actions);
      const fence = { success: false, outcome: 'unknown', errorCode: 'WRITE_OUTCOME_UNKNOWN',
        _domainCall: { toolName: call.toolName, params: call.params } };
      for (const action of actions) {
        const stored = await updatePreparedActionInDb(run.id, action.call_id, { status: 'failed', executionFact: fence });
        if (!stored) throw new Error('Could not persist approval write fence.');
      }
      try {
        const result = await injectedExecuteTool(call);
        if (!result || typeof result.success !== 'boolean') return fence;
        return executionFactWithDomainCall(result, call.toolName, call.params);
      } catch { return fence; }
    };

    // Group by domain for efficient execution if entity/project batch delete
    if (run.kind === 'entity_destructive_batch') {
      const isProject = actionsToExecute[0]?.domain === 'project';
      const targetTool = isProject ? TOOL_NAMES.MANAGE_PROJECT : TOOL_NAMES.MANAGE_ENTITY;
      const entityIds = actionsToExecute
        .map((a) => a.target_id)
        .filter(Boolean);

      if (entityIds.length > 0) {
        const deleteResult = await executeApprovedTool({
          ...executionContext,
          user: executionUser,
          toolName: targetTool,
          params: {
            action: 'delete',
            ...(isProject ? { projectIds: entityIds } : { entityIds }),
          },
          clarificationResolution: true,
        }, actionsToExecute);

        const fact = createExecutionFact({
          toolName: targetTool,
          params: { action: 'delete', ...(isProject ? { projectIds: entityIds } : { entityIds }) },
          result: deleteResult,
          callId: 'approval_exec',
          language: executionContext.language || 'es',
          timezone: executionContext.timezone || executionContext.user?.timezone,
        });
        executedFacts.push(fact);

        for (const action of actionsToExecute) {
          await updatePreparedActionInDb(run.id, action.call_id, {
            status: deleteResult.success ? 'executed' : 'failed',
            executionFact: deleteResult,
          });
          executedResults.push({ callId: action.call_id, result: deleteResult });
        }
      }
    } else {
      // Generic action-by-action dispatch
      for (const action of actionsToExecute) {
        const call = approvedDomainCall(action, executionContext);
        const toolName = call.toolName || 'orchestrator';
        const toolResult = call.valid ? await executeApprovedTool({
          ...executionContext,
          user: executionUser,
          toolName,
          params: call.params || {},
          clarificationResolution: true,
        }, [action]) : { success: false, errorCode: 'INVALID_APPROVED_ACTION', error: executionContext.language === 'en' ? 'The approved action is invalid; it was not executed.' : 'La acción aprobada no es válida; no se ejecutó.' };

        const fact = createExecutionFact({
          toolName,
          params: call.params || {},
          result: toolResult,
          callId: action.call_id,
          language: executionContext.language || 'es',
          timezone: executionContext.timezone || executionContext.user?.timezone,
        });
        executedFacts.push(fact);

        await updatePreparedActionInDb(run.id, action.call_id, {
          status: toolResult.success ? 'executed' : 'failed',
          executionFact: toolResult,
        });
        executedResults.push({ callId: action.call_id, result: toolResult });
        if (toolResult.outcome === 'unknown') break;
      }
    }

    const allSucceeded = executedResults.length > 0 && executedResults.every((r) => r.result?.success === true && r.result.partialSuccess !== true && r.result.complete !== false && r.result.outcome !== 'unknown');
    const finalStatus = allSucceeded ? 'completed' : 'failed';

    await updateAgentRunInDb(run.id, { status: finalStatus });
    await recordExecutionEventInDb({
      runId: run.id,
      userId,
      threadId,
      eventType: 'run_approval_executed',
      factPayload: { decision, executedCount: executedResults.length, status: finalStatus },
    });

    updateWorkingMemoryFromFacts(executionUser, executedFacts);

    return {
      success: allSucceeded,
      executed: true,
      status: finalStatus,
      executedCount: executedResults.length,
      results: executedResults,
      facts: executedFacts,
    };
  }

  /**
   * Resume a suspended run waiting for input with structured delta fields.
   */
  async function executeContinuationDecision({
    run,
    suppliedFields = {},
    actionInputs = [],
    executionContext = {},
    executeTool: injectedExecuteTool = executeTool,
    executionRuntime = legacyExecutionRuntime,
  }: ContinuationExecutionOptions): Promise<LegacyActiveRunResult> {
    const { getPreparedActions: getPreparedActionsFromDb, updatePreparedAction: updatePreparedActionInDb,
      updateRun: updateAgentRunInDb, recordEvent: recordExecutionEventInDb, claimRun: claimPendingRun,
      beforeWrite } = executionRuntime;
    const preparedActions = await getPreparedActionsFromDb(run.id);
    if (preparedActions.length === 0) {
      return { success: false, error: 'No prepared actions found in run.' };
    }
    const inputIds = new Set(actionInputs.map(input => input.callId));
    if (inputIds.size !== actionInputs.length || actionInputs.some(input => !preparedActions.some(action => action.call_id === input.callId && action.status === 'prepared'))) {
      return { success: false, executed: false, error: executionContext.language === 'en' ? 'I could not match that change to a pending action.' : 'No pude asociar ese cambio a una acción pendiente.' };
    }
    if (!await claimPendingRun(run, 'waiting_for_input', executionContext)) return observedRunResult(run, executionContext, executionRuntime);

    const userId = run.user_id;
    const threadId = run.thread_id;
    const executionUser = (executionContext.user && typeof executionContext.user === 'object' && executionContext.user.id)
      ? { ...executionContext.user, id: executionContext.user.id }
      : { ...(typeof executionContext.user === 'object' ? executionContext.user : {}), id: userId || threadId };

    const executedResults: { callId: string; result: JsonObject }[] = [];
    const executedFacts: JsonObject[] = [];
    let allSucceeded = true;
    const pendingInputs: { fields: string[]; question: string }[] = [];

    for (const action of preparedActions) {
      if (action.status === 'executed' || action.status === 'skipped') {
        if (action.status === 'executed' && action.execution_fact) {
          const toolCall = storedDomainCall(action, executionContext);
          const result = toolResultFromExecutionFact(action.execution_fact!);
          executedFacts.push(createExecutionFact({
            toolName: toolCall.toolName,
            params: toolCall.params,
            result,
            callId: action.call_id,
            language: executionContext.language || 'es',
            timezone: executionContext.timezone || executionContext.user?.timezone,
          }));
          executedResults.push({ callId: action.call_id, result });
        }
        continue;
      }
      if (action.status === 'failed') {
        allSucceeded = false;
        if (action.execution_fact) {
          const toolCall = storedDomainCall(action, executionContext);
          const result = toolResultFromExecutionFact(action.execution_fact!);
          const failedFact = createExecutionFact({
            toolName: toolCall.toolName,
            params: toolCall.params,
            result,
            callId: action.call_id,
            language: executionContext.language || 'es',
            timezone: executionContext.timezone || executionContext.user?.timezone,
          });
          executedFacts.push(failedFact);
          executedResults.push({ callId: action.call_id, result });
        }
        if (action.execution_fact?.outcome === 'unknown') break;
        continue;
      }

      const delta = actionInputs.length ? (actionInputs.find(input => input.callId === action.call_id)?.fields || {}) : suppliedFields;
      const missingFields = strings(action.payload?.missingFields || run.waiting_for?.fields);
      const mergedPayload = {
        ...action.payload,
        ...delta,
      };

      // Protect draft-specific content/title from being overwritten by a blanket suppliedFields
      if (!actionInputs.length && action.payload?.content && !missingFields.includes('content')) {
        mergedPayload.content = action.payload.content;
      }
      if (!actionInputs.length && action.payload?.title && !missingFields.includes('title') && !missingFields.includes('content')) {
        mergedPayload.title = action.payload.title;
      }
      if (action.target_name && !mergedPayload.content && !mergedPayload.title) {
        mergedPayload.content = action.target_name;
      }

      if (action.payload?.schedule || delta.schedule) {
        mergedPayload.schedule = mergePendingSchedule(
          action.payload?.schedule,
          delta.schedule
        );
      }

      const inheritedScheduleDate = ['calendar_date_time', 'weekday_time', 'relative_day_time'].includes(String(object(action.payload?.schedule).kind))
        && (object(delta.schedule).kind === 'local_time'
          || object(delta.schedule).kind === 'inherit_context'
          || !delta.schedule)
        && Number.isFinite(new Date(typeof run.context?.referenceTime === 'string' ? run.context.referenceTime : NaN).getTime());
      const actionExecutionContext = {
        ...executionContext,
        ...(inheritedScheduleDate && run.context?.timezone ? { timezone: String(run.context.timezone) } : {}),
        ...(inheritedScheduleDate ? { referenceTime: new Date(String(run.context.referenceTime)) } : {}),
      };
      const prepared = buildDomainCall(mergedPayload, actionExecutionContext);
      if (!prepared.valid || prepared.orchestrationOnly || !prepared.toolName || !prepared.params) {
        const pending = pendingInputForValidation(prepared, executionContext.language);
        if (pending) pendingInputs.push(pending);
        const result = {
          success: false,
          requiresClarification: Boolean(pending),
          error: pending?.question || prepared.error || prepared.result?.error || 'The resumed action is not executable.',
          errorCode: prepared.errorCode || 'INVALID_RESUMED_ACTION',
        };
        const fact = createExecutionFact({
          toolName: prepared.toolName || 'orchestrator',
          params: prepared.params || {},
          result,
          callId: action.call_id,
          language: executionContext.language || 'es',
          timezone: executionContext.timezone || executionContext.user?.timezone,
        });
        executedFacts.push(fact);
        allSucceeded = false;
        await updatePreparedActionInDb(run.id, action.call_id, {
          status: pending ? 'prepared' : 'failed',
          payload: { ...mergedPayload, ...(pending ? { missingFields: pending.fields } : {}) },
          executionFact: result,
        });
        executedResults.push({ callId: action.call_id, result });
        continue;
      }

      const { toolName, params } = prepared;
      await beforeWrite({ ...actionExecutionContext, user: executionUser, toolName, params }, [action]);
      const writeFence = {
        success: false,
        outcome: 'unknown',
        errorCode: 'WRITE_OUTCOME_UNKNOWN',
        error: 'The action may have been applied; it will not be replayed automatically.',
        _domainCall: { toolName, params },
      };
      const fencedAction = await updatePreparedActionInDb(run.id, action.call_id, {
        status: 'failed',
        executionFact: writeFence,
      });
      if (!fencedAction) {
        throw new Error('Could not persist the write fence; the action was not executed.');
      }

      let result;
      try {
        result = await injectedExecuteTool({
          ...actionExecutionContext,
          user: executionUser,
          toolName,
          params,
          clarificationResolution: true,
        });
        if (!result || typeof result.success !== 'boolean') {
          throw new Error('The tool returned no observable execution result.');
        }
      } catch (error) {
        const unknownResult = {
          success: false,
          outcome: 'unknown',
          errorCode: 'UNKNOWN_WRITE_OUTCOME',
          error: error instanceof Error ? error.message : 'The tool outcome could not be observed.',
          _domainCall: { toolName, params },
        };
        const fact = createExecutionFact({
          toolName,
          params,
          result: toolResultFromExecutionFact(unknownResult),
          callId: action.call_id,
          language: executionContext.language || 'es',
          timezone: executionContext.timezone || executionContext.user?.timezone,
        });
        executedFacts.push(fact);
        allSucceeded = false;
        await updatePreparedActionInDb(run.id, action.call_id, {
          status: 'failed',
          executionFact: unknownResult,
        });
        executedResults.push({ callId: action.call_id, result: toolResultFromExecutionFact(unknownResult) });
        break;
      }

      const fact = createExecutionFact({
        toolName,
        params,
        result,
        callId: action.call_id,
        language: executionContext.language || 'es',
        timezone: executionContext.timezone || executionContext.user?.timezone,
      });
      executedFacts.push(fact);

      const unknownWriteOutcome = result.outcome === 'unknown'
        || result.errorCode === 'UNKNOWN_WRITE_OUTCOME';
      const isSuccess = result.success === true && !unknownWriteOutcome;
      if (!isSuccess || result.partialSuccess === true || result.complete === false) allSucceeded = false;
      const persistedResult = executionFactWithDomainCall(
        unknownWriteOutcome ? { ...result, outcome: 'unknown' } : result,
        toolName,
        params,
      );

      await updatePreparedActionInDb(run.id, action.call_id, {
        status: isSuccess ? 'executed' : 'failed',
        executionFact: persistedResult,
      });
      executedResults.push({ callId: action.call_id, result });
      if (unknownWriteOutcome) break;
    }

    const finalStatus = executedFacts.some(fact => fact.outcome === 'unknown') ? 'failed' : pendingInputs.length ? 'waiting_for_input'
      : (allSucceeded && executedResults.length > 0) ? 'completed' : 'failed';

    await updateAgentRunInDb(run.id, {
      status: finalStatus,
      ...(pendingInputs.length ? { waitingFor: {
        fields: [...new Set(pendingInputs.flatMap(input => input.fields))],
        question: [...new Set(pendingInputs.map(input => input.question))].join('\n'),
      } } : {}),
    });
    await recordExecutionEventInDb({
      runId: run.id,
      userId: run.user_id,
      threadId: run.thread_id,
      eventType: 'run_continuation_executed',
      factPayload: { success: allSucceeded, executedCount: executedResults.length, status: finalStatus },
    });

    updateWorkingMemoryFromFacts(executionUser, executedFacts);

    return {
      success: allSucceeded,
      executed: allSucceeded,
      status: finalStatus,
      results: executedResults,
      result: executedResults[0]?.result,
      fact: executedFacts[0],
      facts: executedFacts,
      domain: preparedActions[0]?.domain || 'reminder',
    };
  }


  return { executeApprovalDecision, executeContinuationDecision };
}

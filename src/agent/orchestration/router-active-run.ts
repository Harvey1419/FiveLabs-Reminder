import type { LegacyAgentRunWithActions, LegacyStatusChange } from '../core/active-run-lifecycle.js';
import type { ValidatedTurnContext } from '../contracts/turn-context-contract.js';
import { APPROVAL_DECISION_SCHEMA, CONTINUATION_DECISION_SCHEMA, validateApprovalDecision, validateContinuationDecision,
  type ParsedContinuationDecision } from '../contracts/run-decision-contracts.js';
import { parseIntentArguments } from '../contracts/intent-validator.js';
import { historyContextForModel, currentTurnMessages, type ModelContextMessage } from './router-model-context.js';

interface ActiveRunUser extends Record<string, unknown> { id?: string; phone_number?: string | null }
interface RunExecutionContext { user: ActiveRunUser; language?: string; isPro?: boolean; timezone?: string;
  referenceTime?: Date; correlationId?: unknown }
export interface RouterRunExecutionResult<Fact> {
  success?: boolean; executed?: boolean; status?: string; executedCount?: number;
  facts?: Fact[]; fact?: Fact; domain?: string; error?: unknown;
}
export interface RouterActiveRunResponse<Fact, Entities> {
  intent: string; language: string; executionFacts: Fact[]; confirmation?: unknown;
  entities?: Entities; ctaUrl?: null; ctaHeader?: null; ctaButtonText?: null;
  plan?: Record<string, unknown>; memoryDisposition?: 'skip_operational';
}
export interface RouterActiveRunDependencies<Fact, Entities> {
  getActiveAgentRun(user: string | ActiveRunUser, now: Date): Promise<LegacyAgentRunWithActions | null>;
  formatActiveRunPrompt(run: LegacyAgentRunWithActions): string;
  callChatCompletion(messages: ModelContextMessage[], options: {
    max_tokens: number; correlationId: unknown; tools: null; toolChoice: 'none';
    responseFormat: { type: 'json_schema'; json_schema: { name: string; strict: true; schema: unknown } };
    returnMessage: true; purpose: 'approval_decision' | 'continuation_decision'; language: string;
    validateStructuredContent(content: unknown): ReturnType<typeof validateApprovalDecision> | ReturnType<typeof validateContinuationDecision>;
  }): Promise<{ content?: unknown } | null>;
  executeApprovalDecision(input: { run: LegacyAgentRunWithActions; decision: string | null;
    selectedCallIds?: string[]; executionContext: RunExecutionContext }): Promise<RouterRunExecutionResult<Fact>>;
  executeContinuationDecision(input: { run: LegacyAgentRunWithActions; suppliedFields: Record<string, unknown>;
    actionInputs?: ParsedContinuationDecision['actionInputs']; executionContext: RunExecutionContext }): Promise<RouterRunExecutionResult<Fact>>;
  updateAgentRunIfStatusFromDb(input: LegacyStatusChange): Promise<boolean>;
  composeExecutionReply(facts: Fact[] | undefined, language: string): string;
  conversationStateEntities(user: ActiveRunUser, extra?: Record<string, unknown>): Entities;
  mutationReceiptsFromFacts(facts: Fact[]): unknown;
  logger: Pick<Console, 'warn'>;
}
export interface RouterActiveRunInput {
  user: ActiveRunUser; phoneNumber?: string | null | undefined; requestReferenceTime: Date; requestId: unknown;
  readonly language: string; readonly timezone: string; isPro: boolean;
  prompt: string; pastTurns: ModelContextMessage[]; messageText: unknown; currentUserText: string;
  messages: ModelContextMessage[]; options?: { correlationId?: unknown };
  applyDecisionContext(decision: ValidatedTurnContext): Promise<boolean>;
}
export type RouterActiveRunOutcome<Fact, Entities> =
  | { handled: true; response: RouterActiveRunResponse<Fact, Entities> }
  | { handled: false; supersedesRunId: string | null; preserveExistingActiveRun: boolean };

/** Pending decisions use the shared strict contracts; execution and ownership remain host responsibilities. */
export function createRouterActiveRun<Fact, Entities>(dependencies: RouterActiveRunDependencies<Fact, Entities>) {
  const { getActiveAgentRun, formatActiveRunPrompt, callChatCompletion, executeApprovalDecision,
    executeContinuationDecision, updateAgentRunIfStatusFromDb, composeExecutionReply,
    conversationStateEntities, mutationReceiptsFromFacts, logger: console } = dependencies;
  async function resolveRouterActiveRun(input: RouterActiveRunInput): Promise<RouterActiveRunOutcome<Fact, Entities>> {
    const { user, phoneNumber, requestReferenceTime, requestId, isPro, prompt, pastTurns,
      messageText, currentUserText, messages, options, applyDecisionContext } = input;
    let { language, timezone } = input;
    const finish = (response: RouterActiveRunResponse<Fact, Entities>): RouterActiveRunOutcome<Fact, Entities> => ({ handled: true, response });
    let supersedesRunId: string | null = null;
    let preserveExistingActiveRun = false;
    const activeAgentRun = await getActiveAgentRun(phoneNumber || user, requestReferenceTime);
    if (activeAgentRun?.status === 'running') return finish({
      intent: 'clarification', language, executionFacts: [], memoryDisposition: 'skip_operational',
      confirmation: language === 'en' ? 'Your previous request is still being processed. I will not repeat its actions.' : 'Tu solicitud anterior todavía se está procesando. No repetiré sus acciones.',
    });
    if (activeAgentRun && (activeAgentRun.status === 'waiting_for_approval' || activeAgentRun.status === 'waiting_for_input')) {
      const isApproval = activeAgentRun.status === 'waiting_for_approval';
      const schema = isApproval ? APPROVAL_DECISION_SCHEMA : CONTINUATION_DECISION_SCHEMA;
      const runPrompt = formatActiveRunPrompt(activeAgentRun);

      const runMessages = [
        { role: 'system', content: `${prompt}\n\n${runPrompt}` },
        ...historyContextForModel(pastTurns),
        ...currentTurnMessages(messageText, currentUserText),
      ];

      let runModelResponse: { content?: unknown } | null = null;
      try {
        runModelResponse = await callChatCompletion(runMessages, {
          max_tokens: 4096,
          correlationId: options?.correlationId,
          tools: null,
          toolChoice: 'none',
          responseFormat: {
            type: 'json_schema',
            json_schema: {
              name: isApproval ? 'hermes_approval_decision' : 'hermes_continuation_decision',
              strict: true,
              schema,
            },
          },
          returnMessage: true,
          purpose: isApproval ? 'approval_decision' : 'continuation_decision',
          language,
          validateStructuredContent: (content) => {
            const parsed = parseIntentArguments(content);
            return isApproval ? validateApprovalDecision(parsed) : validateContinuationDecision(parsed);
          },
        });
      } catch (err) {
        console.warn(`[router req=${requestId}] active run model call failed:`, (err as { message?: unknown }).message);
      }

      let resolvedRelation: string | null = null;
      if (runModelResponse?.content) {
        const parsedArgs = parseIntentArguments(runModelResponse.content);
        const validation = isApproval
          ? { kind: 'approval' as const, ...validateApprovalDecision(parsedArgs) }
          : { kind: 'continuation' as const, ...validateContinuationDecision(parsedArgs) };

        if (validation.valid) {
          const contextApplied = await applyDecisionContext(validation.decision);
          language = input.language; timezone = input.timezone;
          if (!contextApplied) return finish({ language, intent: 'clarification', executionFacts: [] });
          resolvedRelation = validation.decision.relation;
          const { relation } = validation.decision;
          if (validation.kind === 'approval') {
            const decision = validation.decision;
            if (relation === 'approval') {
              const execResult = await executeApprovalDecision({
                run: activeAgentRun,
                decision: decision.decision,
                selectedCallIds: decision.selectedCallIds,
                executionContext: { user, language, isPro, timezone, referenceTime: requestReferenceTime, correlationId: requestId },
              });

              let reply: unknown = composeExecutionReply(execResult.facts, language);
              const primaryDomain = activeAgentRun.preparedActions?.[0]?.domain || 'entity';
              if (execResult.status === 'cancelled') reply = language === 'en' ? 'Operation cancelled.' : 'Operación cancelada.';
              if (!reply && (!execResult.executed || !execResult.success)) {
                reply = language === 'en'
                  ? 'No pending actions could be executed.'
                  : 'No se pudo completar la operación pendiente. Por favor intenta nuevamente.';
              } else if (!reply) {
                reply = decision.reply || (decision.decision === 'reject'
                  ? (language === 'en' ? 'Operation cancelled.' : 'Operación cancelada.')
                  : (language === 'en'
                    ? `Done — processed ${execResult.executedCount || 0} ${primaryDomain}s.`
                    : `Listo — procesé ${execResult.executedCount || 0} ${primaryDomain === 'reminder' ? 'recordatorios' : (primaryDomain === 'task' ? 'tareas' : 'proyectos')}.`));
              }

              return finish({
                intent: primaryDomain,
                entities: conversationStateEntities(user, { _turnMetadata: { kind: 'operational_result', mutationReceipts: mutationReceiptsFromFacts(execResult.facts || []) } }),
                language,
                confirmation: reply,
                ctaUrl: null, ctaHeader: null, ctaButtonText: null,
                plan: { type: 'approval_decision', decision: decision.decision },
                executionFacts: execResult.facts || [],
                memoryDisposition: 'skip_operational',
              });
            } else if (relation === 'cancel') {
              const cancellation = await executeApprovalDecision({
                run: activeAgentRun,
                decision: 'reject',
                executionContext: { user },
              });

              const reply = cancellation.status === 'cancelled'
                ? (language === 'en' ? 'Operation cancelled.' : 'Operación cancelada.')
                : (language === 'en' ? 'I could not cancel the pending operation; its status has changed.' : 'No pude cancelar la operación pendiente; su estado cambió.');
              return finish({
                intent: 'chat',
                entities: conversationStateEntities(user),
                language,
                confirmation: reply,
                ctaUrl: null, ctaHeader: null, ctaButtonText: null,
                plan: { type: 'cancelled_run' },
                executionFacts: [],
                memoryDisposition: 'skip_operational',
              });
            }
            // Unrelated operations keep the suspended draft; explicit replacements
            // flow through the canonical intent parser before the old run is cancelled.
            if (relation === 'unrelated') preserveExistingActiveRun = true;
            if (relation === 'supersede') supersedesRunId = activeAgentRun.id;
          } else {
            const decision = validation.decision;
            // is continuation (waiting_for_input)
            if (relation === 'resume') {
              const execResult = await executeContinuationDecision({
                run: activeAgentRun,
                suppliedFields: decision.suppliedFields,
                actionInputs: decision.actionInputs,
                executionContext: { user, language, isPro, timezone, referenceTime: requestReferenceTime, correlationId: requestId },
              });
              if (execResult.success) {
                let reply: unknown = composeExecutionReply(execResult.facts || (execResult.fact ? [execResult.fact] : []), language);
                if (!reply) {
                  reply = decision.reply || (language === 'en' ? 'Reminder created.' : 'Recordatorio creado.');
                }
                return finish({
                  intent: execResult.domain || 'clarification',
                  entities: conversationStateEntities(user, { _turnMetadata: { kind: 'operational_result', mutationReceipts: mutationReceiptsFromFacts(execResult.facts || (execResult.fact ? [execResult.fact] : [])) } }),
                  language,
                  confirmation: reply,
                  ctaUrl: null, ctaHeader: null, ctaButtonText: null,
                  plan: { type: 'continuation_decision' },
                  executionFacts: execResult.facts || (execResult.fact ? [execResult.fact] : []),
                  memoryDisposition: 'skip_operational',
                });
              } else {
                const reply = composeExecutionReply(execResult.facts || (execResult.fact ? [execResult.fact] : []), language)
                  || execResult.error || (language === 'en' ? 'I could not complete the pending request.' : 'No pude completar la solicitud pendiente.');
                return finish({
                  intent: execResult.domain || 'clarification',
                  entities: conversationStateEntities(user),
                  language,
                  confirmation: reply,
                  ctaUrl: null, ctaHeader: null, ctaButtonText: null,
                  plan: { type: 'continuation_decision_failed' },
                  executionFacts: execResult.facts || (execResult.fact ? [execResult.fact] : []),
                  memoryDisposition: 'skip_operational',
                });
              }
            } else if (relation === 'cancel') {
              const cancelled = await updateAgentRunIfStatusFromDb({ runId: activeAgentRun.id, userId: activeAgentRun.user_id, threadId: activeAgentRun.thread_id, expectedStatus: 'waiting_for_input', nextStatus: 'cancelled', now: requestReferenceTime });

              const reply = cancelled
                ? (language === 'en' ? 'Operation cancelled.' : 'Operación cancelada.')
                : (language === 'en' ? 'I could not cancel the pending operation; its status has changed.' : 'No pude cancelar la operación pendiente; su estado cambió.');
              return finish({
                intent: 'chat',
                entities: conversationStateEntities(user),
                language,
                confirmation: reply,
                ctaUrl: null, ctaHeader: null, ctaButtonText: null,
                plan: { type: 'cancelled_run' },
                executionFacts: [],
                memoryDisposition: 'skip_operational',
              });
            }
            if (relation === 'supersede') supersedesRunId = activeAgentRun.id;
            if (relation === 'unrelated') preserveExistingActiveRun = true;
          }
        }
      }

      // Architectural safety gate:
      // If the model call failed or produced an unparseable response, never fall through
      // to execute a normal turn while a sensitive run is pending.
      // However, if the model explicitly resolved relation === 'unrelated', the user
      // intentionally changed the topic, so falling through to normal execution is expected.
      if (!resolvedRelation) {
        const pendingKind = activeAgentRun.status === 'waiting_for_approval' ? 'approval' : 'input';
        console.warn(`[router req=${requestId}] active run model call failed or invalid — blocking normal turn. kind=${pendingKind} runId=${activeAgentRun.id}`);
        const safeFallback = language === 'en'
          ? 'I could not process your response to the pending action. Could you send it again?'
          : 'No pude procesar tu respuesta a la acción pendiente. ¿Puedes enviarla de nuevo?';
        return finish({
          intent: 'clarification',
          entities: conversationStateEntities(user, { _turnMetadata: { kind: 'active_run_unresolved' } }),
          language,
          confirmation: safeFallback,
          ctaUrl: null,
          ctaHeader: null,
          ctaButtonText: null,
          plan: { type: 'active_run_unresolved', pendingKind, runId: activeAgentRun.id },
          executionFacts: [],
          memoryDisposition: 'skip_operational',
        });
      }
    }

    if (supersedesRunId) {
      messages[0]!.content += `\nReplace the pending request using the current user's correction and this draft as context. Return canonical TurnIntent. Preserve unchanged fields and resolve every requested action. Executed actions are observed effects: do not recreate them; use an explicit update/cancel when requested.\n<pending_draft>${JSON.stringify({ kind: activeAgentRun!.kind, context: activeAgentRun!.context, actions: activeAgentRun!.preparedActions })}</pending_draft>`;
    }

    return { handled: false, supersedesRunId, preserveExistingActiveRun };
  }
  return { resolveRouterActiveRun };
}

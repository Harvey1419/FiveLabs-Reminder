import { productivityBudget, productivityDecisionPolicy } from './productivity-budget.js';
import { nativeProductivityPolicy } from './native-productivity-policy.js';
import { recentToolScope } from './recent-tool-scope.js';
import { scheduleProactiveMemory } from './proactive-memory.js';
import { explicitMemoryIntent } from '../../features/memory/explicit-intent.js';
import { createMemoryDomainPort } from './memories-domain.js';
import { readTurnMediaInput, mediaAllowedTools } from '../../shared/turn-media-input.js';
import { readPersonalContext } from './personal-context.js';
import { retrieveRelevantMemories, retrieveStandingPreferences } from '../../features/memory/service.js';
import { z } from 'zod';
import { estimateBoundedInput, type OpenRouterAttempt } from '@templelabs/ai';
import { aiTranscriptSchema, jsonObjectSchema } from '@templelabs/contracts';
import { ProductivityTurnRunner, type AgentLoopOptions } from '@templelabs/agent-core';
import { createTaskTools, createCalendarTools, createReminderTools, createMemoryTools, createAgendaTools, createProjectTools, createSubscriptionTools, createEntityTools, createAdminTools, ToolRegistry } from '@templelabs/tools';
import type { ProductivityConversation } from '@templelabs/contracts';
import { DurableProductivityAssistant, type ProductivityDeliveryPort } from './durable-productivity-assistant.js';
import { recoverProductivityStoredTurn } from './productivity-state-recovery.js';
import { createConfiguredAIProvider } from './configured-ai-provider.js';
import { createTaskDomainPort } from './tasks-domain.js';
import { createCalendarDomainPort } from './calendar-domain.js';
import { createReminderDomainPort } from './reminders-domain.js';
import { createProjectDomainPort } from './projects-domain.js';
import { createSubscriptionDomainPort } from './subscriptions-domain.js';
import { createEntityDomainPort } from './entities-domain.js';
import { createAdminDomainPort } from './admin-domain.js';
import { getUserSubscription, hasProAccess } from '../../infrastructure/database/index.js';
import { isAdminUser } from '../../shared/auth.js';
import { detectLanguageFromText } from '../../shared/language-detection.js';
import type { CanaryAdmission } from '../../agent/orchestration/canary-router.js';
import { recordV2Delivery } from './canary-delivery-receipt.js';

function telemetry(event: string, data: unknown): void {
  try { console.info(`[agent-core-v2] ${event}`, JSON.stringify(data)); } catch { /* Logging cannot invalidate a committed effect. */ }
}

/** V2 transport result has no dependency on the legacy router's response union. */
export interface V2ProductivityRouteResult {
  readonly confirmation: string;
  readonly intent: 'query' | 'chat';
  readonly language: 'es' | 'en';
  readonly entities: Record<string, unknown>;
  readonly executionFacts: [];
  readonly memoryDisposition?: 'skip_operational';
}
type Result = V2ProductivityRouteResult;
const userSchema = z.object({ id: z.string().min(1), phone_number: z.string().optional(), timezone: z.string().optional(), locale: z.string().optional(), display_name: z.string().nullish() });

/** The durable V2 composition owns delivery; the webhook must not send its reply a second time. */
export async function routeCanaryProductivity(text: string, rawUser: unknown, options: Record<string, unknown>, admission: CanaryAdmission): Promise<Result> {
  const nativeTools = options.agentCoreNativeTools === undefined
    ? process.env.AGENT_CORE_NATIVE_TOOLS === 'true' : options.agentCoreNativeTools === true;
  const loopPolicy = nativeTools ? nativeProductivityPolicy : { ...productivityBudget, ...productivityDecisionPolicy };
  const parsed = userSchema.parse(rawUser);
  const user = { id: parsed.id, ...(parsed.phone_number ? { phone_number: parsed.phone_number } : {}),
    ...(parsed.timezone ? { timezone: parsed.timezone } : {}), ...(parsed.locale ? { locale: parsed.locale } : {}) };
  const delivery = options.agentCoreDelivery as ProductivityDeliveryPort;
  const media = readTurnMediaInput(options.agentCoreMedia, admission.context, options.inputModality);
  if (options.agentCoreMedia !== undefined && !media) throw new Error('V2_INVALID_MEDIA_INPUT');
  const authoredText = media?.userText ?? (typeof options.currentUserText === 'string' ? options.currentUserText : text);
  // Prevent an older pending source from being relearned after a newer forget request.
  if (explicitMemoryIntent(authoredText, 'forget')) scheduleProactiveMemory.cancel?.(user.id);
  const detected = detectLanguageFromText(authoredText);
  const language = detected === 'en' || detected === 'es' ? detected : admission.context.language;
  const [subscription, personalContext] = await Promise.all([getUserSubscription(user.id),
    readPersonalContext(user.id, authoredText, parsed.display_name ?? undefined, { memories: media && !authoredText.trim() ? async () => [] : retrieveRelevantMemories, preferences: retrieveStandingPreferences })]);
  const capabilities = new Set(['tasks.read', 'tasks.create', 'tasks.update', 'tasks.complete', 'tasks.delete',
    'calendar.read', 'calendar.create', 'calendar.connect', 'calendar.update', 'calendar.delete', 'reminders.read', 'reminders.create', 'reminders.update', 'reminders.acknowledge', 'reminders.cancel', 'memories.read', 'memories.save', 'memories.forget',
    'projects.read', 'projects.create', 'projects.update', 'projects.delete',
    'subscriptions.read', 'subscriptions.checkout', 'subscriptions.cancel',
    'entities.read', 'entities.create', 'entities.update', 'entities.delete']);
  if (hasProAccess(subscription)) capabilities.add('reminders.pro');
  if (isAdminUser(user)) capabilities.add('admin.metrics');
  const previous: ProductivityConversation | undefined = admission.handoff ?? (admission.prior
    ? recoverProductivityStoredTurn(admission.prior, user.id) : undefined);
  const memoryOrder = previous?.memoryReferenceOrder ?? previous?.referenceOrder?.filter(reference => reference.domain === 'memories').map(reference => reference.id);
  const observedMemories = memoryOrder?.flatMap(id => previous?.memories?.filter(record => record.id === id) ?? []) ?? previous?.memories ?? [];
  const definitions = [
    ...createTaskTools(createTaskDomainPort(user)), ...createCalendarTools(createCalendarDomainPort(user)),
    ...createReminderTools(createReminderDomainPort(user)),
    ...createMemoryTools(createMemoryDomainPort(user, authoredText, { previousRecords: observedMemories })),
    ...createProjectTools(createProjectDomainPort(user)),
    ...createSubscriptionTools(createSubscriptionDomainPort(user)),
    ...createEntityTools(createEntityDomainPort(user)),
    ...(isAdminUser(user) ? createAdminTools(createAdminDomainPort(user)) : []),
  ];
  const allowed = media ? new Set(mediaAllowedTools(media)) : null;
  if (allowed && explicitMemoryIntent(authoredText, 'save')) allowed.add('memory_save');
  if (allowed && explicitMemoryIntent(authoredText, 'forget')) { allowed.add('memory_read'); allowed.add('memory_forget'); }
  if (allowed) for (const tool of definitions) if (!allowed.has(tool.specification.name)) capabilities.delete(tool.requiredCapability);
  const context = { ...admission.context, capabilities, language };
  // Composite reads reuse exactly the capability-filtered atomic registry.
  if (!media && ['calendar.read', 'tasks.read', 'reminders.read'].some(capability => capabilities.has(capability))) capabilities.add('agenda.read');
  const registry = new ToolRegistry([...definitions, ...createAgendaTools(new ToolRegistry(definitions))]);
  const writePolicy = z.custom<NonNullable<AgentLoopOptions['authorizeWrite']>>(value => typeof value === 'function')
    .safeParse(options.agentCoreAuthorizeWrite);
  const attempts: OpenRouterAttempt[] = [];
  const provider = createConfiguredAIProvider({ estimateInputTokens: estimateBoundedInput,
    onAttempt: attempt => {
      attempts.push(attempt);
      telemetry('provider_attempt', { runId: context.runId, requestId: context.requestId, ...attempt });
    } });
  const requestSchema = z.object({ messages: aiTranscriptSchema, tools: z.array(z.object({ name: z.string(), description: z.string(), inputSchema: jsonObjectSchema })) });
  const assistant = new DurableProductivityAssistant(new ProductivityTurnRunner(provider, registry, { continuation: 'observation_driven',
    onLimit: diagnostic => telemetry('loop_limit', { runId: context.runId, requestId: context.requestId, ...diagnostic }),
    onToolSelection: diagnostic => telemetry('tool_selection', { runId: context.runId, requestId: context.requestId, ...diagnostic }),
    personalContext, memorySourceText: authoredText, ...(media ? { mediaInput: { userText: authoredText, kind: media.attachment.kind, truncated: 'truncated' in media.attachment && media.attachment.truncated } } : {}), discoverTools: true, compactObservations: true, ...loopPolicy,
    initialTools: recentToolScope(previous?.history ?? [], registry.available(context).map(tool => tool.name), productivityBudget.initialTools),
    readFollowups: { reminder_read: ['reminder_cancel'], task_read: ['task_delete'], calendar_read: ['calendar_delete'], memory_read: ['memory_forget'], project_read: ['project_delete', 'project_rename'], subscription_info: ['subscription_checkout', 'subscription_cancel'], entity_read: ['entity_delete', 'entity_update'] }, maxPromptReferences: 5, ...(media ? { maxWriteOperations: 1 } : {}),
    estimateInputTokens: input => provider.estimateNativeInput?.(requestSchema.parse(input)) ?? estimateBoundedInput(input),
    authorizeWrite: async (call, scopedContext) => (registry.effect(call.name) === 'write' || ['task_delete', 'reminder_cancel', 'calendar_delete', 'memory_forget', 'project_delete', 'subscription_cancel', 'entity_delete'].includes(call.name) && registry.effect(call.name) === 'destructive')
      && (!allowed || allowed.has(call.name)) && writePolicy.success && await writePolicy.data(call, scopedContext) === true }), delivery);
  const handled = await assistant.handle(text, context, admission.threadId, previous);
  telemetry('turn_usage', { runId: context.runId, requestId: context.requestId,
    inputTarget: loopPolicy.maxInputTokens, accountingScope: 'reasoning_loop; memory_extraction_admission_and_embeddings_reported_separately', ...handled.usage, generations: attempts.map(attempt => attempt.generationId) });
  const result: Result = { confirmation: handled.reply.text, intent: handled.uiPayload.items.length ? 'query' : 'chat', language,
    entities: { _agentCoreEngine: 'v2', _agentCoreUsage: { ...handled.usage, inputTarget: loopPolicy.maxInputTokens, attempts: attempts.map(attempt => ({ ...attempt, requestedProviders: [...attempt.requestedProviders] })) } }, executionFacts: [], memoryDisposition: 'skip_operational' };
  recordV2Delivery(result, handled.messageIds);
  // handle returns only after all deliveries are accepted and the durable completion is published.
  // Explicit memory operations own their source and must never be relearned by the background task.
  if (handled.messageIds.length && !handled.uiPayload.items.some(item => item.toolName === 'memory_save' || item.toolName === 'memory_forget')) {
    try { scheduleProactiveMemory({ authoredText, context }); }
    catch { telemetry('memory_extraction_schedule_failed', { runId: context.runId, requestId: context.requestId }); }
  }
  return result;
}

import { readPersonalContext } from './personal-context.js';
import { retrieveRelevantMemories, retrieveStandingPreferences } from '../../features/memory/service.js';
import { z } from 'zod';
import { estimateBoundedInput, type OpenRouterAttempt } from '@templelabs/ai';
import { aiTranscriptSchema, jsonObjectSchema } from '@templelabs/contracts';
import { ProductivityTurnRunner, type AgentLoopOptions } from '@templelabs/agent-core';
import { createTaskTools, createCalendarTools, createReminderTools, ToolRegistry } from '@templelabs/tools';
import type { ProductivityConversation } from '@templelabs/contracts';
import { DurableProductivityAssistant, type ProductivityDeliveryPort } from './durable-productivity-assistant.js';
import { recoverProductivityStoredTurn } from './productivity-state-recovery.js';
import { createConfiguredAIProvider } from './configured-ai-provider.js';
import { createLegacyTaskPort } from './legacy-tasks.js';
import { createLegacyCalendarPort } from './legacy-calendar.js';
import { createLegacyReminderPort } from './legacy-reminders.js';
import { getUserSubscription, hasProAccess } from '../../infrastructure/database/index.js';
import { detectLanguageFromText } from '../../shared/language-detection.js';
import type { CanaryAdmission } from '../../agent/orchestration/canary-router.js';
import type { routeMessage as baseline } from '../../agent/orchestration/router-core.js';
import { recordV2Delivery } from './canary-delivery-receipt.js';

function telemetry(event: string, data: unknown): void {
  try { console.info(`[agent-core-v2] ${event}`, JSON.stringify(data)); } catch { /* Logging cannot invalidate a committed effect. */ }
}

type Result = Awaited<ReturnType<typeof baseline>>;
const userSchema = z.object({ id: z.string().min(1), phone_number: z.string().optional(), timezone: z.string().optional(), locale: z.string().optional(), display_name: z.string().nullish() });

/** The durable V2 composition owns delivery; the webhook must not send its reply a second time. */
export async function routeCanaryProductivity(text: string, rawUser: unknown, options: Record<string, unknown>, admission: CanaryAdmission): Promise<Result> {
  const parsed = userSchema.parse(rawUser);
  const user = { id: parsed.id, ...(parsed.phone_number ? { phone_number: parsed.phone_number } : {}),
    ...(parsed.timezone ? { timezone: parsed.timezone } : {}), ...(parsed.locale ? { locale: parsed.locale } : {}) };
  const delivery = options.agentCoreDelivery as ProductivityDeliveryPort;
  const detected = detectLanguageFromText(text);
  const language = detected === 'en' || detected === 'es' ? detected : admission.context.language;
  const [subscription, personalContext] = await Promise.all([getUserSubscription(user.id),
    readPersonalContext(user.id, text, parsed.display_name ?? undefined, { memories: retrieveRelevantMemories, preferences: retrieveStandingPreferences })]);
  const capabilities = new Set(['tasks.read', 'tasks.create', 'tasks.update', 'tasks.complete', 'tasks.delete',
    'calendar.read', 'calendar.create', 'calendar.connect', 'calendar.update', 'calendar.delete', 'reminders.read', 'reminders.create', 'reminders.update', 'reminders.acknowledge', 'reminders.cancel']);
  if (hasProAccess(subscription)) capabilities.add('reminders.pro');
  const context = { ...admission.context, capabilities, language };
  const registry = new ToolRegistry([
    ...createTaskTools(createLegacyTaskPort(user)), ...createCalendarTools(createLegacyCalendarPort(user)),
    ...createReminderTools(createLegacyReminderPort(user)),
  ]);
  const previous: ProductivityConversation | undefined = admission.handoff ?? (admission.prior
    ? recoverProductivityStoredTurn(admission.prior, user.id) : undefined);
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
    personalContext, discoverTools: true, compactObservations: true, continuationReserveTokens: 256,
    readFollowups: { reminder_read: ['reminder_cancel'], task_read: ['task_delete'], calendar_read: ['calendar_delete'] }, maxPromptReferences: 5, maxInputTokens: 1800, maxTotalTokens: 12000, maxModelSteps: 6, maxToolCalls: 8, maxOutputTokens: 768,
    estimateInputTokens: input => provider.estimateNativeInput?.(requestSchema.parse(input)) ?? estimateBoundedInput(input),
    authorizeWrite: async (call, scopedContext) => (registry.effect(call.name) === 'write' || ['task_delete', 'reminder_cancel', 'calendar_delete'].includes(call.name) && registry.effect(call.name) === 'destructive')
      && writePolicy.success && await writePolicy.data(call, scopedContext) === true }), delivery);
  const handled = await assistant.handle(text, context, admission.threadId, previous);
  telemetry('turn_usage', { runId: context.runId, requestId: context.requestId,
    inputTarget: 1800, ...handled.usage, generations: attempts.map(attempt => attempt.generationId) });
  const result: Result = { confirmation: handled.reply.text, intent: handled.uiPayload.items.length ? 'query' : 'chat', language,
    entities: { _agentCoreEngine: 'v2', _agentCoreUsage: { ...handled.usage, inputTarget: 1800, attempts: attempts.map(attempt => ({ ...attempt, requestedProviders: [...attempt.requestedProviders] })) } }, executionFacts: [], memoryDisposition: 'skip_operational' };
  recordV2Delivery(result, handled.messageIds);
  return result;
}

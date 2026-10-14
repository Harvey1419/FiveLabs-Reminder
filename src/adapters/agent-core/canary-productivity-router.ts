import { z } from 'zod';
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

type Result = Awaited<ReturnType<typeof baseline>>;
const userSchema = z.object({ id: z.string().min(1), phone_number: z.string().optional(), timezone: z.string().optional(), locale: z.string().optional() });

/** The durable V2 composition owns delivery; the webhook must not send its reply a second time. */
export async function routeCanaryProductivity(text: string, rawUser: unknown, options: Record<string, unknown>, admission: CanaryAdmission): Promise<Result> {
  const parsed = userSchema.parse(rawUser);
  const user = { id: parsed.id, ...(parsed.phone_number ? { phone_number: parsed.phone_number } : {}),
    ...(parsed.timezone ? { timezone: parsed.timezone } : {}), ...(parsed.locale ? { locale: parsed.locale } : {}) };
  const delivery = options.agentCoreDelivery as ProductivityDeliveryPort;
  const detected = detectLanguageFromText(text);
  const language = detected === 'en' || detected === 'es' ? detected : admission.context.language;
  const subscription = await getUserSubscription(user.id);
  const capabilities = new Set(['tasks.read', 'tasks.create', 'tasks.update', 'tasks.complete',
    'calendar.read', 'calendar.create', 'calendar.connect', 'reminders.read', 'reminders.create', 'reminders.update', 'reminders.acknowledge']);
  if (hasProAccess(subscription)) capabilities.add('reminders.pro');
  const context = { ...admission.context, capabilities, language };
  const registry = new ToolRegistry([
    ...createTaskTools(createLegacyTaskPort(user)), ...createCalendarTools(createLegacyCalendarPort(user)),
    ...createReminderTools(createLegacyReminderPort(user)),
  ]);
  const previous: ProductivityConversation | undefined = admission.prior
    ? recoverProductivityStoredTurn(admission.prior, user.id) : undefined;
  const writePolicy = z.custom<NonNullable<AgentLoopOptions['authorizeWrite']>>(value => typeof value === 'function')
    .safeParse(options.agentCoreAuthorizeWrite);
  const assistant = new DurableProductivityAssistant(new ProductivityTurnRunner(createConfiguredAIProvider(), registry, { continuation: 'observation_driven',
    authorizeWrite: async (call, scopedContext) => registry.effect(call.name) === 'write'
      && writePolicy.success && await writePolicy.data(call, scopedContext) === true }), delivery);
  const handled = await assistant.handle(text, context, admission.threadId, previous);
  const result: Result = { confirmation: handled.reply.text, intent: 'query', language,
    entities: { _agentCoreEngine: 'v2' }, executionFacts: [], memoryDisposition: 'skip_operational' };
  recordV2Delivery(result, handled.messageIds);
  return result;
}

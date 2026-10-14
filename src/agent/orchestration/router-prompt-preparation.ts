import { compactHistoryForModel, historyContextForModel, currentTurnMessages } from './router-model-context.js';
import type { AgentPromptInput } from '../core/agent-prompt.js';
import type { RouterProfileUser } from './router-profile-context.js';
export interface RouterPromptInput extends Omit<AgentPromptInput, 'userMessage' | 'overview' | 'billingContext' | 'displayName'> {
  user: RouterProfileUser; history?: unknown; messageText: unknown; currentUserText: string; trustedMessageText: string; sanitizedUserText: string;
  dailyOverview?: AgentPromptInput['overview']; subscription?: unknown; entitlementKnown: boolean; isPro: boolean;
}
export interface RouterPromptDependencies {
  shouldEnforceBillingForUser(user: RouterProfileUser): boolean;
  selectReminderProProvider(phoneNumber: unknown, configuredProvider: string): unknown;
  getBillingProvider(): string | undefined; buildAgentCorePrompt(input: AgentPromptInput): string;
}
export function createRouterPromptPreparation({ shouldEnforceBillingForUser, selectReminderProProvider, getBillingProvider, buildAgentCorePrompt }: RouterPromptDependencies) {
  function prepareRouterPrompt({ user, history, messageText, currentUserText, trustedMessageText, sanitizedUserText, nowStr, nowHumanStr, timezone, phoneNumber, memoryHints, preferenceHints, dailyOverview, workingMemoryText, googleIntegration, isAdmin, isPro, inputModality, entitlementKnown, subscription, language, memoryRetrievalStatus }: RouterPromptInput) {
  let rawPastTurns = Array.isArray(history) ? history.slice() : [];
  const lastTurn = rawPastTurns.at(-1) as { role?: unknown; content?: unknown } | undefined;
  if (lastTurn?.role === 'user' && (lastTurn.content === messageText || lastTurn.content === trustedMessageText || lastTurn.content === sanitizedUserText)) rawPastTurns.pop();
  const pastTurns = compactHistoryForModel(rawPastTurns);
  const latestAssistantMessage = [...pastTurns].reverse().find((turn) => turn.role === 'assistant')?.content || '';
  const historyChars = pastTurns.reduce((sum, turn) => sum + turn.content.length, 0);

  const enforceBilling = shouldEnforceBillingForUser(user);
  let proGuidance = null;
  if (enforceBilling && entitlementKnown && !isPro) {
    proGuidance = [
      '- Este usuario está en Plan Free con facturación supervisada.',
      '- Cumple primero la solicitud. Explica planes solo si el usuario pregunta o un límite real bloquea lo pedido; considera el historial para evitar repetir ofertas.',
      '- Beneficios Pro/cómo suscribirse: subscription.info(scope="plan") junto con una explicación natural breve en conversation.reply. Node entrega los hechos y el botón Stripe solo para Free. Precios, descuentos, métodos, fallos/reembolsos y prohibiciones de checkout: subscription.info sin scope; no promoción. Usa general + subscription.link solo para una solicitud explícita de enlace/checkout. No inventes tarifas, procesadores, navegación ni métodos.',
      '- No agregues publicidad a saludos u operaciones rutinarias.',
    ].join('\n');
  }

  const prompt = buildAgentCorePrompt({
    nowStr, nowHumanStr, timezone, phoneNumber, memoryHints, preferenceHints, overview: dailyOverview,
    workingMemoryText, googleIntegration, isAdmin, isPro, displayName: user.display_name, inputModality,
    proGuidance,
    billingContext: {
      provider: selectReminderProProvider(phoneNumber, getBillingProvider() || ''),
      subscriptionStatus: (subscription as { status?: unknown } | null | undefined)?.status || null,
      entitlementKnown,
    },
    userMessage: messageText || currentUserText,
    language,
    memoryRetrievalStatus,
  } as AgentPromptInput);

  const messages = [
    { role: 'system', content: prompt },
    ...historyContextForModel(pastTurns),
    ...currentTurnMessages(messageText, currentUserText),
  ];

    return { rawPastTurns, pastTurns, latestAssistantMessage, historyChars, proGuidance, prompt, messages };
  }
  return { prepareRouterPrompt };
}

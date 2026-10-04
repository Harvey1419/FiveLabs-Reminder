import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAgentCorePrompt } from '../../../src/agent/core/agent-core.js';

vi.mock('../../../src/agent/tools/index.js', () => ({
  executeTool: vi.fn(),
}));
vi.mock('../../../src/agent/providers/client.js', () => ({
  callChatCompletion: vi.fn(),
  callResponseSynthesis: vi.fn().mockResolvedValue(null),
  callPendingTransitionVerification: vi.fn(),
}));
vi.mock('../../../src/features/memory/service.js', () => ({
  retrieveRelevantMemories: vi.fn().mockResolvedValue([]),
  retrieveStandingPreferences: vi.fn().mockResolvedValue([]),
  getProactiveAnchors: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../src/infrastructure/database/index.js', () => ({
  getDailyOverview: vi.fn().mockResolvedValue(null),
  getUserSubscription: vi.fn().mockResolvedValue(null),
  getUserIntegration: vi.fn().mockResolvedValue(null),
  hasProAccess: vi.fn().mockReturnValue(false),
  createPendingSubscription: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../src/integrations/mercado-pago/client.js', () => ({ getOrCreateCanonicalPlan: vi.fn() }));
vi.mock('../../../src/integrations/google/auth.js', () => ({
  getGoogleConnectUrl: vi.fn(() => 'https://example.test/google'),
  hasUsableGoogleCredentials: vi.fn(() => false),
}));

import { executeTool } from '../../../src/agent/tools/index.js';
import { executeSubscriptionTool } from '../../../src/agent/tools/subscriptions.js';
import { routeMessage } from '../../../src/agent/orchestration/router.js';
import { callChatCompletion } from '../../../src/agent/providers/client.js';
import { hasProAccess, createPendingSubscription } from '../../../src/infrastructure/database/index.js';
import { getOrCreateCanonicalPlan } from '../../../src/integrations/mercado-pago/client.js';

describe('Pro Consultative Onboarding & Guidance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeTool.mockImplementation(async ({ params, user, language }) => executeSubscriptionTool({ action: params.action, user, language }));
    vi.stubEnv('BILLING_PROVIDER', 'lemonsqueezy');
    vi.stubEnv('LEMON_SQUEEZY_CHECKOUT_URL', 'https://hermes-templelabs.lemonsqueezy.com/checkout/buy/test-plan');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('buildAgentCorePrompt pro guidance injection', () => {
    it('omits pro consultation section when proGuidance is null or not provided', () => {
      const prompt = buildAgentCorePrompt({
        nowStr: '2026-09-16 20:00:00',
        nowHumanStr: 'Miércoles, 16 de septiembre de 2026',
        timezone: 'America/New_York',
        isPro: false,
      });

      expect(prompt).not.toContain('PLAN FREE Y PERSUASIÓN CONSULTIVA A PRO');
      expect(prompt).toContain('Plan: 🆓 Free');
    });

    it('injects pro consultation section cleanly when proGuidance is provided', () => {
      const guidance = '- Tu objetivo secundario es orientar de forma elegante al usuario hacia Reminder Pro ($9.99 USD/mes).';
      const prompt = buildAgentCorePrompt({
        nowStr: '2026-09-16 20:00:00',
        nowHumanStr: 'Miércoles, 16 de septiembre de 2026',
        timezone: 'America/New_York',
        isPro: false,
        proGuidance: guidance,
      });

      expect(prompt).toContain('## PLAN FREE Y PERSUASIÓN CONSULTIVA A PRO');
      expect(prompt).toContain(guidance);
    });
  });

  describe('safe initial billing grounding', () => {
    it.each([false, true])('grounds Stripe for regular users with isPro=%s without checkout', async (isPro) => {
      vi.stubEnv('BILLING_PROVIDER', 'stripe');
      vi.stubEnv('STRIPE_CHECKOUT_URL', 'https://buy.stripe.com/private-test-url');
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network call'));
      hasProAccess.mockReturnValueOnce(isPro);
      callChatCompletion.mockResolvedValueOnce({
        role: 'assistant',
        content: JSON.stringify({ responseCapability: 'general', actions: [{ domain: 'conversation', action: 'reply', content: 'Explanation only.' }] }),
      });
      await routeMessage('Explain subscribing, but do not start checkout.', {
        id: `billing-${isPro}`, phone_number: '573001112233', timezone: 'America/Bogota', locale: 'en',
      }, []);
      const prompt = callChatCompletion.mock.calls[0][0].find((m) => m.role === 'system').content;
      expect(prompt).toContain('Configured billing provider: Stripe');
      expect(prompt).toContain('Checkout payment methods: UNKNOWN');
      expect(prompt).toContain('provider name proves no methods, prices or discounts');
      expect(prompt).toContain('Never invent PayPal, bank transfer, Apple Pay');
      expect(prompt).toContain('never auto-checkout or retry');
      expect(prompt).toContain('Explicit checkout prohibition means NO subscription.link or mutation');
      expect(prompt).not.toContain('private-test-url');
      expect(getOrCreateCanonicalPlan).not.toHaveBeenCalled();
      expect(createPendingSubscription).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('projects only allowlisted provider facts into the core prompt', () => {
      const prompt = buildAgentCorePrompt({ billingContext: {
        provider: 'Stripe', secret: 'private-secret', checkoutUrl: 'https://private-checkout.test', paymentMethods: ['PayPal'],
      } });
      expect(prompt).toContain('Configured billing provider: Stripe');
      expect(prompt).toContain('Checkout payment methods: UNKNOWN');
      expect(prompt).not.toContain('private-secret');
      expect(prompt).not.toContain('https://private-checkout.test');
    });
  });

  describe('routeMessage pro guidance scoping', () => {
    it('injects subtle pro guidance for 1916 user on Free tier', async () => {
      const user1916 = {
        id: 'user-1916',
        phone_number: '19164158325',
        timezone: 'America/New_York',
        locale: 'en-US',
      };

      callChatCompletion.mockResolvedValueOnce({
        role: 'assistant',
        content: JSON.stringify({
          responseCapability: 'general',
          actions: [{ domain: 'conversation', action: 'reply', content: '¡Hola! Soy Hermes, tu segundo cerebro ejecutivo.' }],
        }),
      });

      await routeMessage('Hola', user1916, []);

      expect(callChatCompletion).toHaveBeenCalledTimes(1);
      const callArgs = callChatCompletion.mock.calls[0][0];
      const systemMessage = callArgs.find((m) => m.role === 'system');

      expect(systemMessage.content).toContain('PLAN FREE Y PERSUASIÓN CONSULTIVA A PRO');
      expect(systemMessage.content).toContain('No agregues publicidad');
      expect(systemMessage.content).toContain('subscription.link');
      expect(systemMessage.content).not.toContain('$9.99');
      expect(systemMessage.content).not.toContain('$14.99');
    });

    it('warns not to repeat Pro pitch if recent turns already mentioned Pro', async () => {
      const user1916 = {
        id: 'user-1916',
        phone_number: '19164158325',
        timezone: 'America/New_York',
        locale: 'en-US',
      };

      callChatCompletion.mockResolvedValueOnce({
        role: 'assistant',
        content: JSON.stringify({
          responseCapability: 'general',
          actions: [{ domain: 'conversation', action: 'reply', content: 'Entendido.' }],
        }),
      });

      const historyWithProMention = [
        { role: 'user', content: '¿Qué es Reminder Pro?' },
        { role: 'assistant', content: 'Reminder Pro cuesta $9.99 USD y te da recordatorios a futuro.' },
      ];

      await routeMessage('Ah ok', user1916, historyWithProMention);

      expect(callChatCompletion).toHaveBeenCalledTimes(1);
      const callArgs = callChatCompletion.mock.calls[0][0];
      const systemMessage = callArgs.find((m) => m.role === 'system');

      expect(systemMessage.content).toContain('considera el historial para evitar repetir ofertas');
    });

    it('never injects pro guidance for non-1916 regular users', async () => {
      const regularUser = {
        id: 'user-regular',
        phone_number: '573001112233',
        timezone: 'America/Bogota',
        locale: 'es-CO',
      };

      callChatCompletion.mockResolvedValueOnce({
        role: 'assistant',
        content: JSON.stringify({
          responseCapability: 'general',
          actions: [{ domain: 'conversation', action: 'reply', content: '¡Hola! ¿En qué te ayudo?' }],
        }),
      });

      await routeMessage('Hola', regularUser, []);

      expect(callChatCompletion).toHaveBeenCalledTimes(1);
      const callArgs = callChatCompletion.mock.calls[0][0];
      const systemMessage = callArgs.find((m) => m.role === 'system');

      expect(systemMessage.content).not.toContain('PLAN FREE Y PERSUASIÓN CONSULTIVA A PRO');
    });

    it('uses pure information rather than checkout for conversational [checkout_url]', async () => {
      const user1916 = {
        id: 'user-1916',
        phone_number: '19164158325',
        timezone: 'America/New_York',
        locale: 'es',
      };

      callChatCompletion.mockResolvedValueOnce({
        role: 'assistant',
        content: JSON.stringify({
          responseCapability: 'general',
          actions: [{ domain: 'conversation', action: 'reply', content: 'Puedes activar tu suscripción acá: [checkout_url]' }],
        }),
      });

      const result = await routeMessage('Cómo me suscribo', user1916, []);

      expect(result.ctaUrl).toBeNull();
      expect(result.confirmation).toContain('Proveedor de pago: Lemon Squeezy');
      expect(result.confirmation).not.toContain('https://');
      expect(createPendingSubscription).not.toHaveBeenCalled();
      expect(result.confirmation).not.toContain('[checkout_url]');
    });

    it('uses configured Stripe information without resolving legacy prose checkout', async () => {
      vi.stubEnv('BILLING_PROVIDER', 'stripe');
      vi.stubEnv('STRIPE_CHECKOUT_URL', 'https://buy.stripe.com/test-stripe');

      const user1916 = {
        id: 'user-1916',
        phone_number: '19164158325',
        timezone: 'America/New_York',
        locale: 'es',
      };

      callChatCompletion.mockResolvedValueOnce({
        role: 'assistant',
        content: JSON.stringify({
          responseCapability: 'general',
          actions: [{
            domain: 'conversation',
            action: 'reply',
            content: 'Puedes activar tu suscripción con Lemon Squeezy acá: [checkout_url]',
          }],
        }),
      });

      const result = await routeMessage('Cómo me suscribo', user1916, []);

      expect(result.ctaUrl).toBeNull();
      expect(result.confirmation).not.toContain('https://');
      expect(createPendingSubscription).not.toHaveBeenCalled();
      expect(result.confirmation).toContain('Stripe');
      expect(result.confirmation).not.toContain('Lemon Squeezy');
      expect(result.confirmation).not.toContain('[checkout_url]');
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
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

import { routeMessage } from '../../../src/agent/orchestration/router.js';
import { callChatCompletion } from '../../../src/agent/providers/client.js';

describe('Pro Consultative Onboarding & Guidance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BILLING_PROVIDER = 'lemonsqueezy';
    process.env.LEMON_SQUEEZY_CHECKOUT_URL = 'https://hermes-templelabs.lemonsqueezy.com/checkout/buy/test-plan';
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
          actions: [{ domain: 'conversation', action: 'reply', content: '¡Hola! ¿En qué te ayudo?' }],
        }),
      });

      await routeMessage('Hola', regularUser, []);

      expect(callChatCompletion).toHaveBeenCalledTimes(1);
      const callArgs = callChatCompletion.mock.calls[0][0];
      const systemMessage = callArgs.find((m) => m.role === 'system');

      expect(systemMessage.content).not.toContain('PLAN FREE Y PERSUASIÓN CONSULTIVA A PRO');
    });

    it('extracts interactive CTA button when conversational reply includes [checkout_url]', async () => {
      const user1916 = {
        id: 'user-1916',
        phone_number: '19164158325',
        timezone: 'America/New_York',
        locale: 'es',
      };

      callChatCompletion.mockResolvedValueOnce({
        role: 'assistant',
        content: JSON.stringify({
          actions: [{ domain: 'conversation', action: 'reply', content: 'Puedes activar tu suscripción acá: [checkout_url]' }],
        }),
      });

      const result = await routeMessage('Cómo me suscribo', user1916, []);

      expect(result.ctaUrl).toContain('lemonsqueezy.com');
      expect(result.ctaHeader).toBe('💎 Reminder Pro');
      expect(result.ctaButtonText).toBe('Pagar ahora');
      expect(result.confirmation).toContain('https://hermes-templelabs.lemonsqueezy.com/checkout/buy/test-plan');
      expect(result.confirmation).not.toContain('[checkout_url]');
    });

    it('extracts Stripe interactive CTA button and sanitizes legacy Lemon Squeezy text when BILLING_PROVIDER is stripe', async () => {
      process.env.BILLING_PROVIDER = 'stripe';
      process.env.STRIPE_CHECKOUT_URL = 'https://buy.stripe.com/test-stripe';

      const user1916 = {
        id: 'user-1916',
        phone_number: '19164158325',
        timezone: 'America/New_York',
        locale: 'es',
      };

      callChatCompletion.mockResolvedValueOnce({
        role: 'assistant',
        content: JSON.stringify({
          actions: [{
            domain: 'conversation',
            action: 'reply',
            content: 'Puedes activar tu suscripción con Lemon Squeezy acá: [checkout_url]',
          }],
        }),
      });

      const result = await routeMessage('Cómo me suscribo', user1916, []);

      expect(result.ctaUrl).toContain('buy.stripe.com');
      expect(result.ctaHeader).toBe('💎 Reminder Pro');
      expect(result.ctaButtonText).toBe('Pagar ahora');
      expect(result.confirmation).toContain('https://buy.stripe.com/test-stripe');
      expect(result.confirmation).toContain('Stripe');
      expect(result.confirmation).not.toContain('Lemon Squeezy');
      expect(result.confirmation).not.toContain('[checkout_url]');
    });
  });
});

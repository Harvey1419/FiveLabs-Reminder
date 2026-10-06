import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasProAccess as canonicalHasProAccess } from '../../../src/infrastructure/database/subscriptions.js';

vi.mock('../../../src/agent/tools/index.js', () => ({ executeTool: vi.fn() }));
vi.mock('../../../src/agent/providers/client.js', () => ({
  callChatCompletion: vi.fn(),
  callResponseSynthesis: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../src/features/memory/service.js', () => ({
  retrieveRelevantMemories: vi.fn().mockResolvedValue([]),
  retrieveStandingPreferences: vi.fn().mockResolvedValue([]),
  getProactiveAnchors: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../src/infrastructure/database/index.js', () => ({
  getDailyOverview: vi.fn().mockResolvedValue(null),
  getUserSubscription: vi.fn(),
  getUserIntegration: vi.fn().mockResolvedValue(null),
  hasProAccess: (...args) => canonicalHasProAccess(...args),
  createPendingSubscription: vi.fn(),
}));
vi.mock('../../../src/agent/orchestration/next-best-action.js', () => ({
  resolveNextBestAction: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../src/integrations/google/auth.js', () => ({
  getGoogleConnectUrl: vi.fn(),
  hasUsableGoogleCredentials: vi.fn(() => false),
}));

import { routeMessage } from '../../../src/agent/orchestration/router.js';
import { executeTool } from '../../../src/agent/tools/index.js';
import { executeSubscriptionTool } from '../../../src/agent/tools/subscriptions.js';
import { callChatCompletion } from '../../../src/agent/providers/client.js';
import { getUserSubscription, createPendingSubscription } from '../../../src/infrastructure/database/index.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('BILLING_PROVIDER', 'stripe');
  vi.stubEnv('STRIPE_CHECKOUT_URL', 'https://buy.stripe.com/test_checkout');
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('network forbidden'); });
  executeTool.mockImplementation(({ toolName, params, user, language }) => {
    expect(toolName).toBe('manage_subscription');
    expect(['info', 'get_link']).toContain(params.action);
    return executeSubscriptionTool({ action: params.action, params, user, language });
  });
  // Declared model output, not proof of real model intent selection.
  callChatCompletion.mockResolvedValue({
    role: 'assistant',
    content: JSON.stringify({ responseCapability: 'general', actions: [{ operation: 'subscription.link' }] }),
    tool_calls: [],
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('hybrid single-decision plan presentation', () => {
  it.each(['Organiza tu semana sin cargarla en la cabeza.', 'Dale espacio a tus planes: Pro te ayuda a anticiparte.'])('preserves varying model prose and canonical Free CTA: %s', async prose => {
    getUserSubscription.mockResolvedValue(null);
    callChatCompletion.mockResolvedValueOnce({ content: JSON.stringify({ responseCapability: 'billing_info', actions: [
      { operation: 'subscription.info', scope: 'plan' }, { operation: 'conversation.reply', content: prose },
    ] }) });
    const result = await routeMessage('Qué me ofrece Pro?', { id: 'natural-free', phone_number: '57300' }, []);
    expect(result.confirmation).toContain(prose);
    expect(result.confirmation).toContain('días futuros');
    expect(result.confirmation).toContain('recurrentes');
    expect(result.ctaButtonText).toBe('Suscribirse a Pro');
    expect(result.ctaUrl).toContain('client_reference_id=natural-free');
    expect(result.ctaUrl).toContain('locale=es');
    expect(callChatCompletion).toHaveBeenCalledTimes(1);
    expect(getUserSubscription).toHaveBeenCalledTimes(1);
    expect(createPendingSubscription).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it('retains natural already-Pro text on explicit link without payment CTA', async () => {
    getUserSubscription.mockResolvedValue({ plan: 'pro', status: 'active' });
    callChatCompletion.mockResolvedValueOnce({ content: JSON.stringify({ responseCapability: 'general', actions: [
      { operation: 'subscription.link' }, { operation: 'conversation.reply', content: 'Tu plan ya está listo para acompañarte esta semana.' },
    ] }) });
    const result = await routeMessage('Pásame el link', { id: 'natural-pro', phone_number: '57300' }, []);
    expect(result.confirmation).toContain('Tu plan ya está listo');
    expect(result.confirmation).toContain('Ya tienes acceso');
    expect(result.confirmation).toContain('recurrentes');
    expect(result.ctaUrl).toBeNull();
    expect(callChatCompletion).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it('discards model-authored URLs rather than delivering a hallucinated payment link', async () => {
    getUserSubscription.mockResolvedValue(null);
    callChatCompletion.mockResolvedValueOnce({ content: JSON.stringify({ responseCapability: 'billing_info', actions: [
      { operation: 'subscription.info', scope: 'plan' }, { operation: 'conversation.reply', content: 'Paga en https://evil.example/pay' },
    ] }) });
    const result = await routeMessage('Qué incluye Pro?', { id: 'safe-link', phone_number: '57300' }, []);
    expect(result.confirmation).not.toContain('evil.example');
    expect(result.ctaUrl).toContain('client_reference_id=safe-link');
    expect(callChatCompletion).toHaveBeenCalledTimes(1);
  });
  it('does not promote generic payment failures/refunds', async () => {
    getUserSubscription.mockResolvedValue(null);
    callChatCompletion.mockResolvedValueOnce({ content: JSON.stringify({ responseCapability: 'billing_info', actions: [
      { operation: 'conversation.reply', content: 'Reintenta manualmente' },
    ] }) });
    const result = await routeMessage('Falló el pago; necesito reembolso', { id: 'billing-safety', phone_number: '57300' }, []);
    expect(result.confirmation).toContain('No reintentes manualmente');
    expect(result.confirmation).not.toContain('Reintenta manualmente');
    expect(result.ctaUrl).toBeNull();
    expect(callChatCompletion).toHaveBeenCalledTimes(1);
  });
  it('does not reuse stale Pro state after entitlement failure', async () => {
    getUserSubscription.mockRejectedValue(new Error('entitlement unavailable'));
    callChatCompletion.mockImplementationOnce(async messages => {
      expect(messages[0].content).toContain('Canonical Pro access: UNKNOWN');
      return { content: JSON.stringify({ responseCapability: 'billing_info', actions: [{ operation: 'subscription.info', scope: 'plan' }] }) };
    });
    const result = await routeMessage('Qué incluye Pro?', { id: 'failed-entitlement', phone_number: '57300', subscription: { plan: 'pro', status: 'active' }, isPro: true }, []);
    expect(result.confirmation).toContain('No pude verificar');
    expect(result.confirmation).not.toContain('Ya tienes');
    expect(result.ctaUrl).toBeNull();
    expect(callChatCompletion).toHaveBeenCalledTimes(1);
  });
});

describe('declared subscription link delivery', () => {
  it.each([false, true])('keeps info side-effect-free then delivers contextual explicit link for Pro=%s', async pro => {
    getUserSubscription.mockResolvedValue(pro ? { plan: 'pro', status: 'active' } : { plan: 'free', status: 'active' });
    const user = { id: `contextual-${pro}`, phone_number: '573001112233', timezone: 'America/Bogota', locale: 'es-CO' };
    callChatCompletion.mockResolvedValueOnce({
      role: 'assistant', tool_calls: [],
      content: JSON.stringify({ responseCapability: 'billing_info', actions: [
        { operation: 'subscription.info', scope: 'plan' },
        { operation: 'conversation.reply', content: 'Planear con tiempo te libera la cabeza.' },
      ] }),
    });
    const info = await routeMessage('Y cómo me puedo suscribir?', user, []);
    expect(info.confirmation).toContain('Planear con tiempo te libera la cabeza.');
    expect(info.confirmation.length).toBeLessThanOrEqual(500);
    expect(info.ctaUrl || null).toEqual(pro ? null : expect.stringContaining('client_reference_id=contextual-false'));
    if (!pro) expect(info.ctaButtonText).toBe('Suscribirse a Pro');
    expect(executeTool.mock.calls[0][0].params.scope).toBe('plan');
    expect(createPendingSubscription).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(executeTool.mock.calls[0][0].params.action).toBe('info');

    const history = [
      { role: 'assistant', content: 'No pude completar esa acción en este momento. No ejecuté acciones nuevas.' },
      { role: 'user', content: 'Y cómo me puedo suscribir?' },
      { role: 'assistant', content: info.confirmation },
    ];
    const link = await routeMessage('Pásame el link', user, history);
    expect(executeTool.mock.calls[1][0].params.action).toBe('get_link');
    expect(callChatCompletion).toHaveBeenCalledTimes(2);
    // The supplied subscription avoids an additional tool-level lookup.
    expect(getUserSubscription).toHaveBeenCalledTimes(2);
    expect(createPendingSubscription).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    if (pro) {
      expect(link.confirmation).toContain('Ya tienes acceso a Reminder Pro');
      expect(link.ctaUrl).toBeFalsy();
      expect(link.confirmation).not.toContain('https://');
    } else {
      expect(link.confirmation).toContain('Enlace de pago seguro');
      expect(link.ctaUrl).toContain('client_reference_id=contextual-false');
    }
  });
  it.each([false, true])('delivers canonical checkout or already-Pro for Pro=%s', async pro => {
    getUserSubscription.mockResolvedValue(pro ? { plan: 'pro', status: 'active' } : null);
    const user = { id: `checkout-${pro}`, phone_number: '573001112233', timezone: 'America/Bogota', locale: 'es-CO' };
    const result = await routeMessage('me puedes dar el link de pago ?', user, []);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(callChatCompletion).toHaveBeenCalledTimes(1);
    expect(createPendingSubscription).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    if (pro) {
      expect(result.confirmation).toContain('Ya tienes acceso a Reminder Pro');
      expect(result.ctaUrl).toBeFalsy();
      expect(result.confirmation).not.toContain('https://');
    } else {
      expect(result.confirmation).toContain('Enlace de pago seguro');
      expect(result.ctaUrl).toContain('https://buy.stripe.com/test_checkout');
      expect(result.ctaUrl).toContain('client_reference_id=checkout-false');
    }
  });
});

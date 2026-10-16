import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { TurnContext } from '@templelabs/contracts';
import { createSubscriptionTools, ToolRegistry } from '@templelabs/tools';
import { createSubscriptionDomainPort } from '../../../src/adapters/agent-core/subscriptions-domain.js';

const mockSubscriptions = vi.hoisted(() => ({
  getUserSubscription: vi.fn(),
  hasProAccess: vi.fn(),
  cancelUserSubscription: vi.fn(),
  resolveReminderProUpgradeContext: vi.fn(),
}));

vi.mock('../../../src/infrastructure/database/subscriptions.js', () => ({
  getUserSubscription: mockSubscriptions.getUserSubscription,
  hasProAccess: mockSubscriptions.hasProAccess,
  cancelUserSubscription: mockSubscriptions.cancelUserSubscription,
}));

vi.mock('../../../src/agent/tools/reminder-pro.js', () => ({
  resolveReminderProUpgradeContext: mockSubscriptions.resolveReminderProUpgradeContext,
  REMINDER_PRO_FALLBACK: { ctaHeader: '💎 Reminder Pro' },
}));

const user = { id: 'owner-123', phone_number: '+573001234567' };
const context: TurnContext = {
  userId: 'owner-123',
  runId: 'run-1',
  requestId: 'req-1',
  referenceTimeIso: '2026-10-16T12:00:00.000Z',
  timezone: 'America/Bogota',
  language: 'es',
  capabilities: new Set(['subscriptions.read', 'subscriptions.checkout', 'subscriptions.cancel']),
  signal: new AbortController().signal,
};

describe('Subscription domain port and tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSubscriptions.resolveReminderProUpgradeContext.mockResolvedValue({
      checkoutUrl: 'https://buy.stripe.com/test',
      shortCheckoutUrl: 'https://hermes.templelabs.co/pay?ref=test',
      amount: 14.99,
      currency: 'USD',
      ctaHeader: '💎 Reminder Pro',
      ctaButtonText: 'Pagar ahora',
    });
  });

  it('returns subscription information for free user', async () => {
    mockSubscriptions.getUserSubscription.mockResolvedValue(null);
    mockSubscriptions.hasProAccess.mockReturnValue(false);

    const port = createSubscriptionDomainPort(user);
    const tools = createSubscriptionTools(port);
    const registry = new ToolRegistry([...tools]);

    const outcome = await registry.execute('subscription_info', {}, context, 'op-sub-1');
    expect(outcome).toMatchObject({
      status: 'success',
      data: {
        isPro: false,
        price: 14.99,
        checkoutUrl: 'https://hermes.templelabs.co/pay?ref=test',
        presentation: {
          cta: {
            url: 'https://hermes.templelabs.co/pay?ref=test',
          },
        },
      },
    });
  });

  it('returns checkout link when free user invokes subscription_checkout', async () => {
    mockSubscriptions.getUserSubscription.mockResolvedValue(null);
    mockSubscriptions.hasProAccess.mockReturnValue(false);

    const port = createSubscriptionDomainPort(user);
    const tools = createSubscriptionTools(port);
    const registry = new ToolRegistry([...tools]);

    const outcome = await registry.execute('subscription_checkout', {}, context, 'op-sub-2');
    expect(outcome).toMatchObject({
      status: 'success',
      data: {
        isPro: false,
        checkoutUrl: 'https://hermes.templelabs.co/pay?ref=test',
      },
    });
  });

  it('returns already_pro when pro user invokes subscription_checkout', async () => {
    mockSubscriptions.getUserSubscription.mockResolvedValue({ id: 'sub-active', plan: 'pro', status: 'active' });
    mockSubscriptions.hasProAccess.mockReturnValue(true);

    const port = createSubscriptionDomainPort(user);
    const tools = createSubscriptionTools(port);
    const registry = new ToolRegistry([...tools]);

    const outcome = await registry.execute('subscription_checkout', {}, context, 'op-sub-3');
    expect(outcome).toMatchObject({
      status: 'success',
      data: {
        isPro: true,
        checkoutUrl: null,
      },
    });
  });

  it('cancels active subscription successfully', async () => {
    mockSubscriptions.getUserSubscription.mockResolvedValue({ id: 'sub-active', plan: 'pro', status: 'active' });
    mockSubscriptions.hasProAccess.mockReturnValue(true);
    mockSubscriptions.cancelUserSubscription.mockResolvedValue({ success: true });

    const port = createSubscriptionDomainPort(user);
    const tools = createSubscriptionTools(port);
    const registry = new ToolRegistry([...tools]);

    const outcome = await registry.execute('subscription_cancel', { confirmed: true }, context, 'op-sub-4');
    expect(outcome).toMatchObject({
      status: 'success',
      data: {
        status: 'cancelled',
      },
    });
    expect(mockSubscriptions.cancelUserSubscription).toHaveBeenCalledWith('owner-123');
  });
});

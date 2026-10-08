import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hasProAccess, shouldEnforceBillingForUser } from '../../../src/infrastructure/database/subscriptions.js';
import { createPreapproval, getPreapproval, cancelPreapproval, verifyWebhookSignature } from '../../../src/integrations/mercado-pago/client.js';
import { executeTool } from '../../../src/agent/tools/index.js';

vi.mock('../../../src/infrastructure/database/index.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    saveReminder: vi.fn().mockImplementation(async ({ content, sendAt, recurrenceRule }) => ({
      id: `rem-${Math.random().toString(36).slice(2)}`,
      content,
      send_at: sendAt,
      recurrence_rule: recurrenceRule || null,
    })),
    cancelReminders: vi.fn().mockResolvedValue({ cancelledCount: 0, remainingCount: 0 }),
    createPendingSubscription: vi.fn().mockResolvedValue(true),
    getUserSubscription: vi.fn().mockResolvedValue(null),
    cancelUserSubscription: vi.fn().mockResolvedValue({
      success: true,
      subscription: {
        id: 'sub-123',
        status: 'cancelled',
        next_payment_date: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
      },
    }),
  };
});

vi.mock('../../../src/infrastructure/database/memories.js', () => ({
  getReminderConfirmationPreference: vi.fn().mockResolvedValue(null),
  getReminderDispatchPolicy: vi.fn().mockResolvedValue(null),
}));

describe('Subscription Access Control (hasProAccess)', () => {
  it('should grant Pro access to admin users unconditionally', () => {
    const adminUser = { is_admin: true };
    expect(hasProAccess(null, adminUser)).toBe(true);
    expect(hasProAccess({ plan: 'free', status: 'active' }, adminUser)).toBe(true);
  });

  it('should deny Pro access when no subscription is present for regular users', () => {
    expect(hasProAccess(null, { is_admin: false })).toBe(false);
  });

  it('should deny Pro access for free tier plan', () => {
    expect(hasProAccess({ plan: 'free', status: 'active' }, { is_admin: false })).toBe(false);
  });

  it('should grant Pro access for active/authorized Pro subscription', () => {
    expect(hasProAccess({
      plan: 'pro', status: 'authorized',
      next_payment_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    }, { is_admin: false })).toBe(true);
  });

  it('should grant Pro access for cancelled subscription if current period is not expired', () => {
    expect(hasProAccess({
      plan: 'pro', status: 'cancelled',
      next_payment_date: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
      canceled_at: new Date().toISOString(),
    }, { is_admin: false })).toBe(true);
  });

  it('should deny Pro access for cancelled subscription if current period has expired', () => {
    expect(hasProAccess({
      plan: 'pro', status: 'cancelled',
      next_payment_date: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      canceled_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    }, { is_admin: false })).toBe(false);
  });

  it('should grant Pro access for paused subscription if current period has not expired', () => {
    expect(hasProAccess({
      plan: 'pro', status: 'paused',
      next_payment_date: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
    }, { is_admin: false })).toBe(true);
  });
});

describe('Experimental Billing Enforcement Target (shouldEnforceBillingForUser)', () => {
  it('should return true strictly for experimental billing phone number 19164158325', () => {
    expect(shouldEnforceBillingForUser({ phone_number: '19164158325' })).toBe(true);
    expect(shouldEnforceBillingForUser({ phone_number: '+1 (916) 415-8325' })).toBe(true);
    expect(shouldEnforceBillingForUser({ phone_number: '19164158325@c.us' })).toBe(true);
  });

  it('should return false for any other phone number', () => {
    expect(shouldEnforceBillingForUser({ phone_number: '573001112233' })).toBe(false);
    expect(shouldEnforceBillingForUser({ phone_number: '573118588249' })).toBe(false);
    expect(shouldEnforceBillingForUser({ phone_number: '573046154163' })).toBe(false);
  });

  it('should return false for BSUID identities', () => {
    expect(shouldEnforceBillingForUser({ phone_number: 'CO.1552339023039755' })).toBe(false);
    expect(shouldEnforceBillingForUser({ phone_number: 'CO.1046858631495979' })).toBe(false);
    expect(shouldEnforceBillingForUser({ phone_number: 'US.998877665544' })).toBe(false);
  });

  it('should return false for new users without phone or null user', () => {
    expect(shouldEnforceBillingForUser({ phone_number: '' })).toBe(false);
    expect(shouldEnforceBillingForUser({ phone_number: null })).toBe(false);
    expect(shouldEnforceBillingForUser(null)).toBe(false);
  });

  it('should enforce billing for all non-admin users when ENFORCE_BILLING=true or ENFORCE_BILLING_FOR_ALL=true', () => {
    process.env.ENFORCE_BILLING = 'true';
    expect(shouldEnforceBillingForUser({ phone_number: '573001112233' })).toBe(true);
    expect(shouldEnforceBillingForUser({ phone_number: '573001112233', is_admin: true })).toBe(false);
    delete process.env.ENFORCE_BILLING;
  });

  it('should exempt admin users even if they have the test phone number', () => {
    expect(shouldEnforceBillingForUser({ phone_number: '19164158325', is_admin: true })).toBe(false);
  });
});

describe('MercadoPago Service Client', () => {
  beforeEach(() => {
    process.env.MP_ACCESS_TOKEN = 'TEST-TOKEN-12345';
    process.env.APP_BASE_URL = 'https://hermes.templelabs.co';
  });

  it('should call MercadoPago API to create preapproval checkout', async () => {
    const mockResponse = {
      id: '2c938084726fca480172750000000000',
      init_point: 'https://www.mercadopago.com.co/subscriptions/checkout?preapproval_id=2c938084726fca480172750000000000',
      status: 'pending',
      external_reference: 'user-uuid-123',
    };
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true, json: async () => mockResponse });
    const result = await createPreapproval({ userId: 'user-uuid-123', amount: 49900, currency: 'COP' });
    expect(fetchSpy).toHaveBeenCalledWith('https://api.mercadopago.com/preapproval', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer TEST-TOKEN-12345', 'Content-Type': 'application/json' }),
    }));
    const callBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(callBody.external_reference).toBe('user-uuid-123');
    expect(callBody.auto_recurring.transaction_amount).toBe(49900);
    expect(callBody.auto_recurring.currency_id).toBe('COP');
    expect(callBody.status).toBe('pending');
    expect(result.init_point).toBe(mockResponse.init_point);
    fetchSpy.mockRestore();
  });

  it('should fetch preapproval subscription status from MercadoPago', async () => {
    const mockResponse = {
      id: '2c938084726fca480172750000000000', status: 'authorized',
      next_payment_date: '2026-09-29T12:00:00.000Z', external_reference: 'user-uuid-123',
    };
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true, json: async () => mockResponse });
    const result = await getPreapproval(mockResponse.id);
    expect(result.status).toBe('authorized');
    expect(result.next_payment_date).toBe('2026-09-29T12:00:00.000Z');
    fetchSpy.mockRestore();
  });

  it('should verify webhook HMAC signature', () => {
    const originalSecret = process.env.MP_WEBHOOK_SECRET;
    process.env.MP_WEBHOOK_SECRET = 'test-mock-secret';
    const rawBody = Buffer.from(JSON.stringify({ data: { id: '123' } }));
    const crypto = require('crypto');
    const signature = crypto.createHmac('sha256', 'test-mock-secret').update(rawBody).digest('hex');
    expect(verifyWebhookSignature({
      headers: { 'x-signature': `ts=1700000000,v1=${signature}` }, body: { data: { id: '123' } }, rawBody,
    })).toBe(true);
    expect(verifyWebhookSignature({
      headers: { 'x-signature': 'ts=1700000000,v1=invalidhash' }, body: { data: { id: '123' } }, rawBody,
    })).toBe(false);
    if (originalSecret !== undefined) process.env.MP_WEBHOOK_SECRET = originalSecret;
    else delete process.env.MP_WEBHOOK_SECRET;
  });
});

function runTool(toolName, params, user) {
  return executeTool({ toolName, params, user, language: 'es', isPro: hasProAccess(user?.subscription, user) });
}

describe('AI Tools & Plan Tier Gating', () => {
  it('should allow free users to create same-day reminders', async () => {
    const freeUser = {
      id: 'free-user-uuid', phone_number: '573001112233', timezone: 'America/Bogota', locale: 'es-CO',
      is_admin: false, subscription: { plan: 'free', status: 'active' },
    };
    const res = await runTool('manage_reminder', {
      action: 'create', items: [{ content: 'Comprar leche hoy', targetTime: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() }],
    }, freeUser);
    expect(res.success).toBe(true);
    expect(res.action).toBe('created_reminders_batch');
  });

  it('should block experimental target 19164158325 without Pro from creating future-day reminders', async () => {
    const user = {
      id: 'free-user-uuid', phone_number: '19164158325', timezone: 'America/Bogota', locale: 'es-CO',
      is_admin: false, subscription: { plan: 'free', status: 'active' },
    };
    const res = await runTool('manage_reminder', {
      action: 'create', items: [{ content: 'Cita con el doctor mañana', targetTime: new Date(Date.now() + 26 * 60 * 60 * 1000).toISOString() }],
    }, user);
    expect(res.success).toBe(false);
    expect(res.action).toBe('tier_limit_exceeded');
    expect(res.isProFeature).toBe(true);
    expect(res.rawSummary).toContain('Reminder Pro');
  });

  it('should block experimental target 19164158325 without Pro from creating recurring reminders', async () => {
    const user = {
      id: 'free-user-uuid', phone_number: '19164158325', timezone: 'America/Bogota', locale: 'es-CO',
      is_admin: false, subscription: { plan: 'free', status: 'active' },
    };
    const res = await runTool('manage_reminder', {
      action: 'create', items: [{ content: 'Tomar pastilla', targetTime: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), recurrence: 'daily' }],
    }, user);
    expect(res.success).toBe(false);
    expect(res.action).toBe('tier_limit_exceeded');
    expect(res.isProFeature).toBe(true);
  });

  it('should allow experimental target 19164158325 with Pro to create future-day reminders', async () => {
    const user = {
      id: 'pro-user-uuid', phone_number: '19164158325', timezone: 'America/Bogota', locale: 'es-CO', is_admin: false,
      subscription: { plan: 'pro', status: 'authorized', next_payment_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() },
    };
    const res = await runTool('manage_reminder', {
      action: 'create', items: [{ content: 'Cita con el dentista', targetTime: new Date(Date.now() + 26 * 60 * 60 * 1000).toISOString() }],
    }, user);
    expect(res.success).toBe(true);
    expect(res.action).toBe('created_reminders_batch');
  });

  it('should allow users outside the experimental gate to create future-day reminders', async () => {
    const users = [
      { id: 'new', phone_number: '573118588249', timezone: 'America/Bogota', locale: 'es-CO', is_admin: false, subscription: null },
      { id: 'existing', phone_number: '573001112233', timezone: 'America/Bogota', locale: 'es-CO', is_admin: false, subscription: null },
      { id: 'bsuid', phone_number: 'CO.1552339023039755', timezone: 'America/Bogota', locale: 'es-CO', is_admin: false, subscription: null },
    ];
    for (const user of users) {
      const res = await runTool('manage_reminder', {
        action: 'create', items: [{ content: `Recordatorio ${user.id}`, targetTime: new Date(Date.now() + 26 * 60 * 60 * 1000).toISOString(), recurrence: 'weekly' }],
      }, user);
      expect(res.success).toBe(true);
      expect(res.action).toBe('created_reminders_batch');
    }
  });

  it('should generate subscription checkout link through manage_subscription', async () => {
    const user = { id: 'test-user-uuid-1', phone_number: '573001112233', timezone: 'America/Bogota', locale: 'es-CO', is_admin: false };
    const mockInitPoint = 'https://www.mercadopago.com.co/subscriptions/checkout?preapproval_id=test_sub_123';
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/preapproval_plan/search')) {
        return { ok: true, json: async () => ({ results: [{
          id: 'test_sub_123', reason: 'Hermes TempleLabs Pro', init_point: mockInitPoint,
          status: 'active', auto_recurring: { transaction_amount: 49900 },
        }] }) };
      }
      return { ok: true, json: async () => ({ id: 'test_sub_123', init_point: mockInitPoint, status: 'active' }) };
    });
    const res = await runTool('manage_subscription', { action: 'get_link' }, user);
    expect(res.success).toBe(true);
    expect(res.action).toBe('subscription_link_generated');
    expect(res.data.checkout_url).toBe(mockInitPoint);
    expect(res.data.amount).toBe(49900);
    fetchSpy.mockRestore();
  });

  it('should generate Lemon Squeezy checkout link through manage_subscription for international user 19164158325', async () => {
    const user = { id: 'test-user-1916', phone_number: '19164158325', timezone: 'America/Bogota', locale: 'es-CO', is_admin: false };
    const res = await runTool('manage_subscription', { action: 'get_link' }, user);
    expect(res.success).toBe(true);
    expect(res.action).toBe('subscription_link_generated');
    expect(res.data.checkout_url).toContain('lemonsqueezy.com');
    expect(res.data.checkout_url).toContain('checkout%5Bcustom%5D%5Bphone%5D=19164158325');
    expect(res.data.provider).toBe('Lemon Squeezy');
    expect(res.data.amount).toBe(9.99);
    expect(res.data.currency).toBe('USD');
    expect(res.rawSummary).toContain('Lemon Squeezy');
  });

  it('should generate Stripe checkout link with clean short vanity link when BILLING_PROVIDER=stripe', async () => {
    process.env.BILLING_PROVIDER = 'stripe';
    process.env.STRIPE_CHECKOUT_URL = 'https://buy.stripe.com/8x2dR9dZsez51usg3A73G03';
    const user = { id: 'test-user-1916', phone_number: '19164158325', timezone: 'America/Bogota', locale: 'es-CO', is_admin: false };
    const res = await runTool('manage_subscription', { action: 'get_link' }, user);
    expect(res.success).toBe(true);
    expect(res.action).toBe('subscription_link_generated');
    expect(res.data.checkout_url).toContain('buy.stripe.com/8x2dR9dZsez51usg3A73G03');
    expect(res.data.checkout_url).toContain('client_reference_id=test-user-1916');
    expect(res.rawSummary).toContain('https://hermes.templelabs.co/pay?ref=test-user-1916');
    expect(res.ctaUrl).toBe(res.data.checkout_url);
    expect(res.confirmation).toBe(res.rawSummary);
    expect(res.data.formattedCard).toBe(res.rawSummary);
    expect(res.ctaButtonText).toBe('Pagar ahora');
    delete process.env.BILLING_PROVIDER;
  });

  it('should cancel subscription in MercadoPago and return confirmation', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'test_sub_123', status: 'cancelled' }) });
    const cancelRes = await cancelPreapproval('test_sub_123');
    expect(cancelRes.status).toBe('cancelled');
    expect(fetchSpy).toHaveBeenCalledWith('https://api.mercadopago.com/preapproval/test_sub_123', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ status: 'cancelled' }),
    }));
    fetchSpy.mockRestore();
  });

  it('should execute manage_subscription with action cancel via canonical executeTool', async () => {
    const user = { id: 'test-user-uuid-1', phone_number: '573001112233', timezone: 'America/Bogota', locale: 'es-CO', is_admin: false };
    const res = await runTool('manage_subscription', { action: 'cancel' }, user);
    expect(res.success).toBe(true);
    expect(res.action).toBe('subscription_cancelled');
    expect(res.rawSummary).toContain('cancelada');
  });
});

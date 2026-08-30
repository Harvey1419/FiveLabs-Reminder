import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hasProAccess } from '../src/db/subscriptions.js';
import { createPreapproval, getPreapproval, verifyWebhookSignature } from '../src/services/mercadopago.js';
import { handleMercadoPagoWebhook } from '../src/webhooks/mercadopagoWebhook.js';
import { executeTool } from '../src/ai/tools.js';

vi.mock('../src/db/index.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    saveReminder: vi.fn().mockResolvedValue({ id: 'rem-123' }),
    cancelReminders: vi.fn().mockResolvedValue({ cancelledCount: 0, remainingCount: 0 }),
    createPendingSubscription: vi.fn().mockResolvedValue(true),
  };
});
describe('Subscription Access Control (hasProAccess)', () => {
  it('should grant Pro access to admin users unconditionally', () => {
    const adminUser = { is_admin: true };
    expect(hasProAccess(null, adminUser)).toBe(true);
    expect(hasProAccess({ plan: 'free', status: 'active' }, adminUser)).toBe(true);
  });

  it('should deny Pro access when no subscription is present for regular users', () => {
    const regularUser = { is_admin: false };
    expect(hasProAccess(null, regularUser)).toBe(false);
  });

  it('should deny Pro access for free tier plan', () => {
    const regularUser = { is_admin: false };
    const freeSub = { plan: 'free', status: 'active' };
    expect(hasProAccess(freeSub, regularUser)).toBe(false);
  });

  it('should grant Pro access for active/authorized Pro subscription', () => {
    const regularUser = { is_admin: false };
    const proSub = {
      plan: 'pro',
      status: 'authorized',
      next_payment_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    };
    expect(hasProAccess(proSub, regularUser)).toBe(true);
  });

  it('should grant Pro access for cancelled subscription if current period is not expired', () => {
    const regularUser = { is_admin: false };
    const cancelledSub = {
      plan: 'pro',
      status: 'cancelled',
      next_payment_date: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
      canceled_at: new Date().toISOString(),
    };
    expect(hasProAccess(cancelledSub, regularUser)).toBe(true);
  });

  it('should deny Pro access for cancelled subscription if current period has expired', () => {
    const regularUser = { is_admin: false };
    const expiredSub = {
      plan: 'pro',
      status: 'cancelled',
      next_payment_date: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), // Yesterday
      canceled_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    };
    expect(hasProAccess(expiredSub, regularUser)).toBe(false);
  });

  it('should grant Pro access for paused subscription if current period has not expired', () => {
    const regularUser = { is_admin: false };
    const pausedSub = {
      plan: 'pro',
      status: 'paused',
      next_payment_date: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
    };
    expect(hasProAccess(pausedSub, regularUser)).toBe(true);
  });
});

describe('MercadoPago Service Client', () => {
  beforeEach(() => {
    process.env.MP_ACCESS_TOKEN = 'TEST-TOKEN-12345';
    process.env.APP_BASE_URL = 'https://fivelabs-reminder-production.up.railway.app';
  });

  it('should call MercadoPago API to create preapproval checkout', async () => {
    const mockResponse = {
      id: '2c938084726fca480172750000000000',
      init_point: 'https://www.mercadopago.com.co/subscriptions/checkout?preapproval_id=2c938084726fca480172750000000000',
      status: 'pending',
      external_reference: 'user-uuid-123',
    };

    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await createPreapproval({
      userId: 'user-uuid-123',
      amount: 49900,
      currency: 'COP',
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.mercadopago.com/preapproval',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'Bearer TEST-TOKEN-12345',
          'Content-Type': 'application/json',
        }),
      })
    );

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
      id: '2c938084726fca480172750000000000',
      status: 'authorized',
      next_payment_date: '2026-09-29T12:00:00.000Z',
      external_reference: 'user-uuid-123',
    };

    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await getPreapproval('2c938084726fca480172750000000000');
    expect(result.status).toBe('authorized');
    expect(result.next_payment_date).toBe('2026-09-29T12:00:00.000Z');

    fetchSpy.mockRestore();
  });

  it('should verify webhook HMAC signature', () => {
    process.env.MP_WEBHOOK_SECRET = 'my_secret_key_123';

    // Mock request with raw body
    const rawBody = Buffer.from(JSON.stringify({ data: { id: '123' } }));
    const crypto = require('crypto');
    const signature = crypto.createHmac('sha256', 'my_secret_key_123').update(rawBody).digest('hex');

    const req = {
      headers: {
        'x-signature': `ts=1700000000,v1=${signature}`,
      },
      body: { data: { id: '123' } },
      rawBody,
    };

    expect(verifyWebhookSignature(req)).toBe(true);

    const invalidReq = {
      headers: {
        'x-signature': `ts=1700000000,v1=invalidhash`,
      },
      body: { data: { id: '123' } },
      rawBody,
    };

    expect(verifyWebhookSignature(invalidReq)).toBe(false);
  });
});

describe('AI Tools & Plan Tier Gating', () => {
  it('should allow free users to create same-day reminders', async () => {
    const freeUser = {
      id: 'free-user-uuid',
      phone_number: '573001112233',
      timezone: 'America/Bogota',
      locale: 'es-CO',
      is_admin: false,
      subscription: { plan: 'free', status: 'active' },
    };

    // Calculate a time for today: 2 hours from now
    const twoHoursLater = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

    const res = await executeTool(
      'manage_reminder',
      {
        action: 'create',
        items: [{ content: 'Comprar leche hoy', targetTime: twoHoursLater }],
      },
      freeUser
    );

    expect(res.success).toBe(true);
    expect(res.action).toBe('created_reminders_batch');
  });

  it('should block free users from creating future-day reminders and offer Pro', async () => {
    const freeUser = {
      id: 'free-user-uuid',
      phone_number: '573001112233',
      timezone: 'America/Bogota',
      locale: 'es-CO',
      is_admin: false,
      subscription: { plan: 'free', status: 'active' },
    };

    // Calculate a time for tomorrow: 26 hours from now
    const tomorrowIso = new Date(Date.now() + 26 * 60 * 60 * 1000).toISOString();

    const res = await executeTool(
      'manage_reminder',
      {
        action: 'create',
        items: [{ content: 'Cita con el doctor mañana', targetTime: tomorrowIso }],
      },
      freeUser
    );

    expect(res.success).toBe(false);
    expect(res.action).toBe('tier_limit_exceeded');
    expect(res.isProFeature).toBe(true);
    expect(res.rawSummary).toContain('Reminder Pro');
  });

  it('should block free users from creating recurring reminders', async () => {
    const freeUser = {
      id: 'free-user-uuid',
      phone_number: '573001112233',
      timezone: 'America/Bogota',
      locale: 'es-CO',
      is_admin: false,
      subscription: { plan: 'free', status: 'active' },
    };

    const res = await executeTool(
      'manage_reminder',
      {
        action: 'create',
        items: [{ content: 'Tomar pastilla todos los días a las 8am', targetTime: '08:00', recurrence: 'daily' }],
      },
      freeUser
    );

    expect(res.success).toBe(false);
    expect(res.action).toBe('tier_limit_exceeded');
    expect(res.isProFeature).toBe(true);
  });

  it('should allow Pro users to create future-day and recurring reminders', async () => {
    const proUser = {
      id: 'pro-user-uuid',
      phone_number: '573009998877',
      timezone: 'America/Bogota',
      locale: 'es-CO',
      is_admin: false,
      subscription: {
        plan: 'pro',
        status: 'authorized',
        next_payment_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      },
    };

    const tomorrowIso = new Date(Date.now() + 26 * 60 * 60 * 1000).toISOString();

    const res = await executeTool(
      'manage_reminder',
      {
        action: 'create',
        items: [{ content: 'Cita con el dentista la próxima semana', targetTime: tomorrowIso }],
      },
      proUser
    );

    expect(res.success).toBe(true);
    expect(res.action).toBe('created_reminders_batch');
  });

  it('should generate subscription checkout link when get_subscription_link is called', async () => {
    const user = {
      id: 'test-user-uuid-1',
      phone_number: '573001112233',
      timezone: 'America/Bogota',
      locale: 'es-CO',
      is_admin: false,
      subscription: null,
    };

    const mockInitPoint = 'https://www.mercadopago.com.co/subscriptions/checkout?preapproval_id=test_sub_123';
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'test_sub_123',
        init_point: mockInitPoint,
        status: 'pending',
        external_reference: user.id,
      }),
    });

    const res = await executeTool('get_subscription_link', {}, user);

    expect(res.success).toBe(true);
    expect(res.action).toBe('subscription_link_generated');
    expect(res.data.checkout_url).toBe(mockInitPoint);
    expect(res.data.amount).toBe(49900);

    fetchSpy.mockRestore();
  });
});

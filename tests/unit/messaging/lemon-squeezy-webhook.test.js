import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';

const testSecret = 'test_lemon_secret_123';
process.env.LEMON_SQUEEZY_WEBHOOK_SECRET = testSecret;

vi.mock('../../../src/infrastructure/database/index.js', () => {
  const users = [
    {
      id: 'user-uuid-1',
      phone_number: '19164158325',
      email: 'founder@templelabs.co',
      locale: 'es-CO',
    },
    {
      id: 'user-uuid-2',
      phone_number: '573001112233',
      email: 'international@example.com',
      locale: 'en-US',
    },
  ];

  let subscriptions = [];

  const mockSupabase = {
    from: vi.fn((table) => {
      if (table === 'users') {
        let matched = null;
        const chain = {
          select: vi.fn(() => chain),
          eq: vi.fn((col, val) => {
            if (col === 'id') matched = users.find((u) => u.id === val);
            if (col === 'phone_number') matched = users.find((u) => u.phone_number === val);
            if (col === 'email') matched = users.find((u) => u.email === val);
            return chain;
          }),
          maybeSingle: vi.fn(async () => ({ data: matched || null, error: null })),
        };
        return chain;
      }

      if (table === 'subscriptions') {
        let filterSubId = null;
        let filterUserId = null;
        const chain = {
          select: vi.fn(() => chain),
          or: vi.fn((expr) => {
            // parse mp_preapproval_id.eq.X,user_id.eq.Y
            const parts = String(expr).split(',');
            for (const p of parts) {
              if (p.startsWith('mp_preapproval_id.eq.')) filterSubId = p.replace('mp_preapproval_id.eq.', '');
              if (p.startsWith('user_id.eq.')) filterUserId = p.replace('user_id.eq.', '');
            }
            return chain;
          }),
          order: vi.fn(() => chain),
          limit: vi.fn(() => chain),
          maybeSingle: vi.fn(async () => {
            const found = subscriptions.find((s) => s.mp_preapproval_id === filterSubId || s.user_id === filterUserId);
            return { data: found || null, error: null };
          }),
          insert: vi.fn(async (row) => {
            const created = { id: `sub-${Date.now()}`, ...row };
            subscriptions.push(created);
            return { data: created, error: null };
          }),
          update: vi.fn((updates) => {
            let targetCol = null;
            let targetVal = null;
            const updateChain = {
              eq: vi.fn(async (col, val) => {
                targetCol = col;
                targetVal = val;
                for (const s of subscriptions) {
                  if (s[col] === val) {
                    Object.assign(s, updates);
                  }
                }
                return { error: null };
              }),
            };
            return updateChain;
          }),
        };
        return chain;
      }

      return {
        select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn() })) })),
      };
    }),
  };

  return {
    supabase: mockSupabase,
    __getSubscriptions: () => subscriptions,
    __resetSubscriptions: () => {
      subscriptions = [];
    },
  };
});

vi.mock('../../../src/integrations/whatsapp/kapso-client.js', () => ({
  sendWhatsAppText: vi.fn(async () => ({ success: true, messageId: 'wamid.welcome' })),
  sendWhatsAppTemplate: vi.fn(async () => ({ success: true, messageId: 'wamid.template' })),
}));

const {
  verifyLemonSqueezySignature,
  buildLemonSqueezyCheckoutUrl,
} = await import('../../../src/integrations/lemon-squeezy/client.js');
const { handleLemonSqueezyWebhook } = await import('../../../src/http/webhooks/lemon-squeezy.js');
const { sendWhatsAppText } = await import('../../../src/integrations/whatsapp/kapso-client.js');
const { supabase, __getSubscriptions, __resetSubscriptions } = await import('../../../src/infrastructure/database/index.js');

describe('Lemon Squeezy integration & webhook handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetSubscriptions();
  });

  it('verifies a valid HMAC-SHA256 signature and rejects an invalid one', () => {
    const rawPayload = JSON.stringify({ meta: { event_name: 'test' }, data: { id: '1' } });
    const validSignature = crypto.createHmac('sha256', testSecret).update(rawPayload).digest('hex');

    const validReq = {
      headers: { 'x-signature': validSignature },
      rawBody: Buffer.from(rawPayload),
      body: JSON.parse(rawPayload),
    };
    expect(verifyLemonSqueezySignature(validReq)).toBe(true);

    const invalidReq = {
      headers: { 'x-signature': 'deadbeef00000000000000000000000000000000000000000000000000000000' },
      rawBody: Buffer.from(rawPayload),
      body: JSON.parse(rawPayload),
    };
    expect(verifyLemonSqueezySignature(invalidReq)).toBe(false);

    const missingReq = {
      headers: {},
      rawBody: Buffer.from(rawPayload),
    };
    expect(verifyLemonSqueezySignature(missingReq)).toBe(false);
  });

  it('builds a canonical checkout URL with customer custom parameters', () => {
    const url = buildLemonSqueezyCheckoutUrl({
      userId: 'user-123',
      phoneNumber: '+573001234567',
      email: 'customer@test.com',
    });

    expect(url).toContain('https://hermes-templelabs.lemonsqueezy.com/checkout/buy/80fd049b-c823-4446-9c7e-cf34373e53b9');
    expect(url).toContain('checkout%5Bcustom%5D%5Buser_id%5D=user-123');
    expect(url).toContain('checkout%5Bcustom%5D%5Bphone%5D=%2B573001234567');
    expect(url).toContain('checkout%5Bemail%5D=customer%40test.com');
  });

  it('rejects an unauthorized webhook request with 401 status', async () => {
    const req = {
      headers: { 'x-signature': 'bad_sig' },
      body: {},
    };
    const res = {
      status: vi.fn(() => res),
      json: vi.fn(),
    };

    await handleLemonSqueezyWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized: Invalid signature' });
  });

  it('activates Pro subscription and sends WhatsApp welcome on subscription_created with custom user_id', async () => {
    const payload = {
      meta: {
        event_name: 'subscription_created',
        custom_data: { user_id: 'user-uuid-1', phone: '19164158325' },
      },
      data: {
        id: 'sub_ls_9999',
        type: 'subscriptions',
        attributes: {
          status: 'active',
          user_email: 'founder@templelabs.co',
          renews_at: '2026-10-15T00:00:00.000Z',
        },
      },
    };

    const rawPayload = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', testSecret).update(rawPayload).digest('hex');

    const req = {
      headers: { 'x-signature': signature },
      rawBody: Buffer.from(rawPayload),
      body: payload,
    };
    const res = {
      status: vi.fn(() => res),
      json: vi.fn(),
    };

    await handleLemonSqueezyWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);

    const subs = __getSubscriptions();
    expect(subs.length).toBe(1);
    expect(subs[0]).toMatchObject({
      user_id: 'user-uuid-1',
      mp_preapproval_id: 'ls_sub_ls_9999',
      plan: 'pro',
      status: 'authorized',
      next_payment_date: '2026-10-15T00:00:00.000Z',
    });

    expect(sendWhatsAppText).toHaveBeenCalledWith(expect.objectContaining({
      phoneNumber: '19164158325',
      text: expect.stringContaining('¡Bienvenido a Reminder Pro!'),
    }));
  });

  it('marks subscription as cancelled on subscription_cancelled event', async () => {
    // Seed existing active subscription
    const existing = {
      id: 'sub-existing',
      user_id: 'user-uuid-1',
      mp_preapproval_id: 'ls_sub_cancel_123',
      plan: 'pro',
      status: 'authorized',
    };
    __getSubscriptions().push(existing);

    const payload = {
      meta: {
        event_name: 'subscription_cancelled',
      },
      data: {
        id: 'sub_cancel_123',
        attributes: {
          status: 'cancelled',
        },
      },
    };

    const rawPayload = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', testSecret).update(rawPayload).digest('hex');

    const req = {
      headers: { 'x-signature': signature },
      rawBody: Buffer.from(rawPayload),
      body: payload,
    };
    const res = {
      status: vi.fn(() => res),
      json: vi.fn(),
    };

    await handleLemonSqueezyWebhook(req, res);

    expect(existing.status).toBe('cancelled');
    expect(existing.plan).toBe('free');
    expect(existing.canceled_at).toBeDefined();
  });
});

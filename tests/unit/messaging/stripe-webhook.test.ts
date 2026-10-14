type SubscriptionFixture = { id: string; [field: string]: unknown };
type FixtureStore = { __resetSubscriptions(): void; __getSubscriptions(): SubscriptionFixture[] };
import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';

const testSecret = 'whsec_test_stripe_secret_999';
process.env.STRIPE_WEBHOOK_SECRET = testSecret;

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

  let subscriptions: SubscriptionFixture[] = [];

  const mockSupabase = {
    from: vi.fn((table: string) => {
      if (table === 'users') {
        let matched: typeof users[number] | null | undefined = null;
        const chain = {
          select: vi.fn(() => chain),
          eq: vi.fn((col: string, val: unknown) => {
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
        let filterSubId: unknown = null;
        let filterUserId: unknown = null;
        const chain = {
          select: vi.fn(() => chain),
          or: vi.fn((expr: unknown) => {
            const parts = String(expr).split(',');
            for (const p of parts) {
              if (p.startsWith('mp_preapproval_id.eq.')) filterSubId = p.replace('mp_preapproval_id.eq.', '');
              if (p.startsWith('user_id.eq.')) filterUserId = p.replace('user_id.eq.', '');
            }
            return chain;
          }),
          eq: vi.fn((col: string, val: unknown) => {
            if (col === 'mp_preapproval_id') filterSubId = val;
            if (col === 'id') filterSubId = val;
            return chain;
          }),
          order: vi.fn(() => chain),
          limit: vi.fn(() => chain),
          maybeSingle: vi.fn(async () => {
            const found = subscriptions.find((s) => s.mp_preapproval_id === filterSubId || s.user_id === filterUserId);
            return { data: found || null, error: null };
          }),
          insert: vi.fn(async (row: Record<string, unknown>) => {
            const created = { id: `sub-row-${subscriptions.length + 1}`, ...row };
            subscriptions.push(created);
            return { data: created, error: null };
          }),
          update: vi.fn((patch: Record<string, unknown>) => ({
            eq: vi.fn(async (col: string, val: unknown) => {
              const target = subscriptions.find((s) => s[col] === val || s.mp_preapproval_id === val);
              if (target) {
                Object.assign(target, patch);
              }
              return { data: target || null, error: null };
            }),
          })),
        };
        return chain;
      }

      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn(async () => ({ data: null, error: null })),
      };
    }),
    __resetSubscriptions: () => {
      subscriptions = [];
    },
    __getSubscriptions: () => subscriptions,
  };

  return { supabase: mockSupabase };
});

vi.mock('../../../src/integrations/whatsapp/kapso-client.js', () => ({
  sendWhatsAppText: vi.fn().mockResolvedValue({ success: true }),
  sendWhatsAppTemplate: vi.fn().mockResolvedValue({ success: true }),
}));

const { supabase: database } = await import('../../../src/infrastructure/database/index.js');
const { sendWhatsAppText, sendWhatsAppTemplate } = await import(
  '../../../src/integrations/whatsapp/kapso-client.js'
);
const { handleStripeWebhook } = await import('../../../src/http/webhooks/stripe.js');

// These methods exist only on the controlled vi.mock store above.
const supabase = database as unknown as FixtureStore;

function makeStripeSignature(body: unknown, secret = testSecret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  const sig = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return {
    header: `t=${timestamp},v1=${sig}`,
    rawBody,
  };
}

describe('Stripe Webhook Handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    supabase.__resetSubscriptions();
    process.env.STRIPE_WEBHOOK_SECRET = testSecret;
  });

  it('rejects unauthenticated requests with invalid signature', async () => {
    const req = {
      headers: { 'stripe-signature': 't=123,v1=bad_signature' },
      body: { type: 'checkout.session.completed' },
      rawBody: JSON.stringify({ type: 'checkout.session.completed' }),
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    await handleStripeWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
  });

  it('processes checkout.session.completed with client_reference_id and sends welcome message', async () => {
    const payload = {
      id: 'evt_test_checkout',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_session_123',
          client_reference_id: 'user-uuid-1',
          subscription: 'sub_stripe_abc123',
          customer_details: {
            email: 'founder@templelabs.co',
            phone: '+19164158325',
          },
        },
      },
    };

    const { header, rawBody } = makeStripeSignature(payload);
    const req = {
      headers: { 'stripe-signature': header },
      body: payload,
      rawBody,
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    await handleStripeWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ received: true });

    const subs = supabase.__getSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      user_id: 'user-uuid-1',
      mp_preapproval_id: 'sub_stripe_abc123',
      plan: 'pro',
      status: 'authorized',
    });

    expect(sendWhatsAppText).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumber: '19164158325',
        text: expect.stringContaining('¡Bienvenido a Reminder Pro!'),
      })
    );
  });

  it('processes customer.subscription.updated to active', async () => {
    // Seed initial subscription
    const subs = supabase.__getSubscriptions();
    subs.push({
      id: 'sub-row-1',
      user_id: 'user-uuid-1',
      mp_preapproval_id: 'sub_stripe_abc123',
      plan: 'pro',
      status: 'paused',
    });

    const payload = {
      id: 'evt_test_sub_updated',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_stripe_abc123',
          status: 'active',
          current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
        },
      },
    };

    const { header, rawBody } = makeStripeSignature(payload);
    const req = {
      headers: { 'stripe-signature': header },
      body: payload,
      rawBody,
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    await handleStripeWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(subs[0]!.status).toBe('authorized');
    expect(subs[0]!.plan).toBe('pro');
  });

  it('processes customer.subscription.deleted and downgrades user to free', async () => {
    const subs = supabase.__getSubscriptions();
    subs.push({
      id: 'sub-row-1',
      user_id: 'user-uuid-1',
      mp_preapproval_id: 'sub_stripe_abc123',
      plan: 'pro',
      status: 'authorized',
    });

    const payload = {
      id: 'evt_test_sub_deleted',
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_stripe_abc123',
          status: 'canceled',
        },
      },
    };

    const { header, rawBody } = makeStripeSignature(payload);
    const req = {
      headers: { 'stripe-signature': header },
      body: payload,
      rawBody,
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    await handleStripeWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(subs[0]!.status).toBe('cancelled');
    expect(subs[0]!.plan).toBe('free');
    expect(subs[0]!.canceled_at).toBeDefined();
  });

  it('processes checkout.session.completed with client_reference_id containing phone number', async () => {
    supabase.__resetSubscriptions();

    const payload = {
      id: 'evt_test_checkout_phone',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_session_phone',
          client_reference_id: '19164158325',
          subscription: 'sub_stripe_phone123',
          customer_details: {
            email: 'unmatched@random.com',
          },
        },
      },
    };

    const { header, rawBody } = makeStripeSignature(payload);
    const req = {
      headers: { 'stripe-signature': header },
      body: payload,
      rawBody,
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    await handleStripeWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const subs = supabase.__getSubscriptions();
    expect(subs.length).toBe(1);
    expect(subs[0]).toMatchObject({
      user_id: 'user-uuid-1',
      mp_preapproval_id: 'sub_stripe_phone123',
      plan: 'pro',
      status: 'authorized',
    });
  });
});

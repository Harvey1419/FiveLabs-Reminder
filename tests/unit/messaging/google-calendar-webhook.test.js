import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../../src/infrastructure/database/integrations.js', () => ({
  getUserIntegrationByChannelId: vi.fn(),
  updateUserIntegrationMetadata: vi.fn(),
}));

vi.mock('../../../src/features/calendar/reconciliation.js', () => ({
  reconcileCalendarCompanionReminders: vi.fn(),
}));

const { getUserIntegrationByChannelId, updateUserIntegrationMetadata } = await import('../../../src/infrastructure/database/integrations.js');
const { reconcileCalendarCompanionReminders } = await import('../../../src/features/calendar/reconciliation.js');
const { handleGoogleCalendarWebhook } = await import('../../../src/http/webhooks/google-calendar.js');

describe('Google Calendar Push Notification Webhook Handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects request if X-Goog-Channel-ID header is missing', async () => {
    const req = { headers: {} };
    const res = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
    };

    await handleGoogleCalendarWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith('Missing X-Goog-Channel-ID header');
  });

  it('acknowledges sync handshake without triggering reconciliation', async () => {
    const req = {
      headers: {
        'x-goog-channel-id': 'chan-1234',
        'x-goog-resource-state': 'sync',
      },
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
    };

    await handleGoogleCalendarWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith('OK');
    expect(reconcileCalendarCompanionReminders).not.toHaveBeenCalled();
  });

  it('triggers real-time companion reconciliation with notifyOnDiscovery on exists state with token userId', async () => {
    const req = {
      headers: {
        'x-goog-channel-id': 'chan-1234',
        'x-goog-resource-state': 'exists',
        'x-goog-channel-token': 'userId=user-abc-123',
      },
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
    };

    await handleGoogleCalendarWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(reconcileCalendarCompanionReminders).toHaveBeenCalledWith({
      userId: 'user-abc-123',
      notifyOnDiscovery: true,
    });
    expect(updateUserIntegrationMetadata).toHaveBeenCalledWith('user-abc-123', 'google', expect.objectContaining({
      lastWebhookReceivedAt: expect.any(String),
    }));
  });

  it('resolves userId from database when token does not embed userId', async () => {
    getUserIntegrationByChannelId.mockResolvedValue({
      user_id: 'user-db-789',
      metadata: { channelId: 'chan-5678' },
    });

    const req = {
      headers: {
        'x-goog-channel-id': 'chan-5678',
        'x-goog-resource-state': 'exists',
      },
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
    };

    await handleGoogleCalendarWebhook(req, res);

    expect(getUserIntegrationByChannelId).toHaveBeenCalledWith('chan-5678', 'google');
    expect(reconcileCalendarCompanionReminders).toHaveBeenCalledWith({
      userId: 'user-db-789',
      notifyOnDiscovery: true,
    });
  });
});

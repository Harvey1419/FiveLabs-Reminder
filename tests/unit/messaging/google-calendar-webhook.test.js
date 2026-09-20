import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../../src/infrastructure/database/integrations.js', () => ({
  getUserIntegration: vi.fn(),
  getUserIntegrationByChannelId: vi.fn(),
  updateUserIntegrationMetadata: vi.fn(),
}));

vi.mock('../../../src/features/calendar/reconciliation.js', () => ({
  reconcileCalendarCompanionReminders: vi.fn(),
}));

vi.mock('../../../src/integrations/google/calendar.js', () => ({
  listIncrementalCalendarEvents: vi.fn(),
}));

const {
  getUserIntegration,
  getUserIntegrationByChannelId,
  updateUserIntegrationMetadata,
} = await import('../../../src/infrastructure/database/integrations.js');
const { reconcileCalendarCompanionReminders } = await import('../../../src/features/calendar/reconciliation.js');
const { listIncrementalCalendarEvents } = await import('../../../src/integrations/google/calendar.js');
const { handleGoogleCalendarWebhook } = await import('../../../src/http/webhooks/google-calendar.js');

describe('Google Calendar Push Notification Webhook Handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserIntegration.mockResolvedValue({
      user_id: 'user-abc-123',
      metadata: { calendarSyncToken: 'sync-token-1' },
    });
    listIncrementalCalendarEvents.mockResolvedValue({
      items: [{ id: 'event-new-1', status: 'confirmed' }],
      nextSyncToken: 'sync-token-2',
      fullSync: false,
    });
    reconcileCalendarCompanionReminders.mockResolvedValue({
      synced: true,
      createdCount: 1,
      updatedCount: 0,
      cancelledCount: 0,
    });
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

  it('acknowledges sync handshake without announcing existing events when baseline already exists', async () => {
    const req = {
      headers: {
        'x-goog-channel-id': 'chan-1234',
        'x-goog-resource-state': 'sync',
        'x-goog-channel-token': 'userId=user-abc-123',
      },
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
    };

    await handleGoogleCalendarWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith('OK');
    expect(listIncrementalCalendarEvents).not.toHaveBeenCalled();
    expect(reconcileCalendarCompanionReminders).not.toHaveBeenCalled();
  });

  it('establishes a silent baseline on sync handshake when no sync token exists', async () => {
    getUserIntegration.mockResolvedValue({
      user_id: 'user-abc-123',
      metadata: {},
    });
    listIncrementalCalendarEvents.mockResolvedValue({
      items: [{ id: 'existing-event', status: 'confirmed' }],
      nextSyncToken: 'baseline-token',
      fullSync: true,
    });

    const req = {
      headers: {
        'x-goog-channel-id': 'chan-1234',
        'x-goog-resource-state': 'sync',
        'x-goog-channel-token': 'userId=user-abc-123',
      },
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
    };

    await handleGoogleCalendarWebhook(req, res);

    expect(reconcileCalendarCompanionReminders).toHaveBeenCalledWith({
      userId: 'user-abc-123',
      notifyOnDiscovery: false,
    });
    expect(updateUserIntegrationMetadata).toHaveBeenCalledWith(
      'user-abc-123',
      'google',
      expect.objectContaining({ calendarSyncToken: 'baseline-token' }),
    );
  });

  it('only permits proactive notices for event ids present in the incremental delta', async () => {
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

    expect(listIncrementalCalendarEvents).toHaveBeenCalledWith('user-abc-123', {
      syncToken: 'sync-token-1',
    });
    expect(reconcileCalendarCompanionReminders).toHaveBeenCalledWith({
      userId: 'user-abc-123',
      notifyOnDiscovery: true,
      notifyEventIds: ['event-new-1'],
    });
    expect(updateUserIntegrationMetadata).toHaveBeenCalledWith(
      'user-abc-123',
      'google',
      expect.objectContaining({
        calendarSyncToken: 'sync-token-2',
        lastWebhookReceivedAt: expect.any(String),
      }),
    );
  });

  it('excludes cancelled events from proactive new-meeting ids', async () => {
    listIncrementalCalendarEvents.mockResolvedValue({
      items: [
        { id: 'event-cancelled', status: 'cancelled' },
        { id: 'event-created', status: 'confirmed' },
      ],
      nextSyncToken: 'sync-token-3',
      fullSync: false,
    });

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

    expect(reconcileCalendarCompanionReminders).toHaveBeenCalledWith({
      userId: 'user-abc-123',
      notifyOnDiscovery: true,
      notifyEventIds: ['event-created'],
    });
  });

  it('fails closed against notification storms when an exists webhook arrives without a baseline', async () => {
    getUserIntegration.mockResolvedValue({
      user_id: 'user-abc-123',
      metadata: {},
    });
    listIncrementalCalendarEvents.mockResolvedValue({
      items: [{ id: 'existing-event', status: 'confirmed' }],
      nextSyncToken: 'baseline-token',
      fullSync: true,
    });

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

    expect(reconcileCalendarCompanionReminders).toHaveBeenCalledTimes(1);
    expect(reconcileCalendarCompanionReminders).toHaveBeenCalledWith({
      userId: 'user-abc-123',
      notifyOnDiscovery: false,
    });
  });

  it('resolves userId from database when token does not embed userId', async () => {
    getUserIntegrationByChannelId.mockResolvedValue({
      user_id: 'user-db-789',
      metadata: { calendarSyncToken: 'sync-db-1' },
    });
    listIncrementalCalendarEvents.mockResolvedValue({
      items: [{ id: 'event-db-1', status: 'confirmed' }],
      nextSyncToken: 'sync-db-2',
      fullSync: false,
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
      notifyEventIds: ['event-db-1'],
    });
  });
});

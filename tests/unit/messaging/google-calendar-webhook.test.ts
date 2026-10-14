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
  stopGoogleCalendarWatch: vi.fn(async () => true),
}));

const {
  getUserIntegration,
  getUserIntegrationByChannelId,
  updateUserIntegrationMetadata,
} = await import('../../../src/infrastructure/database/integrations.js');
const { reconcileCalendarCompanionReminders } = await import('../../../src/features/calendar/reconciliation.js');
const { listIncrementalCalendarEvents, stopGoogleCalendarWatch } = await import('../../../src/integrations/google/calendar.js');
const { handleGoogleCalendarWebhook } = await import('../../../src/http/webhooks/google-calendar.js');

describe('Google Calendar Push Notification Webhook Handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUserIntegration, { partial: true }).mockResolvedValue({
      user_id: 'user-abc-123',
      metadata: { calendarSyncToken: 'sync-token-1' },
    });
    vi.mocked(listIncrementalCalendarEvents, { partial: true }).mockResolvedValue({
      items: [{ id: 'event-new-1', status: 'confirmed' }],
      nextSyncToken: 'sync-token-2',
      fullSync: false,
    });
    vi.mocked(reconcileCalendarCompanionReminders, { partial: true }).mockResolvedValue({
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
    vi.mocked(getUserIntegration, { partial: true }).mockResolvedValue({
      user_id: 'user-abc-123',
      metadata: {},
    });
    vi.mocked(listIncrementalCalendarEvents, { partial: true }).mockResolvedValue({
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
      cancelledEventIds: [],
      extraEvents: [{ id: 'event-new-1', status: 'confirmed' }],
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

  it('does not echo a proactive new-meeting notice for events created by Hermes', async () => {
    vi.mocked(listIncrementalCalendarEvents, { partial: true }).mockResolvedValue({
      items: [
        { id: 'hermesabc123', status: 'confirmed' },
        { id: 'external-event-1', status: 'confirmed' },
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
      notifyEventIds: ['external-event-1'],
      cancelledEventIds: [],
      extraEvents: [{ id: 'external-event-1', status: 'confirmed' }],
    });
  });

  it('excludes cancelled events from proactive new-meeting ids', async () => {
    vi.mocked(listIncrementalCalendarEvents, { partial: true }).mockResolvedValue({
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
      cancelledEventIds: ['event-cancelled'],
      extraEvents: [{ id: 'event-created', status: 'confirmed' }],
    });
  });

  it('fails closed against notification storms when an exists webhook arrives without a baseline', async () => {
    vi.mocked(getUserIntegration, { partial: true }).mockResolvedValue({
      user_id: 'user-abc-123',
      metadata: {},
    });
    vi.mocked(listIncrementalCalendarEvents, { partial: true }).mockResolvedValue({
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
    vi.mocked(getUserIntegrationByChannelId, { partial: true }).mockResolvedValue({
      user_id: 'user-db-789',
      metadata: { calendarSyncToken: 'sync-db-1' },
    });
    vi.mocked(listIncrementalCalendarEvents, { partial: true }).mockResolvedValue({
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
      cancelledEventIds: [],
      extraEvents: [{ id: 'event-db-1', status: 'confirmed' }],
    });
  });

  it('suppresses proactive notifications during full sync recovery after 410 Gone', async () => {
    vi.mocked(listIncrementalCalendarEvents, { partial: true }).mockResolvedValue({
      items: [{ id: 'recovered-event-1', status: 'confirmed' }],
      nextSyncToken: 'new-token-after-410',
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

    expect(reconcileCalendarCompanionReminders).toHaveBeenCalledWith({
      userId: 'user-abc-123',
      notifyOnDiscovery: false,
      notifyEventIds: [],
      cancelledEventIds: [],
      extraEvents: [],
    });
    expect(updateUserIntegrationMetadata).toHaveBeenCalledWith(
      'user-abc-123',
      'google',
      expect.objectContaining({
        calendarSyncToken: 'new-token-after-410',
      }),
    );
  });

  it('drops notifications from obsolete watch channels and requests Google to stop them', async () => {
    vi.mocked(getUserIntegration, { partial: true }).mockResolvedValue({
      user_id: 'user-abc-123',
      metadata: {
        channelId: 'active-chan-new',
        calendarSyncToken: 'sync-token-1',
      },
    });

    const req = {
      headers: {
        'x-goog-channel-id': 'obsolete-chan-old',
        'x-goog-resource-id': 'res-old-999',
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
    expect(res.send).toHaveBeenCalledWith('OK');
    expect(stopGoogleCalendarWatch).toHaveBeenCalledWith({
      userId: 'user-abc-123',
      channelId: 'obsolete-chan-old',
      resourceId: 'res-old-999',
    });
    expect(listIncrementalCalendarEvents).not.toHaveBeenCalled();
    expect(reconcileCalendarCompanionReminders).not.toHaveBeenCalled();
  });

  it('serializes concurrent webhooks for the same user so subsequent calls see the updated syncToken', async () => {
    let currentSyncToken = 'token-initial';
    vi.mocked(getUserIntegration, { partial: true }).mockImplementation(async () => {
      return {
        user_id: 'user-abc-123',
        metadata: {
          channelId: 'chan-1234',
          calendarSyncToken: currentSyncToken,
        },
      };
    });

    vi.mocked(updateUserIntegrationMetadata, { partial: true }).mockImplementation(async (_userId, _provider, updates) => {
      if (updates?.calendarSyncToken) {
        currentSyncToken = updates.calendarSyncToken as string;
      }
      return {};
    });

    vi.mocked(listIncrementalCalendarEvents, { partial: true }).mockImplementation(async (_userId, opts) => {
      if (opts?.syncToken === 'token-initial') {
        // First webhook finds an event and yields next token
        return {
          items: [{ id: 'event-one', status: 'confirmed' }],
          nextSyncToken: 'token-updated-by-first',
          fullSync: false,
        };
      }
      // Second webhook with updated token finds nothing
      return {
        items: [],
        nextSyncToken: 'token-updated-by-first',
        fullSync: false,
      };
    });

    const req1 = {
      headers: {
        'x-goog-channel-id': 'chan-1234',
        'x-goog-resource-state': 'exists',
        'x-goog-channel-token': 'userId=user-abc-123',
      },
    };
    const res1 = { status: vi.fn().mockReturnThis(), send: vi.fn() };

    const req2 = {
      headers: {
        'x-goog-channel-id': 'chan-1234',
        'x-goog-resource-state': 'exists',
        'x-goog-channel-token': 'userId=user-abc-123',
      },
    };
    const res2 = { status: vi.fn().mockReturnThis(), send: vi.fn() };

    // Fire both concurrently
    await Promise.all([
      handleGoogleCalendarWebhook(req1, res1),
      handleGoogleCalendarWebhook(req2, res2),
    ]);

    expect(listIncrementalCalendarEvents).toHaveBeenCalledTimes(2);
    expect(listIncrementalCalendarEvents).toHaveBeenNthCalledWith(1, 'user-abc-123', { syncToken: 'token-initial' });
    expect(listIncrementalCalendarEvents).toHaveBeenNthCalledWith(2, 'user-abc-123', { syncToken: 'token-updated-by-first' });

    // First call notified for event-one, second call had empty changed events
    expect(reconcileCalendarCompanionReminders).toHaveBeenNthCalledWith(1, expect.objectContaining({
      notifyEventIds: ['event-one'],
    }));
    expect(reconcileCalendarCompanionReminders).toHaveBeenNthCalledWith(2, expect.objectContaining({
      notifyEventIds: [],
    }));
  });
});

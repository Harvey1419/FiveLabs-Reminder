import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../../src/infrastructure/database/integrations.js', () => ({
  getAllActiveIntegrations: vi.fn(),
  updateUserIntegrationMetadata: vi.fn(),
}));

vi.mock('../../../src/integrations/google/calendar.js', () => ({
  listIncrementalCalendarEvents: vi.fn(),
  setupGoogleCalendarWatch: vi.fn(),
  stopGoogleCalendarWatch: vi.fn(),
}));

vi.mock('../../../src/features/calendar/reconciliation.js', () => ({
  reconcileCalendarCompanionReminders: vi.fn(),
}));

const {
  getAllActiveIntegrations,
  updateUserIntegrationMetadata,
} = await import('../../../src/infrastructure/database/integrations.js');
const {
  listIncrementalCalendarEvents,
  setupGoogleCalendarWatch,
  stopGoogleCalendarWatch,
} = await import('../../../src/integrations/google/calendar.js');
const { reconcileCalendarCompanionReminders } = await import('../../../src/features/calendar/reconciliation.js');
const { renewExpiringGoogleCalendarWatches } = await import('../../../src/jobs/calendar-watch-renewal.js');

describe('Google Calendar Watch Renewal Worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listIncrementalCalendarEvents.mockResolvedValue({
      items: [],
      nextSyncToken: 'baseline-token',
      fullSync: true,
    });
    updateUserIntegrationMetadata.mockResolvedValue({});
    reconcileCalendarCompanionReminders.mockResolvedValue({
      synced: true,
      createdCount: 0,
      updatedCount: 0,
      cancelledCount: 0,
    });
  });

  it('backfills watch and silent sync baseline for active integration missing both', async () => {
    getAllActiveIntegrations.mockResolvedValue([
      {
        user_id: 'user-unwatched-1',
        metadata: {},
      },
    ]);
    setupGoogleCalendarWatch.mockResolvedValue({
      channelId: 'new-chan-1',
      resourceId: 'res-1',
      expiration: Date.now() + 604800000,
    });

    const result = await renewExpiringGoogleCalendarWatches();

    expect(result.checked).toBe(1);
    expect(result.baselined).toBe(1);
    expect(result.established).toBe(1);
    expect(listIncrementalCalendarEvents).toHaveBeenCalledWith('user-unwatched-1');
    expect(updateUserIntegrationMetadata).toHaveBeenCalledWith(
      'user-unwatched-1',
      'google',
      expect.objectContaining({
        calendarSyncToken: 'baseline-token',
        calendarSyncBaselineAt: expect.any(String),
      }),
    );
    expect(reconcileCalendarCompanionReminders).toHaveBeenCalledWith({
      userId: 'user-unwatched-1',
      notifyOnDiscovery: false,
    });
    expect(setupGoogleCalendarWatch).toHaveBeenCalledWith({ userId: 'user-unwatched-1' });
    expect(stopGoogleCalendarWatch).not.toHaveBeenCalled();
  });

  it('backfills sync baseline for a healthy existing watch without renewing it', async () => {
    const healthyExpirationMs = Date.now() + 5 * 24 * 60 * 60 * 1000;
    getAllActiveIntegrations.mockResolvedValue([
      {
        user_id: 'user-existing-watch',
        metadata: {
          channelId: 'healthy-chan',
          resourceId: 'healthy-res',
          channelExpiration: healthyExpirationMs,
        },
      },
    ]);

    const result = await renewExpiringGoogleCalendarWatches();

    expect(result.baselined).toBe(1);
    expect(result.established).toBe(0);
    expect(listIncrementalCalendarEvents).toHaveBeenCalledWith('user-existing-watch');
    expect(reconcileCalendarCompanionReminders).toHaveBeenCalledWith({
      userId: 'user-existing-watch',
      notifyOnDiscovery: false,
    });
    expect(setupGoogleCalendarWatch).not.toHaveBeenCalled();
    expect(stopGoogleCalendarWatch).not.toHaveBeenCalled();
  });

  it('does not rebuild sync baseline when calendarSyncToken already exists', async () => {
    const healthyExpirationMs = Date.now() + 5 * 24 * 60 * 60 * 1000;
    getAllActiveIntegrations.mockResolvedValue([
      {
        user_id: 'user-baselined',
        metadata: {
          channelId: 'healthy-chan',
          resourceId: 'healthy-res',
          channelExpiration: healthyExpirationMs,
          calendarSyncToken: 'existing-sync-token',
        },
      },
    ]);

    const result = await renewExpiringGoogleCalendarWatches();

    expect(result.baselined).toBe(0);
    expect(listIncrementalCalendarEvents).not.toHaveBeenCalled();
    expect(updateUserIntegrationMetadata).not.toHaveBeenCalled();
    expect(reconcileCalendarCompanionReminders).not.toHaveBeenCalled();
  });

  it('renews watch channel if expiration is within threshold window and stops old channel', async () => {
    const expiringSoonMs = Date.now() + 12 * 60 * 60 * 1000; // 12 hours from now (< 24h)
    getAllActiveIntegrations.mockResolvedValue([
      {
        user_id: 'user-expiring-soon',
        metadata: {
          channelId: 'old-chan-1',
          resourceId: 'old-res-1',
          channelExpiration: expiringSoonMs,
          calendarSyncToken: 'existing-sync-token',
        },
      },
    ]);
    stopGoogleCalendarWatch.mockResolvedValue(true);
    setupGoogleCalendarWatch.mockResolvedValue({
      channelId: 'fresh-chan-1',
      resourceId: 'fresh-res-1',
      expiration: Date.now() + 604800000,
    });

    const result = await renewExpiringGoogleCalendarWatches();

    expect(stopGoogleCalendarWatch).toHaveBeenCalledWith({
      userId: 'user-expiring-soon',
      channelId: 'old-chan-1',
      resourceId: 'old-res-1',
    });
    expect(setupGoogleCalendarWatch).toHaveBeenCalledWith({ userId: 'user-expiring-soon' });
    expect(result.established).toBe(1);
    expect(result.baselined).toBe(0);
  });

  it('skips integrations whose channel and sync baseline are both healthy', async () => {
    const healthyExpirationMs = Date.now() + 5 * 24 * 60 * 60 * 1000; // 5 days from now
    getAllActiveIntegrations.mockResolvedValue([
      {
        user_id: 'user-healthy',
        metadata: {
          channelId: 'healthy-chan',
          resourceId: 'healthy-res',
          channelExpiration: healthyExpirationMs,
          calendarSyncToken: 'existing-sync-token',
        },
      },
    ]);

    const result = await renewExpiringGoogleCalendarWatches();

    expect(result.established).toBe(0);
    expect(result.baselined).toBe(0);
    expect(setupGoogleCalendarWatch).not.toHaveBeenCalled();
    expect(stopGoogleCalendarWatch).not.toHaveBeenCalled();
    expect(listIncrementalCalendarEvents).not.toHaveBeenCalled();
  });

  it('does not count a baseline when Google does not return a sync token', async () => {
    getAllActiveIntegrations.mockResolvedValue([
      {
        user_id: 'user-no-token',
        metadata: {
          channelId: 'healthy-chan',
          resourceId: 'healthy-res',
          channelExpiration: Date.now() + 5 * 24 * 60 * 60 * 1000,
        },
      },
    ]);
    listIncrementalCalendarEvents.mockResolvedValue({
      items: [],
      nextSyncToken: null,
      fullSync: true,
    });

    const result = await renewExpiringGoogleCalendarWatches();

    expect(result.baselined).toBe(0);
    expect(updateUserIntegrationMetadata).not.toHaveBeenCalled();
    expect(reconcileCalendarCompanionReminders).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../../src/infrastructure/database/integrations.js', () => ({
  getAllActiveIntegrations: vi.fn(),
  updateUserIntegrationMetadata: vi.fn(),
}));

vi.mock('../../../src/integrations/google/calendar.js', () => ({
  setupGoogleCalendarWatch: vi.fn(),
  stopGoogleCalendarWatch: vi.fn(),
}));

const { getAllActiveIntegrations } = await import('../../../src/infrastructure/database/integrations.js');
const { setupGoogleCalendarWatch, stopGoogleCalendarWatch } = await import('../../../src/integrations/google/calendar.js');
const { renewExpiringGoogleCalendarWatches } = await import('../../../src/jobs/calendar-watch-renewal.js');

describe('Google Calendar Watch Renewal Worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('backfills watch for active integration that has no watch channel yet', async () => {
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
    expect(result.established).toBe(1);
    expect(setupGoogleCalendarWatch).toHaveBeenCalledWith({ userId: 'user-unwatched-1' });
    expect(stopGoogleCalendarWatch).not.toHaveBeenCalled();
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
  });

  it('skips integrations whose channels are healthy and far from expiration', async () => {
    const healthyExpirationMs = Date.now() + 5 * 24 * 60 * 60 * 1000; // 5 days from now
    getAllActiveIntegrations.mockResolvedValue([
      {
        user_id: 'user-healthy',
        metadata: {
          channelId: 'healthy-chan',
          resourceId: 'healthy-res',
          channelExpiration: healthyExpirationMs,
        },
      },
    ]);

    const result = await renewExpiringGoogleCalendarWatches();

    expect(result.established).toBe(0);
    expect(setupGoogleCalendarWatch).not.toHaveBeenCalled();
    expect(stopGoogleCalendarWatch).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockWatch = vi.fn();
const mockStop = vi.fn();
const mockList = vi.fn();

vi.mock('../../../src/integrations/google/auth.js', () => ({
  getAuthenticatedGoogleClient: vi.fn(async (userId) => {
    if (userId === 'user-no-auth') return null;
    return {};
  }),
  isGoogleAuthError: vi.fn(() => false),
  clearInvalidGoogleIntegration: vi.fn(),
}));

vi.mock('../../../src/infrastructure/database/integrations.js', () => ({
  getUserIntegration: vi.fn(async () => null),
  updateUserIntegrationMetadata: vi.fn(async () => ({})),
}));

vi.mock('googleapis', () => ({
  google: {
    calendar: vi.fn(() => ({
      events: {
        watch: mockWatch,
        list: mockList,
      },
      channels: {
        stop: mockStop,
      },
    })),
  },
}));

const {
  setupGoogleCalendarWatch,
  stopGoogleCalendarWatch,
  listIncrementalCalendarEvents,
} = await import('../../../src/integrations/google/calendar.js');
const {
  getUserIntegration,
  updateUserIntegrationMetadata,
} = await import('../../../src/infrastructure/database/integrations.js');

describe('Google Calendar Watch & Incremental Sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('setupGoogleCalendarWatch', () => {
    it('returns null when user has no Google auth', async () => {
      const res = await setupGoogleCalendarWatch({ userId: 'user-no-auth' });
      expect(res).toBe(null);
    });

    it('establishes watch channel with default 7-day TTL and updates metadata', async () => {
      mockWatch.mockResolvedValue({
        data: {
          id: 'chan-uuid-1',
          resourceId: 'res-id-123',
          expiration: '1727300000000',
        },
      });

      const res = await setupGoogleCalendarWatch({
        userId: 'user-1',
        channelId: 'chan-uuid-1',
      });

      expect(res).toEqual({
        channelId: 'chan-uuid-1',
        resourceId: 'res-id-123',
        expiration: 1727300000000,
      });

      expect(mockWatch).toHaveBeenCalledWith({
        calendarId: 'primary',
        requestBody: expect.objectContaining({
          id: 'chan-uuid-1',
          type: 'web_hook',
          token: 'userId=user-1',
        }),
      });

      expect(updateUserIntegrationMetadata).toHaveBeenCalledWith('user-1', 'google', expect.objectContaining({
        channelId: 'chan-uuid-1',
        resourceId: 'res-id-123',
        channelExpiration: 1727300000000,
      }));
    });

    it('stops previous watch channel if user already has an active channel before establishing new one', async () => {
      getUserIntegration.mockResolvedValueOnce({
        user_id: 'user-1',
        metadata: {
          channelId: 'old-chan-999',
          resourceId: 'old-res-999',
        },
      });

      mockWatch.mockResolvedValue({
        data: {
          id: 'new-chan-111',
          resourceId: 'new-res-111',
          expiration: '1727300000000',
        },
      });
      mockStop.mockResolvedValue({});

      const res = await setupGoogleCalendarWatch({
        userId: 'user-1',
        channelId: 'new-chan-111',
      });

      expect(mockStop).toHaveBeenCalledWith({
        requestBody: {
          id: 'old-chan-999',
          resourceId: 'old-res-999',
        },
      });
      expect(res.channelId).toBe('new-chan-111');
    });
  });

  describe('stopGoogleCalendarWatch', () => {
    it('stops channel on Google and clears metadata when stopping active channel', async () => {
      mockStop.mockResolvedValue({});
      getUserIntegration.mockResolvedValueOnce({
        user_id: 'user-1',
        metadata: { channelId: 'chan-uuid-1', resourceId: 'res-id-123' },
      });

      const res = await stopGoogleCalendarWatch({
        userId: 'user-1',
        channelId: 'chan-uuid-1',
        resourceId: 'res-id-123',
      });

      expect(res).toBe(true);
      expect(mockStop).toHaveBeenCalledWith({
        requestBody: {
          id: 'chan-uuid-1',
          resourceId: 'res-id-123',
        },
      });
      expect(updateUserIntegrationMetadata).toHaveBeenCalledWith('user-1', 'google', {
        channelId: null,
        resourceId: null,
        channelExpiration: null,
      });
    });

    it('stops channel on Google but does NOT clear metadata when stopping an obsolete channel', async () => {
      mockStop.mockResolvedValue({});
      getUserIntegration.mockResolvedValueOnce({
        user_id: 'user-1',
        metadata: { channelId: 'active-chan-new', resourceId: 'res-active-new' },
      });

      const res = await stopGoogleCalendarWatch({
        userId: 'user-1',
        channelId: 'obsolete-chan-old',
        resourceId: 'res-old-999',
      });

      expect(res).toBe(true);
      expect(mockStop).toHaveBeenCalledWith({
        requestBody: {
          id: 'obsolete-chan-old',
          resourceId: 'res-old-999',
        },
      });
      expect(updateUserIntegrationMetadata).not.toHaveBeenCalled();
    });
  });

  describe('listIncrementalCalendarEvents', () => {
    it('fetches incremental events using syncToken', async () => {
      mockList.mockResolvedValue({
        data: {
          items: [{ id: 'evt-1', summary: 'Reunión' }],
          nextSyncToken: 'sync-token-2',
        },
      });

      const res = await listIncrementalCalendarEvents('user-1', {
        syncToken: 'sync-token-1',
      });

      expect(res.fullSync).toBe(false);
      expect(res.items).toHaveLength(1);
      expect(res.nextSyncToken).toBe('sync-token-2');
    });

    it('paginates incremental sync until Google returns the final sync token', async () => {
      mockList
        .mockResolvedValueOnce({
          data: {
            items: [{ id: 'evt-1' }],
            nextPageToken: 'page-2',
          },
        })
        .mockResolvedValueOnce({
          data: {
            items: [{ id: 'evt-2' }],
            nextSyncToken: 'sync-token-final',
          },
        });

      const res = await listIncrementalCalendarEvents('user-1', {
        syncToken: 'sync-token-1',
      });

      expect(res.fullSync).toBe(false);
      expect(res.items.map((item) => item.id)).toEqual(['evt-1', 'evt-2']);
      expect(res.nextSyncToken).toBe('sync-token-final');
      expect(mockList).toHaveBeenNthCalledWith(1, {
        calendarId: 'primary',
        syncToken: 'sync-token-1',
        singleEvents: true,
        timeZone: 'America/Bogota',
      });
      expect(mockList).toHaveBeenNthCalledWith(2, {
        calendarId: 'primary',
        syncToken: 'sync-token-1',
        singleEvents: true,
        timeZone: 'America/Bogota',
        pageToken: 'page-2',
      });
    });

    it('paginates the initial full sync so the baseline receives nextSyncToken', async () => {
      mockList
        .mockResolvedValueOnce({
          data: {
            items: [{ id: 'evt-full-1' }],
            nextPageToken: 'full-page-2',
          },
        })
        .mockResolvedValueOnce({
          data: {
            items: [{ id: 'evt-full-2' }],
            nextSyncToken: 'baseline-sync-token',
          },
        });

      const res = await listIncrementalCalendarEvents('user-1');

      expect(res.fullSync).toBe(true);
      expect(res.items.map((item) => item.id)).toEqual(['evt-full-1', 'evt-full-2']);
      expect(res.nextSyncToken).toBe('baseline-sync-token');
      expect(mockList).toHaveBeenCalledTimes(2);
      expect(mockList.mock.calls[0][0].orderBy).toBeUndefined();
      expect(mockList.mock.calls[0][0].timeMax).toBeUndefined();
      expect(mockList.mock.calls[0][0].timeMin).toEqual(expect.any(String));
      expect(mockList.mock.calls[1][0]).toEqual(
        expect.objectContaining({ pageToken: 'full-page-2' }),
      );
    });

    it('recovers automatically with full sync when Google responds 410 Gone for expired syncToken', async () => {
      const error410 = new Error('Sync token is no longer valid');
      error410.code = 410;

      mockList
        .mockRejectedValueOnce(error410)
        .mockResolvedValueOnce({
          data: {
            items: [{ id: 'evt-full-1', summary: 'Evento Completo' }],
            nextSyncToken: 'new-sync-token-fresh',
          },
        });

      const res = await listIncrementalCalendarEvents('user-1', {
        syncToken: 'expired-token',
      });

      expect(res.fullSync).toBe(true);
      expect(res.items).toHaveLength(1);
      expect(res.nextSyncToken).toBe('new-sync-token-fresh');
      expect(mockList).toHaveBeenCalledTimes(2);
    });
  });
});

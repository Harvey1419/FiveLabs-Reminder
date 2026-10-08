import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isWithin24HourWindow } from '../../../src/integrations/whatsapp/kapso-client.js';
import { userCache } from '../../../src/infrastructure/database/users.js';
import { supabase } from '../../../src/infrastructure/database/index.js';

describe('WhatsApp 24-Hour Customer Service Window', () => {
  beforeEach(() => {
    userCache.clear();
    vi.restoreAllMocks();
  });

  it('returns true when in-memory userCache has interaction within 24 hours', async () => {
    const phone = '573046154163';
    userCache.set(phone, {
      user: {
        id: 'user-1',
        phone_number: phone,
        last_user_message_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
      },
      timestamp: Date.now(),
    });

    const isOpen = await isWithin24HourWindow(phone);
    expect(isOpen).toBe(true);
  });

  it('returns true when RAM cache is at 23.8 hours (previously failed by premature 23.5h threshold)', async () => {
    const phone = '573046154163';
    userCache.set(phone, {
      user: {
        id: 'user-1',
        phone_number: phone,
        last_user_message_at: new Date(Date.now() - 23.8 * 60 * 60 * 1000).toISOString(), // 23.8 hours ago
      },
      timestamp: Date.now(),
    });

    const isOpen = await isWithin24HourWindow(phone);
    expect(isOpen).toBe(true);
  });

  it('falls back to database and detects recent role: user message', async () => {
    const phone = '573001234567';

    vi.spyOn(supabase, 'from').mockReturnValue({
      select: () => ({
        in: () => ({
          or: () => ({
            gt: () => ({
              limit: async () => ({
                data: [{ id: 'msg-1' }],
                error: null,
              }),
            }),
          }),
        }),
      }),
    });

    const isOpen = await isWithin24HourWindow(phone);
    expect(isOpen).toBe(true);
  });

  it('falls back to database and detects interactive button clicks (reminder_ack)', async () => {
    const phone = '573046154163';

    let capturedOrFilter = null;
    vi.spyOn(supabase, 'from').mockReturnValue({
      select: () => ({
        in: () => ({
          or: (filterStr) => {
            capturedOrFilter = filterStr;
            return {
              gt: () => ({
                limit: async () => ({
                  data: [{ id: 'ack-msg-1' }],
                  error: null,
                }),
              }),
            };
          },
        }),
      }),
    });

    const isOpen = await isWithin24HourWindow(phone);
    expect(isOpen).toBe(true);
    expect(capturedOrFilter).toContain('reminder_ack');
    expect(capturedOrFilter).toContain('reminder_snooze');
  });

  it('normalizes + prefix when querying candidates', async () => {
    const phoneWithPlus = '+573046154163';

    let capturedCandidates = null;
    vi.spyOn(supabase, 'from').mockReturnValue({
      select: () => ({
        in: (col, candidates) => {
          capturedCandidates = candidates;
          return {
            or: () => ({
              gt: () => ({
                limit: async () => ({
                  data: [{ id: 'msg-1' }],
                  error: null,
                }),
              }),
            }),
          };
        },
      }),
    });

    const isOpen = await isWithin24HourWindow(phoneWithPlus);
    expect(isOpen).toBe(true);
    expect(capturedCandidates).toContain('573046154163');
    expect(capturedCandidates).toContain('+573046154163');
  });

  it('handles BSUIDs cleanly', async () => {
    const bsuid = 'CO.1552339023039755';

    let capturedCandidates = null;
    vi.spyOn(supabase, 'from').mockReturnValue({
      select: () => ({
        in: (col, candidates) => {
          capturedCandidates = candidates;
          return {
            or: () => ({
              gt: () => ({
                limit: async () => ({
                  data: [{ id: 'msg-bsuid-1' }],
                  error: null,
                }),
              }),
            }),
          };
        },
      }),
    });

    const isOpen = await isWithin24HourWindow(bsuid);
    expect(isOpen).toBe(true);
    expect(capturedCandidates).toEqual(['CO.1552339023039755']);
  });

  it('returns false when no activity in the last 24 hours', async () => {
    const phone = '573009999999';

    vi.spyOn(supabase, 'from').mockReturnValue({
      select: () => ({
        in: () => ({
          or: () => ({
            gt: () => ({
              limit: async () => ({
                data: [],
                error: null,
              }),
            }),
          }),
        }),
      }),
    });

    const isOpen = await isWithin24HourWindow(phone);
    expect(isOpen).toBe(false);
  });

  it('returns false for empty or null recipient', async () => {
    expect(await isWithin24HourWindow(null)).toBe(false);
    expect(await isWithin24HourWindow('')).toBe(false);
    expect(await isWithin24HourWindow(undefined)).toBe(false);
  });
});

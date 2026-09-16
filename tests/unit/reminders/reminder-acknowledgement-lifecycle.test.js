import { describe, expect, it } from 'vitest';
import { isReminderAwaitingAcknowledgement } from '../../../src/infrastructure/database/index.js';
import { isNudgeDue } from '../../../src/jobs/reminder-scheduler.js';

describe('reminder acknowledgement lifecycle', () => {
  it('does not expose a future persistent reminder as awaiting acknowledgement', () => {
    expect(isReminderAwaitingAcknowledgement({
      status: 'pending',
      requires_confirmation: true,
      acknowledged_at: null,
      sent_at: null,
      last_nudged_at: null,
      delivery_id: null,
    })).toBe(false);
  });

  it('keeps a dispatched recurring reminder active while its schedule returns to pending', () => {
    expect(isReminderAwaitingAcknowledgement({
      status: 'pending',
      requires_confirmation: true,
      acknowledged_at: null,
      sent_at: '2026-09-11T14:00:00.000Z',
      delivery_id: 'wamid.delivery',
    })).toBe(true);
  });

  it('closes acknowledgement context and nudge eligibility once acknowledged', () => {
    const reminder = {
      status: 'sent',
      requires_confirmation: true,
      acknowledged_at: '2026-09-11T14:01:00.000Z',
      sent_at: '2026-09-11T14:00:00.000Z',
      last_nudged_at: '2026-09-11T14:00:00.000Z',
      nudge_interval_minutes: 1,
      nudge_count: 0,
      max_nudges: 3,
    };

    expect(isReminderAwaitingAcknowledgement(reminder)).toBe(false);
    expect(isNudgeDue(reminder, new Date('2026-09-11T14:10:00.000Z').getTime())).toBe(false);
  });

  it('excludes reminders whose nudges have been exhausted (nudge_count >= max_nudges)', () => {
    expect(isReminderAwaitingAcknowledgement({
      status: 'sent',
      requires_confirmation: true,
      acknowledged_at: null,
      sent_at: '2026-09-11T14:00:00.000Z',
      delivery_id: 'wamid.delivery',
      nudge_count: 3,
      max_nudges: 3,
    })).toBe(false);
  });

  it('excludes reminders whose last notification activity was more than 48 hours ago', () => {
    const referenceTime = new Date('2026-09-14T15:00:00.000Z');
    expect(isReminderAwaitingAcknowledgement({
      status: 'sent',
      requires_confirmation: true,
      acknowledged_at: null,
      sent_at: '2026-09-11T14:00:00.000Z',
      delivery_id: 'wamid.delivery',
      nudge_count: 1,
      max_nudges: 3,
    }, referenceTime)).toBe(false);
  });

  it('correctly classifies intraday / high-frequency recurrence rules', async () => {
    const { isIntradayRecurrence } = await import('../../../src/shared/reminder-recurrence.js');
    expect(isIntradayRecurrence('hourly')).toBe(true);
    expect(isIntradayRecurrence('hourly:2')).toBe(true);
    expect(isIntradayRecurrence('interval:30m')).toBe(true);
    expect(isIntradayRecurrence('interval:2h')).toBe(true);

    expect(isIntradayRecurrence('daily')).toBe(false);
    expect(isIntradayRecurrence('weekly')).toBe(false);
    expect(isIntradayRecurrence('monthly')).toBe(false);
    expect(isIntradayRecurrence('weekdays')).toBe(false);
    expect(isIntradayRecurrence(null)).toBe(false);
  });

  it('does not consider a reminder due for a nudge if its scheduled send_at is in the future (snooze invariant)', () => {
    const reminder = {
      status: 'pending',
      requires_confirmation: true,
      acknowledged_at: null,
      sent_at: '2026-09-16T13:00:00.000Z',
      last_nudged_at: '2026-09-16T13:00:00.000Z',
      send_at: '2026-09-16T13:15:00.000Z', // snoozed 15 min into future
      nudge_interval_minutes: 10,
      nudge_count: 0,
      max_nudges: 3,
    };

    // At minute 10: 10 minutes elapsed since last_nudged_at, but send_at is 13:15 (in the future)
    const atMinute10 = new Date('2026-09-16T13:10:00.000Z').getTime();
    expect(isNudgeDue(reminder, atMinute10)).toBe(false);

    // At minute 16: send_at is in the past
    const atMinute16 = new Date('2026-09-16T13:16:00.000Z').getTime();
    expect(isNudgeDue(reminder, atMinute16)).toBe(true);
  });
});

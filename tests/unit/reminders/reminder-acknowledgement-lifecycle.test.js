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
});

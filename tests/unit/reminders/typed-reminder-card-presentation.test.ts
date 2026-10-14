import { describe, expect, it, vi } from 'vitest';
import { createReminderPresentation } from '../../../src/shared/reminder-card-presentation.js';
function fixture() { const time = vi.fn(() => 'Canonical date'); return { time, ...createReminderPresentation({ formatHumanFriendlyDateTime: time }) }; }
describe('typed canonical reminder cards', () => {
  it('pairs by exact parent ID before content and consumes an advance notice once', () => {
    const { formatCanonicalReminderCreate } = fixture();
    const text = formatCanonicalReminderCreate([{ id: 'a', content: 'Same title' }, { id: 'b', content: 'Same title' }, { content: 'Advance for B', isAdvanceNotice: true, parent_reminder_id: 'b', formattedTime: 'Early B' }], { language: 'en' });
    expect(text).toContain('2 reminders scheduled'); expect(text.match(/Advance notice/g)).toHaveLength(1); expect(text.indexOf('Advance notice')).toBeGreaterThan(text.lastIndexOf('*Same title*')); expect(text).not.toContain('*Advance for B*');
  });
  it('retains an unmatched notice instead of attaching it by content to the wrong parent', () => {
    const { formatCanonicalReminderCreate } = fixture();
    const text = formatCanonicalReminderCreate([{ id: 'a', content: 'Same title' }, { content: 'Same title', isAdvanceNotice: true, parentReminderId: 'other-id' }], { language: 'en' });
    expect(text).toContain('2 reminders scheduled'); expect(text.match(/\*Same title\*/g)).toHaveLength(2); expect(text).not.toContain('Advance notice');
  });
  it('uses content fallback once and leaves extra unpaired notices visible', () => {
    const { formatCanonicalReminderCreate } = fixture();
    const text = formatCanonicalReminderCreate([{ content: 'Appointment' }, { displayContent: 'Appointment', content: 'Advance A', isAdvanceNotice: true }, { displayContent: 'Appointment', content: 'Advance B', isAdvanceNotice: true }], { language: 'en' });
    expect(text).toContain('2 reminders scheduled'); expect(text.match(/Advance notice/g)).toHaveLength(1); expect(text.match(/\*Appointment\*/g)).toHaveLength(2);
  });
  it('rebuilds a valid stored instant with year-aware formatting and ignores stale text', () => {
    const { formatCanonicalReminderUpdate, time } = fixture();
    const text = formatCanonicalReminderUpdate({ content: 'Annual review', send_at: '2031-01-14T15:00:00Z', formattedTime: 'Stale date', recurrence_rule: 'yearly' }, { language: 'en', timezone: 'America/Bogota' });
    expect(text).toContain('Canonical date'); expect(text).not.toContain('Stale date'); expect(text).toContain('Every year'); expect(time).toHaveBeenCalledWith('2031-01-14T15:00:00Z', 'America/Bogota', 'en', { includeYearWhenDifferent: true });
  });
  it('keeps legacy date text when the stored instant is missing or unusable', () => {
    const { formatCanonicalReminderCreate, time } = fixture();
    const text = formatCanonicalReminderCreate([{ content: 'Legacy', sendAt: 'invalid date', formattedTime: 'Legacy time' }], { language: 'en' });
    expect(text).toContain('Legacy time'); expect(time).not.toHaveBeenCalled();
  });
  it('keeps empty scoped search distinct from a clear-day response and numbers recurrent list rows', () => {
    const { formatCanonicalReminderList } = fixture();
    const empty = formatCanonicalReminderList({ filter: 'tomorrow', query: 'Missing', reminders: [] }, { language: 'en' });
    expect(empty).toContain("Tomorrow's reminders"); expect(empty).toContain('No reminders match your search'); expect(empty).not.toContain('completely clear');
    const list = formatCanonicalReminderList({ filter: 'today', reminders: [{ content: 'Routine', recurrence_rule: 'daily' }, { title: 'One-shot' }] }, { language: 'en' });
    expect(list).toContain('1. *Routine* · recurring'); expect(list).toContain('2. *One-shot*');
  });
  it('aggregates creation envelopes without changing rows and retains series cancellation semantics', () => {
    const { formatCanonicalReminderCreateBatch, formatCanonicalReminderCancel, formatCanonicalReminderCancelBatch } = fixture();
    const main = Object.freeze({ id: 'a', content: 'Routine', recurrenceRule: 'daily' }); const rows = Object.freeze([main]);
    expect(formatCanonicalReminderCreateBatch([{ items: rows }, [{ content: 'One-shot' }]], { language: 'es' })).toContain('2 recordatorios programados'); expect(rows[0]).toBe(main);
    expect(formatCanonicalReminderCancel(main, { language: 'en' })).toContain('no pending occurrences remain scheduled');
    const cancelled = formatCanonicalReminderCancelBatch([main, { content: 'One-shot' }, null, { title: 'Not a cancellation row' }], { language: 'en' });
    expect(cancelled).toContain('2 reminders removed'); expect(cancelled).toContain('🔁 *Routine*'); expect(cancelled).not.toContain('Not a cancellation row');
  });
  it('preserves bilingual labels, unknown recurrence fallback and acknowledgement copy', () => {
    const { formatRecurrenceLabel, formatCanonicalReminderAcknowledge } = fixture();
    expect(formatRecurrenceLabel('  YEARLY  ', 'en')).toBe('Every year'); expect(formatRecurrenceLabel('weekdays', 'es')).toBe('De lunes a viernes'); expect(formatRecurrenceLabel('custom', 'en')).toBe('Recurring'); expect(formatRecurrenceLabel(null)).toBe('');
    const text = formatCanonicalReminderAcknowledge({ content: 'Done' }, { language: 'en' }); expect(text).toContain('Reminder confirmed'); expect(text).toContain('pending follow-ups were stopped'); expect(formatCanonicalReminderAcknowledge(null)).toBe('');
  });
});

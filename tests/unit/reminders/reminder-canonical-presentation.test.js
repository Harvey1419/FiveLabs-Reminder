import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatCanonicalReminderCreate, formatCanonicalReminderList, formatCanonicalReminderUpdate } from '../../../src/shared/reminder-presentation.js';
import { formatHumanFriendlyDateTime } from '../../../src/shared/time.js';
import { createExecutionFact } from '../../../src/agent/core/execution-facts.js';
import { mutationReceiptsFromFacts } from '../../../src/agent/orchestration/observed-answer.js';
vi.mock('../../../src/agent/providers/client.js', () => ({ callChatCompletion: vi.fn() }));
afterEach(() => vi.useRealTimers());

const clock = instant => { vi.useFakeTimers(); vi.setSystemTime(new Date(instant)); };

describe('reminder year in the user timezone', () => {
  it.each(['es', 'en'])('regenerates cross-year create/update/list and receipt dates exactly once (%s)', language => {
    clock('2026-10-04T01:00:00Z');
    const item = { content: 'Review Delta', sendAt: '2031-01-14T15:00:00Z', formattedTime: 'Tuesday, January 14 at 10:00 AM', recurrenceRule: 'yearly' };
    const context = { language, timezone: 'America/Bogota' };
    for (const formattedTime of [item.formattedTime, 'Tuesday, January 14, 2031 at 10:00 AM']) {
      const data = { ...item, formattedTime };
      for (const card of [formatCanonicalReminderCreate([data], context), formatCanonicalReminderUpdate(data, context), formatCanonicalReminderList({ reminders: [data] }, context)]) {
        expect(card.match(/2031/g)).toHaveLength(1);
      }
      const fact = createExecutionFact({ toolName: 'manage_reminder', params: { action: 'create' }, result: { success: true, data: [data] }, ...context });
      const receipts = mutationReceiptsFromFacts([fact]);
      expect(receipts).toHaveLength(1);
      expect(receipts[0].summary.match(/2031/g)).toHaveLength(1);
    }
    expect(formatCanonicalReminderCreate([item], context)).toContain(language === 'en' ? 'Every year' : 'Todos los años');
    // Opt-in reminder formatting must not change dates in unrelated domains.
    expect(formatHumanFriendlyDateTime(item.sendAt, context.timezone, language)).not.toContain('2031');
  });
  it.each([
    ['2026-01-01T01:00:00Z', '2026-01-01T15:00:00Z', 'America/Bogota', '2026'],
    ['2026-12-31T23:30:00Z', '2027-01-01T01:00:00Z', 'Asia/Tokyo', null],
    ['2026-12-31T23:30:00Z', '2027-01-01T01:00:00Z', 'America/Bogota', null],
    ['2026-12-31T15:00:00Z', '2027-01-01T15:00:00Z', 'America/Bogota', '2027'],
  ])('compares both years locally: now %s, scheduled %s, zone %s', (now, sendAt, timezone, year) => {
    clock(now);
    const card = formatCanonicalReminderCreate([{ content: 'Boundary', sendAt }], { timezone, language: 'en' });
    if (year) expect(card.match(new RegExp(year, 'g'))).toHaveLength(1);
    else expect(card).not.toMatch(/2026|2027/);
  });
  it('keeps same-year compact dates and advance notice grouping', () => {
    clock('2026-10-04T01:00:00Z');
    const items = [{ content: 'Delta', sendAt: '2031-01-14T15:00:00Z' }, { content: 'Delta', sendAt: '2031-01-14T14:00:00Z', isAdvanceNotice: true }];
    expect(formatCanonicalReminderCreate(items, { language: 'en' }).match(/2031/g)).toHaveLength(2);
    expect(formatCanonicalReminderCreate(items, { language: 'en' })).toContain('Advance notice');
    const sameYear = '2026-11-14T15:00:00Z';
    expect(formatCanonicalReminderCreate([{ content: 'Delta', sendAt: sameYear }], { language: 'en' })).toContain(formatHumanFriendlyDateTime(sameYear, 'UTC', 'en'));
    expect(formatCanonicalReminderCreate([{ content: 'Delta', sendAt: sameYear }], { language: 'en' })).not.toContain('2026');
  });
});

describe('canonical reminder list presentation', () => {
  it('uses one WhatsApp bold marker pair and separates time onto its own line', () => {
    const card = formatCanonicalReminderList({
      reminders: [
        {
          content: 'Me amo mucho',
          send_at: '2026-09-08T13:00:00.000Z',
          recurrence_rule: 'daily',
        },
        {
          content: 'cita en cerámica Italia',
          send_at: '2026-09-08T14:30:00.000Z',
          recurrence_rule: null,
        },
      ],
    }, { language: 'es', timezone: 'America/Bogota' });

    expect(card).toContain('🔔 *Recordatorios pendientes*');
    expect(card).toContain('1. *Me amo mucho* · recurrente');
    expect(card).toContain('2. *cita en cerámica Italia*');
    expect(card).not.toContain('**Recordatorios pendientes**');
    expect(card).not.toContain('**Me amo mucho**');
  });

  it('renders contextual headers for tomorrow and other temporal scopes', () => {
    const cardTomorrow = formatCanonicalReminderList({
      filter: 'tomorrow',
      reminders: [{ content: 'Pagar arriendo', send_at: '2026-09-09T15:00:00.000Z' }],
    }, { language: 'es', timezone: 'America/Bogota' });

    expect(cardTomorrow).toContain('🔔 *Recordatorios para mañana*');
    expect(cardTomorrow).toContain('1. *Pagar arriendo*');

    const cardEmptyTomorrow = formatCanonicalReminderList({
      filter: 'tomorrow',
      reminders: [],
    }, { language: 'es' });

    expect(cardEmptyTomorrow).toContain('🔔 *Recordatorios para mañana*');
    expect(cardEmptyTomorrow).toContain('No tienes recordatorios programados para mañana.');
  });
});

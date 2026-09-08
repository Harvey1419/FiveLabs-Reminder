import { describe, expect, it } from 'vitest';
import {
  buildAdvanceNoticeContent,
  parseAdvanceNoticeContent,
  isAdvanceNoticeContent,
  belongsToMainReminder,
} from '../../../src/agent/tools/reminder-advance.js';

describe('reminder advance notice protocol', () => {
  it('round-trips canonical advance notice content', () => {
    const content = buildAdvanceNoticeContent('Tomar las vitaminas', 15);

    expect(content).toBe('🔔 [Aviso Previo] En 15 minutos: Tomar las vitaminas');
    expect(parseAdvanceNoticeContent(content)).toEqual({
      advanceMinutes: 15,
      baseContent: 'Tomar las vitaminas',
    });
    expect(isAdvanceNoticeContent(content)).toBe(true);
  });

  it('rejects malformed internal protocol values', () => {
    expect(buildAdvanceNoticeContent('', 15)).toBeNull();
    expect(buildAdvanceNoticeContent('Tomar vitaminas', 0)).toBeNull();
    expect(parseAdvanceNoticeContent('Tomar vitaminas en 15 minutos')).toBeNull();
  });

  it('links a notice to its main reminder by canonical content and time', () => {
    const main = {
      content: 'Tomar las vitaminas',
      send_at: '2026-09-09T13:00:00.000Z',
    };
    const notice = {
      content: buildAdvanceNoticeContent(main.content, 15),
      send_at: '2026-09-09T12:45:00.000Z',
    };

    expect(belongsToMainReminder(notice, main)).toBe(true);
    expect(belongsToMainReminder({ ...notice, send_at: '2026-09-09T12:44:00.000Z' }, main)).toBe(false);
  });
});

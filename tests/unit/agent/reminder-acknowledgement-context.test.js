import { afterEach, describe, expect, it } from 'vitest';
import {
  clearWorkingMemory,
  formatWorkingMemoryPrompt,
  saveWorkingMemory,
} from '../../../src/agent/core/working-memory.js';

const phone = '573001112233';

afterEach(() => {
  clearWorkingMemory(phone);
});

describe('active reminder acknowledgement context', () => {
  it('exposes an awaiting-confirmation reminder as one semantic acknowledgement target without leaking its ID', () => {
    saveWorkingMemory(phone, {
      source: 'reminder',
      scope: 'today',
      lastAction: 'nudge',
      notificationReminderId: 'internal-reminder-uuid',
      notificationContent: 'Me amo mucho',
      items: [{
        type: 'reminder',
        internalId: 'internal-reminder-uuid',
        summary: 'Me amo mucho',
      }],
    });

    const prompt = formatWorkingMemoryPrompt(phone);

    expect(prompt).toContain('AWAITING_ACKNOWLEDGEMENT');
    expect(prompt).toContain('reminder="Me amo mucho"');
    expect(prompt).toContain('reminder.acknowledge');
    expect(prompt).toContain('target="1"');
    expect(prompt).toContain('Un asentimiento sobre otro tema NO confirma el recordatorio');
    expect(prompt).not.toContain('internal-reminder-uuid');
  });

  it('does not mark an ordinary reminder inventory as awaiting acknowledgement', () => {
    saveWorkingMemory(phone, {
      source: 'reminder',
      scope: 'today',
      lastAction: 'manage_reminder',
      items: [{
        type: 'reminder',
        internalId: 'internal-reminder-uuid',
        summary: 'Comprar leche',
      }],
    });

    const prompt = formatWorkingMemoryPrompt(phone);

    expect(prompt).not.toContain('AWAITING_ACKNOWLEDGEMENT');
    expect(prompt).not.toContain('emite únicamente reminder.acknowledge');
  });
});

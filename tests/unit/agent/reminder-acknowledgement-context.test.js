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

  it('does not re-expose a stale notification after backend state closes it', () => {
    saveWorkingMemory(phone, {
      source: 'reminder',
      scope: 'today',
      lastAction: 'nudge',
      notificationReminderId: 'closed-reminder-id',
      notificationContent: 'Pagar el recibo',
      items: [{
        type: 'reminder',
        internalId: 'closed-reminder-id',
        summary: 'Pagar el recibo',
      }],
    });

    const prompt = formatWorkingMemoryPrompt(phone, {
      pendingConfirmationReminders: [],
    });

    expect(prompt).not.toContain('AWAITING_ACKNOWLEDGEMENT');
    expect(prompt).not.toContain('emite únicamente reminder.acknowledge');
  });

  it('does not present one Working Memory notice as authoritative when several follow-ups are active', () => {
    saveWorkingMemory(phone, {
      source: 'reminder',
      lastAction: 'nudge',
      notificationReminderId: 'reminder-1',
      notificationContent: 'Llamar a Julieth',
      items: [{ type: 'reminder', internalId: 'reminder-1', summary: 'Llamar a Julieth' }],
    });

    const prompt = formatWorkingMemoryPrompt(phone, {
      pendingConfirmationReminders: [
        { id: 'reminder-1', content: 'Llamar a Julieth' },
        { id: 'reminder-2', content: 'Pagar el recibo' },
      ],
    });

    expect(prompt).not.toContain('[Seguimiento activo esperando confirmación]');
    expect(prompt).not.toContain('emite únicamente reminder.acknowledge');
  });

  it('keeps notification context active for recently dispatched reminders awaiting acknowledgement', () => {
    saveWorkingMemory(phone, {
      source: 'reminder',
      scope: 'today',
      lastAction: 'reminder_dispatched',
      notificationReminderId: 'dispatched-reminder-uuid',
      notificationContent: 'Montar los impuestos de esthom',
      items: [{
        type: 'reminder',
        internalId: 'dispatched-reminder-uuid',
        summary: 'Montar los impuestos de esthom',
      }],
    });

    const prompt = formatWorkingMemoryPrompt(phone, {
      pendingConfirmationReminders: [],
    });

    expect(prompt).toContain('AWAITING_ACKNOWLEDGEMENT');
    expect(prompt).toContain('reminder="Montar los impuestos de esthom"');
    expect(prompt).toContain('reminder.acknowledge');
  });
});

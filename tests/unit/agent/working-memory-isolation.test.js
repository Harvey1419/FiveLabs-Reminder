import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearWorkingMemory,
  getWorkingMemory,
  saveWorkingMemory,
} from '../../../src/agent/core/working-memory-store.js';

describe('working memory isolation between interactive conversations and notifications', () => {
  const userId = 'user-wm-isolation-1';
  const phone = '15559876543';
  const user = { id: userId, phone_number: phone };

  beforeEach(() => {
    clearWorkingMemory(user);
  });

  it('preserves interactive conversational items and activeEntity when notification arrives within 10 minutes', () => {
    // 1. User interacts with Hermes (e.g. viewing a task list or asking about a project)
    const interactiveItems = [
      { id: 'task-101', title: 'Revisar informe trimestral', entityName: 'Proyecto Alfa' },
      { id: 'task-102', title: 'Enviar factura', entityName: 'Proyecto Alfa' },
    ];
    saveWorkingMemory(user, {
      source: 'task',
      entityType: 'task',
      scope: 'today',
      activeEntity: 'Proyecto Alfa',
      items: interactiveItems,
    });

    const beforeNotif = getWorkingMemory(user);
    expect(beforeNotif.source).toBe('task');
    expect(beforeNotif.items).toHaveLength(2);
    expect(beforeNotif.activeEntity).toBe('Proyecto Alfa');

    // 2. Background job dispatches a reminder nudge (source: 'notification')
    const notificationReminderId = 'rem-555';
    const notificationContent = 'Tomar la pastilla';
    saveWorkingMemory(user, {
      source: 'notification',
      lastAction: 'nudge',
      notificationReminderId,
      notificationContent,
      items: [{
        id: notificationReminderId,
        title: notificationContent,
      }],
    });

    // 3. Verify interactive conversational working memory is NOT clobbered
    const afterNotif = getWorkingMemory(user);
    expect(afterNotif.source).toBe('task'); // Preserved
    expect(afterNotif.activeEntity).toBe('Proyecto Alfa'); // Preserved
    expect(afterNotif.items).toHaveLength(2); // Preserved
    expect(afterNotif.items[0].internalId).toBe('task-101');
    expect(afterNotif.items[1].internalId).toBe('task-102');

    // Notification fields are merged so Hermes knows what was notified
    expect(afterNotif.lastAction).toBe('nudge');
    expect(afterNotif.notificationReminderId).toBe(notificationReminderId);
    expect(afterNotif.notificationContent).toBe(notificationContent);
  });

  it('overwrites working memory with notification if interactive entry is older than 10 minutes', () => {
    // 1. Stale interactive entry from 15 minutes ago
    const fifteenMinutesAgo = Date.now() - 15 * 60 * 1000;
    saveWorkingMemory(user, {
      source: 'task',
      entityType: 'task',
      items: [{ id: 'task-old', title: 'Tarea vieja' }],
    }, { restoredTimestamp: fifteenMinutesAgo });

    // 2. Notification arrives
    const notificationReminderId = 'rem-777';
    saveWorkingMemory(user, {
      source: 'notification',
      lastAction: 'reminder_dispatched',
      notificationReminderId,
      notificationContent: 'Reunión en 10 minutos',
      items: [{ id: notificationReminderId, title: 'Reunión en 10 minutos' }],
    });

    // 3. Stale interactive state is replaced by notification
    const current = getWorkingMemory(user);
    expect(current.source).toBe('notification');
    expect(current.items).toHaveLength(1);
    expect(current.items[0].internalId).toBe(notificationReminderId);
    expect(current.lastAction).toBe('reminder_dispatched');
    expect(current.notificationReminderId).toBe(notificationReminderId);
  });

  it('updates normally when previous working memory was already a notification', () => {
    // 1. Initial notification
    saveWorkingMemory(user, {
      source: 'notification',
      lastAction: 'reminder_dispatched',
      notificationReminderId: 'rem-1',
      notificationContent: 'Recordatorio 1',
      items: [{ id: 'rem-1', title: 'Recordatorio 1' }],
    });

    // 2. Second notification (nudge)
    saveWorkingMemory(user, {
      source: 'notification',
      lastAction: 'nudge',
      notificationReminderId: 'rem-2',
      notificationContent: 'Recordatorio 2',
      items: [{ id: 'rem-2', title: 'Recordatorio 2' }],
    });

    const current = getWorkingMemory(user);
    expect(current.source).toBe('notification');
    expect(current.items).toHaveLength(1);
    expect(current.items[0].internalId).toBe('rem-2');
    expect(current.lastAction).toBe('nudge');
    expect(current.notificationReminderId).toBe('rem-2');
  });

  it('allows interactive user actions to overwrite notification working memory without restriction', () => {
    // 1. Notification in working memory
    saveWorkingMemory(user, {
      source: 'notification',
      lastAction: 'nudge',
      notificationReminderId: 'rem-nudge',
      notificationContent: 'Recordatorio',
      items: [{ id: 'rem-nudge', title: 'Recordatorio' }],
    });

    // 2. User lists tasks interactively
    saveWorkingMemory(user, {
      source: 'task',
      lastAction: 'list',
      items: [
        { id: 'task-new-1', title: 'Nueva tarea 1' },
        { id: 'task-new-2', title: 'Nueva tarea 2' },
      ],
    });

    const current = getWorkingMemory(user);
    expect(current.source).toBe('task');
    expect(current.items).toHaveLength(2);
    expect(current.items[0].internalId).toBe('task-new-1');
  });
});

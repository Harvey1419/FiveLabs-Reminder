import { describe, expect, it } from 'vitest';
import { bindAuthoritativeFollowupTargets } from '../../../src/agent/orchestration/router-core.js';

describe('authoritative follow-up binding', () => {
  it('binds the only active follow-up to an acknowledge action that has no target', () => {
    const intent: { actions: Array<{ domain: string; action: string; target?: string }>; excluded?: unknown[] } = {
      actions: [{ domain: 'reminder', action: 'acknowledge' }],
      excluded: [],
    };
    const overview = {
      pendingConfirmationReminders: [
        { id: 'internal-id-must-not-be-used', content: 'cita', localFormatted: 'Hoy a las 4:00 PM' },
      ],
    };

    const result = bindAuthoritativeFollowupTargets(intent, overview);

    expect(result.actions[0]).toEqual({
      domain: 'reminder',
      action: 'acknowledge',
      target: 'cita',
      authoritativeReminderId: 'internal-id-must-not-be-used',
    });
  });

  it('never overrides an explicit human target selected by Hermes', () => {
    const intent: { actions: Array<{ domain: string; action: string; target?: string }>; excluded?: unknown[] } = {
      actions: [{ domain: 'reminder', action: 'acknowledge', target: 'llamar a mamá' }],
    };
    const overview = {
      pendingConfirmationReminders: [{ id: 'active-reminder-id', content: 'cita' }],
    };

    const result = bindAuthoritativeFollowupTargets(intent, overview);
    expect(result.actions[0]!.target).toBe('llamar a mamá');
    expect(result.actions[0]).not.toHaveProperty('authoritativeReminderId');
  });

  it('does not guess when more than one follow-up is active', () => {
    const intent: { actions: Array<{ domain: string; action: string; target?: string }>; excluded?: unknown[] } = {
      actions: [{ domain: 'reminder', action: 'acknowledge' }],
    };
    const overview = {
      pendingConfirmationReminders: [
        { id: 'reminder-1', content: 'cita' },
        { id: 'reminder-2', content: 'tomar medicina' },
      ],
    };

    const result = bindAuthoritativeFollowupTargets(intent, overview);
    expect(result.actions[0]!.target).toBeUndefined();
  });

  it('does not bind follow-up state to unrelated reminder actions', () => {
    const intent: { actions: Array<{ domain: string; action: string; target?: string }>; excluded?: unknown[] } = {
      actions: [{ domain: 'reminder', action: 'cancel' }],
    };
    const overview = {
      pendingConfirmationReminders: [{ id: 'reminder-1', content: 'cita' }],
    };

    const result = bindAuthoritativeFollowupTargets(intent, overview);
    expect(result.actions[0]!.target).toBeUndefined();
  });

  it('binds to the nudged reminder in working memory even when multiple follow-ups are active in overview', () => {
    const intent: { actions: Array<{ domain: string; action: string; target?: string }>; excluded?: unknown[] } = {
      actions: [{ domain: 'reminder', action: 'acknowledge', target: '1' }],
    };
    const overview = {
      pendingConfirmationReminders: [
        { id: 'reminder-1', content: 'cita' },
        { id: 'reminder-2', content: 'Me amo mucho' },
        { id: 'reminder-3', content: 'llamar al banco' },
      ],
    };
    const workingMemory = {
      source: 'reminder',
      lastAction: 'nudge',
      notificationReminderId: 'reminder-2',
      notificationContent: 'Me amo mucho',
    };

    const result = bindAuthoritativeFollowupTargets(intent, overview, workingMemory);
    expect(result.actions[0]).toEqual({
      domain: 'reminder',
      action: 'acknowledge',
      target: '1',
      authoritativeReminderId: 'reminder-2',
    });
  });

  it('binds to working memory nudge when target is omitted', () => {
    const intent: { actions: Array<{ domain: string; action: string; target?: string }>; excluded?: unknown[] } = {
      actions: [{ domain: 'reminder', action: 'acknowledge' }],
    };
    const overview = {
      pendingConfirmationReminders: [
        { id: 'reminder-1', content: 'cita' },
        { id: 'reminder-2', content: 'Me amo mucho' },
      ],
    };
    const workingMemory = {
      source: 'reminder',
      lastAction: 'nudge',
      notificationReminderId: 'reminder-2',
      notificationContent: 'Me amo mucho',
    };

    const result = bindAuthoritativeFollowupTargets(intent, overview, workingMemory);
    expect(result.actions[0]).toEqual({
      domain: 'reminder',
      action: 'acknowledge',
      target: 'Me amo mucho',
      authoritativeReminderId: 'reminder-2',
    });
  });
});

import { describe, expect, it } from 'vitest';
import { bindAuthoritativeFollowupTargets } from '../../../src/agent/orchestration/router-core.js';

describe('authoritative follow-up binding', () => {
  it('binds the only active follow-up to an acknowledge action that has no target', () => {
    const intent = {
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
    const intent = {
      actions: [{ domain: 'reminder', action: 'acknowledge', target: 'llamar a mamá' }],
    };
    const overview = {
      pendingConfirmationReminders: [{ id: 'active-reminder-id', content: 'cita' }],
    };

    const result = bindAuthoritativeFollowupTargets(intent, overview);
    expect(result.actions[0].target).toBe('llamar a mamá');
    expect(result.actions[0]).not.toHaveProperty('authoritativeReminderId');
  });

  it('does not guess when more than one follow-up is active', () => {
    const intent = {
      actions: [{ domain: 'reminder', action: 'acknowledge' }],
    };
    const overview = {
      pendingConfirmationReminders: [
        { id: 'reminder-1', content: 'cita' },
        { id: 'reminder-2', content: 'tomar medicina' },
      ],
    };

    const result = bindAuthoritativeFollowupTargets(intent, overview);
    expect(result.actions[0].target).toBeUndefined();
  });

  it('does not bind follow-up state to unrelated reminder actions', () => {
    const intent = {
      actions: [{ domain: 'reminder', action: 'cancel' }],
    };
    const overview = {
      pendingConfirmationReminders: [{ id: 'reminder-1', content: 'cita' }],
    };

    const result = bindAuthoritativeFollowupTargets(intent, overview);
    expect(result.actions[0].target).toBeUndefined();
  });
});

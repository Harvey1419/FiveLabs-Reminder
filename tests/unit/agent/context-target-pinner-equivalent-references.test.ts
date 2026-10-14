import { describe, expect, it } from 'vitest';
import { pinReminderCancellationTargets } from '../../../src/agent/orchestration/context-target-pinner.js';

describe('contextual reminder target pinning', () => {
  it('pairs different human references when they resolve to the same duplicate set', () => {
    const workingMemory = {
      items: [
        { position: 1, type: 'reminder', internalId: '11111111-1111-4111-8111-111111111111', summary: 'Sacar una cita' },
        { position: 2, type: 'reminder', internalId: '22222222-2222-4222-8222-222222222222', summary: 'Sacar una cita' },
      ],
    };
    const actions = [
      { domain: 'reminder', action: 'cancel', target: 'sacar una cita' },
      { domain: 'reminder', action: 'cancel', target: 'cita' },
    ];

    const pinned = pinReminderCancellationTargets(actions, workingMemory);

    expect(pinned.get(0)).toBe('11111111-1111-4111-8111-111111111111');
    expect(pinned.get(1)).toBe('22222222-2222-4222-8222-222222222222');
  });
});

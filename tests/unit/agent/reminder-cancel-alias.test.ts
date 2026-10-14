import { expectValid } from '../../support/unit/contract-boundary.js';
import { describe, expect, it } from 'vitest';
import { validateTurnIntent } from '../../../src/agent/contracts/intent-contracts.js';

describe('reminder cancellation wire alias', () => {
  it('canonicalizes reminder.delete to cancel without changing delete in other domains', () => {
    const reminder = validateTurnIntent({
      actions: [{ domain: 'reminder', action: 'delete', target: '1' }],
    });
    expectValid(reminder);
    expect(reminder.intent.actions[0]).toMatchObject({ domain: 'reminder', action: 'cancel', target: '1' });

    const task = validateTurnIntent({
      actions: [{ domain: 'task', action: 'delete', target: '1' }],
    });
    expectValid(task);
    expect(task.intent.actions[0]).toMatchObject({ domain: 'task', action: 'delete', target: '1' });
  });
});

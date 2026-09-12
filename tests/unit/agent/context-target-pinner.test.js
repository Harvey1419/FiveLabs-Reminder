import { describe, expect, it } from 'vitest';
import {
  pinReminderCancellationTargets,
  pinReminderTargets,
} from '../../../src/agent/orchestration/context-target-pinner.js';

function memory(items) {
  return {
    items: items.map((item, index) => ({
      position: index + 1,
      type: 'reminder',
      internalId: item.id,
      summary: item.content,
      title: item.content,
      raw: { id: item.id, content: item.content },
    })),
  };
}

describe('contextual reminder target pinning', () => {
  it('pins ordinal references to the pre-mutation Working Memory snapshot', () => {
    const workingMemory = memory([
      { id: 'rem-1', content: 'Comprar vuelos' },
      { id: 'rem-2', content: 'Sacar una cita' },
      { id: 'rem-3', content: 'Hacerme las uñas' },
    ]);
    const actions = [
      { domain: 'reminder', action: 'cancel', target: '1' },
      { domain: 'reminder', action: 'cancel', target: '2' },
      { domain: 'reminder', action: 'cancel', target: '3' },
    ];

    expect([...pinReminderCancellationTargets(actions, workingMemory).entries()]).toEqual([
      [0, 'rem-1'],
      [1, 'rem-2'],
      [2, 'rem-3'],
    ]);
  });

  it('pairs repeated structured targets one-to-one when they exactly cover duplicated listed reminders', () => {
    const workingMemory = memory([
      { id: 'rem-1', content: 'Comprar vuelos' },
      { id: 'rem-2', content: 'Sacar una cita' },
      { id: 'rem-3', content: 'Sacar una cita' },
    ]);
    const actions = [
      { domain: 'reminder', action: 'cancel', target: 'Comprar vuelos' },
      { domain: 'reminder', action: 'cancel', target: 'Sacar una cita' },
      { domain: 'reminder', action: 'cancel', target: 'Sacar una cita' },
    ];

    expect([...pinReminderCancellationTargets(actions, workingMemory).entries()]).toEqual([
      [0, 'rem-1'],
      [1, 'rem-2'],
      [2, 'rem-3'],
    ]);
  });

  it('keeps a partial duplicate selection ambiguous instead of guessing', () => {
    const workingMemory = memory([
      { id: 'rem-1', content: 'Sacar una cita' },
      { id: 'rem-2', content: 'Sacar una cita' },
    ]);
    const actions = [{ domain: 'reminder', action: 'cancel', target: 'Sacar una cita' }];

    expect(pinReminderCancellationTargets(actions, workingMemory).size).toBe(0);
  });

  it('pins reminder update targets to the pre-mutation Working Memory snapshot', () => {
    const workingMemory = memory([
      { id: 'rem-1', content: 'Llamar al banco' },
      { id: 'rem-2', content: 'Sacar una cita' },
    ]);
    const actions = [
      { domain: 'reminder', action: 'update', target: '1' },
      { domain: 'reminder', action: 'update', target: 'Sacar una cita' },
    ];

    expect([...pinReminderTargets(actions, workingMemory).entries()]).toEqual([
      [0, 'rem-1'],
      [1, 'rem-2'],
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  findReminderByExactReference,
  buildReminderReferenceCandidates,
  resolveReminderByScore,
} from '../../../src/agent/tools/reminder-reference.js';

describe('Reminder reference primitives', () => {
  const reminders = [
    { id: '11111111-1111-4111-8111-111111111111', content: 'Llamar al veterinario', send_at: '2026-09-09T15:00:00.000Z' },
    { id: '22222222-2222-4222-8222-222222222222', content: 'Revisar presupuesto del apartamento', send_at: '2026-09-11T20:00:00.000Z' },
  ];

  it('resolves only explicit UUID or safe id prefix references', () => {
    expect(findReminderByExactReference('11111111-1111-4111-8111-111111111111', reminders)?.content).toBe('Llamar al veterinario');
    expect(findReminderByExactReference('22222222', reminders)?.content).toBe('Revisar presupuesto del apartamento');
    expect(findReminderByExactReference('veterinario', reminders)).toBeNull();
  });

  it('builds the canonical entity candidate shape without changing eligibility', () => {
    expect(buildReminderReferenceCandidates([reminders[0]!])).toEqual([{
      id: reminders[0]!.id,
      internalId: reminders[0]!.id,
      type: 'reminder',
      content: reminders[0]!.content,
      summary: reminders[0]!.content,
      time: reminders[0]!.send_at,
      raw: reminders[0]!,
    }]);
  });

  it('resolves a clear score winner and refuses ambiguous matches', () => {
    expect(resolveReminderByScore('llamar al veterinario', reminders)).toMatchObject({
      status: 'RESOLVED',
      reminder: reminders[0]!,
    });

    const ambiguous = [
      { id: 'a', send_at: '2026-09-09T15:00:00.000Z', content: 'Comprar leche para la casa' },
      { id: 'b', send_at: '2026-09-09T15:00:00.000Z', content: 'Comprar leche para la oficina' },
    ];
    expect(resolveReminderByScore('comprar leche', ambiguous).status).toBe('AMBIGUOUS');
  });
});

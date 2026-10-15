import { describe, expect, it, vi } from 'vitest';
import { createReminderTools } from '@templelabs/tools';
import { reminderCreateToolInputSchema } from '@templelabs/contracts';
import { context } from './productivity-fixtures.js';
describe('deterministic relative reminder clock', () => {
  it('derives the scheduled instant from the owned turn clock, independent of model UTC calculations', async () => {
    const execute = vi.fn(async () => ({ status: 'denied' as const, code: 'SYNTHETIC', observation: 'No external write' }));
    const tool = createReminderTools({ execute })[0];
    await tool.execute({ content: 'Salir', delayMinutes: 10 }, { ...context, referenceTimeIso: '2026-10-15T15:00:00Z' }, 'operation');
    expect(execute).toHaveBeenCalledWith({ operation: 'create', input: { content: 'Salir', targetTimeIso: '2026-10-15T15:10:00.000Z' } }, expect.anything(), 'operation');
  });
  it.each([{ content: 'Salir' }, { content: 'Salir', delayMinutes: 0 }, { content: 'Salir', delayMinutes: -1 },
    { content: 'Salir', unqualifiedLocalTime: { hour: 24, minute: 0 } }, { content: 'Salir', unqualifiedLocalTime: { hour: 10, minute: 60 } },
    { content: 'Salir', unqualifiedLocalTime: { hour: 10, minute: 0 }, delayMinutes: 10 },
    { content: 'Salir', unqualifiedLocalTime: { hour: 10, minute: 0 }, targetTimeIso: '2026-10-15T15:10:00Z' },
    { content: 'Salir', delayMinutes: 10, targetTimeIso: '2026-10-15T15:10:00Z' }])('rejects missing, invalid and conflicting clocks before execution: %j', input => {
    expect(reminderCreateToolInputSchema.safeParse(input).success).toBe(false);
  });
  it.each([
    ['America/Bogota', '2026-10-15T01:47:33Z', 10, 0, '2026-10-15T03:00:00.000Z'],
    ['America/Bogota', '2026-10-15T01:47:33Z', 22, 0, '2026-10-15T03:00:00.000Z'],
    ['America/Bogota', '2026-10-15T04:30:00Z', 22, 0, '2026-10-15T15:00:00.000Z'],
    ['America/Bogota', '2026-10-14T17:49:00Z', 4, 0, '2026-10-14T21:00:00.000Z'],
    ['America/Bogota', '2026-10-15T04:59:00Z', 12, 0, '2026-10-15T05:00:00.000Z'],
    ['America/New_York', '2026-11-01T05:45:00Z', 1, 30, '2026-11-01T06:30:00.000Z'],
    ['America/New_York', '2026-03-08T06:45:00Z', 2, 30, '2026-03-08T18:30:00.000Z'],
  ])('resolves the earliest future clock in %s at %s', async (timezone, referenceTimeIso, hour, minute, expected) => {
    const execute = vi.fn(async () => ({ status: 'denied' as const, code: 'SYNTHETIC', observation: 'No external write' }));
    await createReminderTools({ execute })[0].execute({ content: 'Llegada', unqualifiedLocalTime: { hour, minute } },
      { ...context, timezone, referenceTimeIso }, 'operation');
    expect(execute).toHaveBeenCalledWith({ operation: 'create', input: { content: 'Llegada', targetTimeIso: expected } }, expect.anything(), 'operation');
  });
});

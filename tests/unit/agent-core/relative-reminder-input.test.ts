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
    { content: 'Salir', delayMinutes: 10, targetTimeIso: '2026-10-15T15:10:00Z' }])('rejects missing, invalid and conflicting clocks before execution: %j', input => {
    expect(reminderCreateToolInputSchema.safeParse(input).success).toBe(false);
  });
});

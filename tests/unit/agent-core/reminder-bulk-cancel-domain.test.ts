import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { TurnContext } from '@templelabs/contracts';
import { createReminderTools, ToolRegistry } from '@templelabs/tools';
import { createReminderDomainPort } from '../../../src/adapters/agent-core/reminders-domain.js';

const mockSupabase = vi.hoisted(() => {
  return {
    from: vi.fn(),
  };
});

vi.mock('../../../src/infrastructure/database/index.js', () => ({
  supabase: {
    from: mockSupabase.from,
  },
}));

const user = { id: 'owner-123' };
const context: TurnContext = {
  userId: 'owner-123',
  runId: 'run-1',
  requestId: 'req-1',
  referenceTimeIso: '2026-10-16T12:00:00.000Z',
  timezone: 'America/Bogota',
  language: 'es',
  capabilities: new Set(['reminders.read', 'reminders.cancel']),
  signal: new AbortController().signal,
};

describe('Reminder bulk cancellation in domain port', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires confirmation when unconfirmed bulk cancel is executed', async () => {
    const reminders = [
      { id: 'rem-1', content: 'Llamar a Juan', send_at: '2026-10-16T10:00:00Z', status: 'pending' },
      { id: 'rem-2', content: 'Comprar pan', send_at: '2026-10-16T11:00:00Z', status: 'pending' },
    ];

    mockSupabase.from.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          in: vi.fn().mockReturnValue({
            lte: vi.fn().mockResolvedValue({ data: reminders, error: null }),
          }),
        }),
      }),
    });

    const port = createReminderDomainPort(user);
    const tools = createReminderTools(port);
    const registry = new ToolRegistry([...tools]);

    const outcome = await registry.execute('reminder_cancel', { scope: 'elapsed', confirmed: false }, context, 'op-rc-1');

    expect(outcome).toMatchObject({
      status: 'clarification_required',
      code: 'CONFIRMATION_REQUIRED',
    });
  });

  it('cancels reminders successfully when confirmed', async () => {
    const reminders = [
      { id: 'rem-1', content: 'Llamar a Juan', send_at: '2026-10-16T10:00:00Z', status: 'pending' },
    ];

    mockSupabase.from.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          in: vi.fn().mockReturnValue({
            lte: vi.fn().mockResolvedValue({ data: reminders, error: null }),
          }),
        }),
      }),
    }).mockReturnValueOnce({
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          in: vi.fn().mockReturnValue({
            select: vi.fn().mockResolvedValue({
              data: [{ ...reminders[0], status: 'cancelled' }],
              error: null,
            }),
          }),
        }),
      }),
    });

    const port = createReminderDomainPort(user);
    const tools = createReminderTools(port);
    const registry = new ToolRegistry([...tools]);

    const outcome = await registry.execute('reminder_cancel', { scope: 'elapsed', confirmed: true }, context, 'op-rc-2');

    expect(outcome).toMatchObject({
      status: 'success',
      data: {
        operation: 'cancel',
        records: [
          expect.objectContaining({ id: 'rem-1', status: 'cancelled' }),
        ],
      },
    });
  });
});

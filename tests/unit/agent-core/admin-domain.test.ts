import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { TurnContext } from '@templelabs/contracts';
import { createAdminTools, ToolRegistry } from '@templelabs/tools';
import { createAdminDomainPort } from '../../../src/adapters/agent-core/admin-domain.js';

const mockAuth = vi.hoisted(() => ({
  isAdminUser: vi.fn(),
}));

const mockSupabase = vi.hoisted(() => {
  const queryBuilder = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    then: vi.fn(),
  };
  return {
    from: vi.fn().mockReturnValue(queryBuilder),
    queryBuilder,
  };
});

vi.mock('../../../src/shared/auth.js', () => ({
  isAdminUser: mockAuth.isAdminUser,
}));

vi.mock('../../../src/infrastructure/database/index.js', () => ({
  supabase: {
    from: mockSupabase.from,
  },
}));

const user = { id: 'admin-123' };
const context: TurnContext = {
  userId: 'admin-123',
  runId: 'run-1',
  requestId: 'req-1',
  referenceTimeIso: '2026-10-16T12:00:00.000Z',
  timezone: 'America/Bogota',
  language: 'es',
  capabilities: new Set(['admin.metrics']),
  signal: new AbortController().signal,
};

describe('Admin domain port and tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('denies execution when user is not admin', async () => {
    mockAuth.isAdminUser.mockReturnValue(false);

    const port = createAdminDomainPort(user);
    const tools = createAdminTools(port);
    const registry = new ToolRegistry([...tools]);

    const outcome = await registry.execute('admin_metrics', {}, context, 'op-adm-1');
    expect(outcome.status).toBe('denied');
  });

  it('returns metrics successfully when user is admin', async () => {
    mockAuth.isAdminUser.mockReturnValue(true);

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'users') {
        return {
          select: vi.fn().mockResolvedValue({ count: 150 }),
        };
      }
      if (table === 'subscriptions') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({
              data: [{ amount: 14.99 }, { amount: 14.99 }],
            }),
          }),
        };
      }
      if (table === 'reminders') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ count: 42 }),
          }),
        };
      }
      if (table === 'tasks') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ count: 18 }),
          }),
        };
      }
      return { select: vi.fn().mockResolvedValue({ data: [] }) };
    });

    const port = createAdminDomainPort(user);
    const tools = createAdminTools(port);
    const registry = new ToolRegistry([...tools]);

    const outcome = await registry.execute('admin_metrics', { scope: 'overview' }, context, 'op-adm-2');

    expect(outcome).toMatchObject({
      status: 'success',
      data: {
        operation: 'metrics',
        totalUsers: 150,
        activeSubscriptions: 2,
        totalMRR: 29.98,
        pendingReminders: 42,
        pendingTasks: 18,
        complete: true,
      },
    });
  });
});

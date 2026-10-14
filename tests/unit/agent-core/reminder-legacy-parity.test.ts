import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createReminderTools, ToolRegistry } from '@templelabs/tools';
import type { TurnContext } from '@templelabs/contracts';
import { createLegacyReminderPort } from '../../../src/adapters/agent-core/legacy-reminders.js';

const database = vi.hoisted(() => ({
  saveReminder: vi.fn(), updateReminder: vi.fn(), acknowledgeReminder: vi.fn(),
  getUserSubscription: vi.fn(), hasProAccess: vi.fn(), shouldEnforceBillingForUser: vi.fn(),
  from: vi.fn(),
}));
vi.mock('../../../src/infrastructure/database/index.js', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), ...database, supabase: { from: database.from },
}));
vi.mock('../../../src/infrastructure/database/memories.js', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  getReminderDispatchPolicy: vi.fn().mockResolvedValue(null),
  getReminderConfirmationPreference: vi.fn().mockResolvedValue(null),
}));

const id = '11111111-1111-4111-8111-111111111111';
const user = { id: 'fixture-owner', phone_number: '+573000000001', timezone: 'America/Bogota' };
const reference = '2026-10-11T17:49:00Z';
const row = {
  id, user_id: user.id, phone_number: user.phone_number, content: 'Llamar a Ana',
  send_at: '2026-10-11T21:00:00.000Z', status: 'pending',
  source: 'user', recurrence_rule: null, acknowledged_at: null, requires_confirmation: false,
};

function makeQuery() {
  const query = {
    select: vi.fn(), eq: vi.fn(), neq: vi.fn(), or: vi.fn(), in: vi.fn(),
    gte: vi.fn(), lt: vi.fn(), order: vi.fn(), limit: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data: row, error: null }),
    then: (resolve: (value: { data: typeof row[]; error: null }) => unknown) => Promise.resolve(resolve({ data: [row], error: null })),
  };
  for (const method of [query.select, query.eq, query.neq, query.or, query.in, query.gte, query.lt, query.order, query.limit]) method.mockReturnValue(query);
  return query;
}
let query = makeQuery();
function registry() { return new ToolRegistry(createReminderTools(createLegacyReminderPort(user))); }
function context(): TurnContext {
  return {
    userId: user.id, runId: 'fixture-run', requestId: 'fixture-request', timezone: user.timezone,
    language: 'es', referenceTimeIso: reference, signal: new AbortController().signal,
    capabilities: new Set(['reminders.create', 'reminders.read', 'reminders.update', 'reminders.acknowledge']),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Deliberately different wall time: temporal logic must use the turn reference.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2050-01-01T12:00:00Z'));
  query = makeQuery();
  database.from.mockReturnValue(query);
  database.saveReminder.mockResolvedValue({ id });
  database.getUserSubscription.mockResolvedValue(null);
  database.hasProAccess.mockReturnValue(false);
  database.shouldEnforceBillingForUser.mockReturnValue(false);
  database.updateReminder.mockImplementation(async (_id: string, changes: Record<string, unknown>) => ({ ...row, ...changes }));
  database.acknowledgeReminder.mockResolvedValue({ ...row, acknowledged_at: '2026-10-11T21:05:00.000Z' });
});
afterEach(() => vi.useRealTimers());

describe('typed reminder adapters through the current domain executor', () => {
  it('creates the principal and advance notice in the existing ownership order', async () => {
    database.saveReminder.mockResolvedValueOnce({ id }).mockResolvedValueOnce({ id: '22222222-2222-4222-8222-222222222222' });
    const outcome = await registry().execute('reminder_create', {
      content: row.content, targetTimeIso: '2026-10-11T16:00:00-05:00', advanceMinutes: 15,
    }, context(), 'create-op');
    expect(outcome).toMatchObject({ status: 'success', data: { records: [
      { isAdvanceNotice: true, parentReminderId: id, sendAt: '2026-10-11T20:45:00.000Z' },
      { id, isAdvanceNotice: false, sendAt: row.send_at },
    ] } });
    expect(database.saveReminder.mock.calls[0]?.[0]).toMatchObject({ userId: user.id, phoneNumber: user.phone_number, sendAt: row.send_at, source: 'user' });
    expect(database.saveReminder.mock.calls[1]?.[0]).toMatchObject({ parentReminderId: id, source: 'advance_notice' });
  });

  it('returns the existing clarification for past times and writes nothing', async () => {
    const outcome = await registry().execute('reminder_create', {
      content: row.content, targetTimeIso: '2026-10-11T08:00:00-05:00',
    }, context(), 'past-op');
    expect(outcome).toMatchObject({ status: 'clarification_required', code: 'TIME_IN_PAST' });
    expect(database.saveReminder).not.toHaveBeenCalled();
  });

  it('keeps a committed principal when the legacy advance notice cannot be saved', async () => {
    database.saveReminder.mockResolvedValueOnce({ id }).mockResolvedValueOnce(null);
    const outcome = await registry().execute('reminder_create', {
      content: row.content, targetTimeIso: row.send_at, advanceMinutes: 15,
    }, context(), 'partial-op');
    expect(outcome).toMatchObject({ status: 'partial', receipt: { resourceIds: [id] }, data: { complete: false, rejections: [{ code: 'DATABASE_ERROR' }] } });
    expect(database.saveReminder).toHaveBeenCalledTimes(2);
  });

  it('updates only the owned target through the existing update mutation', async () => {
    const outcome = await registry().execute('reminder_update', { reminderId: id, targetTimeIso: '2026-10-11T21:30:00Z' }, context(), 'update-op');
    expect(outcome).toMatchObject({ status: 'success', data: { records: [{ id, sendAt: '2026-10-11T21:30:00.000Z' }] } });
    expect(query.or).toHaveBeenCalledWith(expect.stringContaining(`user_id.eq.${user.id}`));
    expect(database.updateReminder).toHaveBeenCalledExactlyOnceWith(id, { send_at: '2026-10-11T21:30:00.000Z', status: 'pending' }, user.id, user.phone_number);
  });

  it('acknowledges the exact owned reminder and preserves its confirmed time', async () => {
    const outcome = await registry().execute('reminder_acknowledge', { reminderId: id }, context(), 'ack-op');
    expect(outcome).toMatchObject({ status: 'success', data: { records: [{ id, acknowledgedAt: '2026-10-11T21:05:00.000Z' }] } });
    expect(query.eq).toHaveBeenCalledWith('id', id);
    expect(query.or).toHaveBeenCalledWith(expect.stringContaining(`user_id.eq.${user.id}`));
    expect(database.acknowledgeReminder).toHaveBeenCalledExactlyOnceWith(id, user.id);
  });

  it('uses the turn date for today reads rather than the server wall clock', async () => {
    const outcome = await registry().execute('reminder_read', { filter: 'today' }, context(), 'read-op');
    expect(outcome.status).toBe('success');
    expect(query.gte).toHaveBeenCalledWith('send_at', '2026-10-11T05:00:00.000Z');
    expect(query.lt).toHaveBeenCalledWith('send_at', '2026-10-12T05:00:00.000Z');
    expect(query.or).toHaveBeenCalledWith(expect.stringContaining(`user_id.eq.${user.id}`));
  });
});

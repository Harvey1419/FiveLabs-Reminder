import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { ReminderRow } from '../../../src/agent/tools/reminder-tool-ports.js';
const state = vi.hoisted(() => ({ rows: [] as ReminderRow[] }));
vi.mock('../../../src/agent/tools/index.js', () => ({
  executeTool: vi.fn(),
}));
vi.mock('../../../src/agent/providers/client.js', () => ({
  callChatCompletion: vi.fn(),
  callResponseSynthesis: vi.fn().mockResolvedValue(null),
  callPendingTransitionVerification: vi.fn(),
}));
vi.mock('../../../src/features/memory/service.js', () => ({
  retrieveRelevantMemories: vi.fn().mockResolvedValue([]),
  retrieveStandingPreferences: vi.fn().mockResolvedValue([]),
  getProactiveAnchors: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../src/infrastructure/database/index.js', () => ({
  getDailyOverview: vi.fn(async () => ({ pendingConfirmationReminders: state.rows.filter(row => row.status === 'sent' && row.requires_confirmation && !row.acknowledged_at) })),
  getUserSubscription: vi.fn(async () => ({ status: 'authorized', plan: 'pro' })),
  getUserIntegration: vi.fn(async () => null), hasProAccess: vi.fn(() => true),
  supabase: { from: vi.fn(() => {
    let selectedId: string | null = null;
    const query = { select: vi.fn(() => query), neq: vi.fn(() => query), or: vi.fn(() => query), in: vi.fn(() => query),
      eq: vi.fn((column: string, value: string) => { if (column === 'id') selectedId = value; return query; }),
      order: vi.fn(() => query), limit: vi.fn(async () => ({ data: state.rows, error: null })),
      maybeSingle: vi.fn(async () => ({ data: state.rows.find(row => row.id === selectedId) ?? null, error: null })),
    };
    return query;
  }) },
  acknowledgeReminder: vi.fn(async (id: string, owner: string) => {
    const row = state.rows.find(item => item.id === id && item.user_id === owner);
    if (!row) return null;
    row.acknowledged_at = '2026-09-02T17:00:00.000Z';
    return { ...row };
  }),
}));
vi.mock('../../../src/integrations/google/auth.js', () => ({
  getGoogleConnectUrl: vi.fn(() => 'https://example.test/google'),
  hasUsableGoogleCredentials: vi.fn(() => false),
}));


import { noticeWeekdayActions, noticeWeekdayMessage } from '../../fixtures/agent/behavioral-notice-weekday-fixtures.js';
import { activeNoticeActions, activeNoticeMessage } from '../../fixtures/agent/behavioral-active-notice-fixtures.js';
import { getStructuredTurnSchema } from '../../../src/agent/contracts/foreground-turn-schema.js';
import { matchesSchema } from '../../../src/agent/contracts/schema-value-contract.js';
import { validateForegroundContent } from '../../../src/agent/contracts/foreground-turn-validator.js';
import { buildDomainCall } from '../../../src/agent/orchestration/domain-call.js';
import { routeMessage } from '../../../src/agent/orchestration/router.js';
import { callChatCompletion } from '../../../src/agent/providers/client.js';
import { executeTool } from '../../../src/agent/tools/index.js';
import { executeReminderAcknowledgement } from '../../../src/agent/tools/reminder-acknowledge.js';
import { acknowledgeReminder } from '../../../src/infrastructure/database/index.js';
import { createReminderDeliveryPersistence } from '../../../src/infrastructure/database/reminder-delivery-persistence.js';
import type { ReminderClient, ReminderQuery, ReminderRow as StorageRow } from '../../../src/infrastructure/database/reminder-persistence-client.js';
import { clearWorkingMemory, saveWorkingMemory } from '../../../src/agent/core/working-memory.js';
import { untrustedResultMock } from '../../support/unit/contract-boundary.js';
const user = { id: 'active-notice-owner', phone_number: '573990001122', timezone: 'America/Bogota', locale: 'es-CO' };
const referenceTime = new Date('2026-09-02T17:00:00Z');
const notice = (id: string, content = 'Ir al baño') => ({ id, content, user_id: user.id,
  phone_number: user.phone_number, status: 'sent', requires_confirmation: true,
  acknowledged_at: null, send_at: '2026-09-02T16:55:00Z' });

beforeEach(() => {
  vi.clearAllMocks(); state.rows = []; clearWorkingMemory(user);
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(referenceTime);
  untrustedResultMock(executeTool).mockImplementation(async call => {
    if (!call || typeof call !== 'object' || call.toolName !== 'manage_reminder' || call.params?.action !== 'acknowledge') throw new Error('Unexpected tool call');
    return executeReminderAcknowledgement({ params: call.params, ...(call.user !== undefined ? { user: call.user } : {}), ...(call.language !== undefined ? { language: call.language } : {}) });
  });
});
afterEach(() => { vi.useRealTimers(); clearWorkingMemory(user); });
function plan(key: keyof typeof activeNoticeActions, language: 'es' | 'en' = 'es') { untrustedResultMock(callChatCompletion).mockResolvedValueOnce(activeNoticeMessage(key, language)); }

describe('current active-notice integration fixtures', () => {
  it.each(Object.keys(activeNoticeActions) as (keyof typeof activeNoticeActions)[])('%s validates the strict foreground protocol', key => {
    const message = activeNoticeMessage(key);
    expect(matchesSchema(JSON.parse(message.content), getStructuredTurnSchema() as Parameters<typeof matchesSchema>[1])).toBe(true);
    const validation = validateForegroundContent(message.content);
    expect(validation.valid).toBe(true);
    if (!validation.valid) throw new Error(validation.error);
    if (key === 'missingDatedEvent') expect(buildDomainCall(validation.intent.actions[0], { user, timezone: user.timezone, referenceTime })).toMatchObject({ valid: true, params: { lookupDate: '2026-09-09', target: 'cita' } });
  });

  it.each(['Ya fui', 'Ya lo hice', 'Ya está', 'Ya quedó', 'Lo terminé', 'Ya terminé', 'I have completed the reminder, thank you'])('binds %s to the sole active backend notice', async text => {
    state.rows = [notice('active'), { ...notice('other', 'Pagar internet'), status: 'pending' }];
    plan('acknowledgeActive', text === 'I have completed the reminder, thank you' ? 'en' : 'es');
    const result = await routeMessage(text, user, [], { referenceTime });
    expect(result.intent).toBe('reminder');
    expect(result.confirmation).toContain('Ir al baño');
    expect(result.confirmation).toContain(text === 'I have completed the reminder, thank you' ? 'Reminder confirmed' : 'Recordatorio confirmado');
    expect(acknowledgeReminder).toHaveBeenCalledExactlyOnceWith('active', user.id);
    expect(state.rows[0]!.acknowledged_at).not.toBeNull();
    expect(state.rows[1]!.acknowledged_at).toBeNull();
  });

  it('asks for context without any tool execution when no active notice can be identified', async () => {
    state.rows = [{ ...notice('unrelated', 'Pagar internet'), status: 'pending' }];
    plan('acknowledgeActive');
    const result = await routeMessage('Ya fui', user, [], { referenceTime });
    expect(result.executionFacts?.[0]).toMatchObject({ success: false, errorCode: 'MISSING_REQUIRED_CONTEXT', requiresClarification: true });
    expect(executeTool).not.toHaveBeenCalled();
    expect(acknowledgeReminder).not.toHaveBeenCalled();
    expect(state.rows[0]!.acknowledged_at).toBeNull();
  });

  it('does not select an arbitrary notice when two active reminders have the same title', async () => {
    state.rows = [notice('a'), notice('b')];
    plan('acknowledgeActive');
    const result = await routeMessage('Ya fui', user, [], { referenceTime });
    expect(result.executionFacts?.[0]).toMatchObject({ success: false, errorCode: 'MISSING_REQUIRED_CONTEXT' });
    expect(acknowledgeReminder).not.toHaveBeenCalled();
  });

  it('a trusted notification identity distinguishes duplicate titles', async () => {
    state.rows = [notice('a'), notice('b')];
    saveWorkingMemory(user, { source: 'reminder', lastAction: 'nudge', notificationReminderId: 'b', notificationContent: 'Ir al baño', items: [{ type: 'reminder', internalId: 'b', summary: 'Ir al baño' }] });
    plan('acknowledgeActive');
    await routeMessage('Ya fui', user, [], { referenceTime });
    expect(acknowledgeReminder).toHaveBeenCalledExactlyOnceWith('b', user.id);
    expect(state.rows[0]!.acknowledged_at).toBeNull();
  });

  it('acknowledged reminders stop nudges while eligible unacknowledged notices remain due', async () => {
    const rows: StorageRow[] = [
      { ...notice('acknowledged'), sent_at: '2026-09-02T16:30:00Z', acknowledged_at: '2026-09-02T16:45:00Z' },
      { ...notice('eligible'), sent_at: '2026-09-02T16:30:00Z', nudge_interval_minutes: 15, nudge_count: 0 },
      { ...notice('exhausted'), sent_at: '2026-09-02T16:30:00Z', nudge_count: 5, max_nudges: 5 },
    ];
    let data = [...rows];
    const is = vi.fn((column: string, value: null) => { data = data.filter(row => row[column] === value); return query as ReminderQuery; });
    const query: Pick<ReminderQuery, 'select' | 'eq' | 'is' | 'then'> = {
      select: () => query as ReminderQuery,
      eq: (column, value) => { data = data.filter(row => row[column] === value); return query as ReminderQuery; },
      is,
      then: (resolve, reject) => Promise.resolve({ data, error: null }).then(resolve, reject),
    };
    // This read exposes only its consumed select/eq/is methods; no write port exists.
    const client = { from: () => query } as unknown as ReminderClient;
    const { getRemindersDueForNudge } = createReminderDeliveryPersistence({ getClient: () => client,
      getNow: () => referenceTime, getNowMs: () => referenceTime.getTime(), logger: console });
    expect((await getRemindersDueForNudge()).map(row => row.id)).toEqual(['eligible']);
    expect(is).toHaveBeenCalledExactlyOnceWith('acknowledged_at', null);
  });

  it.each(Object.keys(noticeWeekdayActions) as (keyof typeof noticeWeekdayActions)[])('%s uses the current strict wire', key => {
    const message = noticeWeekdayMessage(key);
    expect(matchesSchema(JSON.parse(message.content), getStructuredTurnSchema() as Parameters<typeof matchesSchema>[1])).toBe(true);
    const validation = validateForegroundContent(message.content);
    expect(validation.valid).toBe(true);
    if (!validation.valid) throw new Error(validation.error);
    if (key !== 'acknowledgeNotification') expect(buildDomainCall(validation.intent.actions[0], { user, timezone: user.timezone, referenceTime }).valid).toBe(true);
  });

  it('explicit repeated completion stays on the closed notice while another notice remains active', async () => {
    const other = notice('other', 'Eres muy importante y podemos controlar nuestros impulsos');
    const target = notice('bathroom');
    state.rows = [other, target];
    saveWorkingMemory(user, { source: 'reminder', lastAction: 'nudge', notificationReminderId: target.id, notificationContent: target.content,
      items: [{ type: 'reminder', internalId: target.id, summary: target.content }] });
    untrustedResultMock(callChatCompletion).mockResolvedValueOnce(noticeWeekdayMessage('acknowledgeNotification'));
    const first = await routeMessage('Ya fui', user, [], { referenceTime });
    const firstTimestamp = target.acknowledged_at;
    expect(firstTimestamp).not.toBeNull();
    untrustedResultMock(callChatCompletion).mockResolvedValueOnce(noticeWeekdayMessage('repeatBathroom'));
    const repeated = await routeMessage('Ya fui', user, [{ role: 'user', content: 'Ya fui' }, { role: 'assistant', content: first.confirmation }], { referenceTime });
    expect(repeated.confirmation).toContain('Ir al baño');
    expect(repeated.confirmation).not.toContain(other.content);
    expect(target.acknowledged_at).toBe(firstTimestamp);
    expect(other.acknowledged_at).toBeNull();
    expect(acknowledgeReminder).toHaveBeenCalledExactlyOnceWith(target.id, user.id);
    // A genuinely new notification can still bind its own identity afterwards.
    saveWorkingMemory(user, { source: 'reminder', lastAction: 'nudge', notificationReminderId: other.id, notificationContent: other.content,
      items: [{ type: 'reminder', internalId: other.id, summary: other.content }] });
    untrustedResultMock(callChatCompletion).mockResolvedValueOnce(noticeWeekdayMessage('acknowledgeNotification'));
    await routeMessage('Listo', user, [], { referenceTime });
    expect(acknowledgeReminder).toHaveBeenCalledTimes(2);
    expect(acknowledgeReminder).toHaveBeenLastCalledWith(other.id, user.id);
  });

  it('repeated named acknowledgement preserves its first timestamp and performs one write', async () => {
    state.rows = [notice('fruit', 'Comprar fruta')];
    plan('acknowledgeNamed');
    const first = await routeMessage('Listo fruta', user, [], { referenceTime });
    const timestamp = state.rows[0]!.acknowledged_at;
    plan('acknowledgeNamed');
    const repeated = await routeMessage('Listo fruta', user, [], { referenceTime });
    expect(first.confirmation).toContain('Recordatorio confirmado');
    expect(repeated.confirmation).toContain('Recordatorio confirmado');
    expect(state.rows[0]!.acknowledged_at).toBe(timestamp);
    expect(acknowledgeReminder).toHaveBeenCalledExactlyOnceWith('fruit', user.id);
  });
});

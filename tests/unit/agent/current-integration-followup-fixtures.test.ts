import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReminderRow } from '../../../src/agent/tools/reminder-tool-ports.js';

const state = vi.hoisted(() => ({ rows: [] as ReminderRow[] }));
vi.mock('../../../src/infrastructure/database/index.js', () => ({
  supabase: { from: vi.fn(() => {
    const chain = {
      select: vi.fn(() => chain), neq: vi.fn(() => chain),
      eq: vi.fn(() => chain), or: vi.fn(() => chain), in: vi.fn(() => chain),
      order: vi.fn(() => chain),
      limit: vi.fn(async () => ({ data: state.rows, error: null })),
    };
    return chain;
  }) },
  acknowledgeReminder: vi.fn(async (id: string, owner: string) => {
    const row = state.rows.find(item => item.id === id && item.user_id === owner);
    if (!row) return null;
    row.acknowledged_at = '2026-09-02T17:00:00Z';
    return { ...row };
  }),
}));

import { behavioralFollowupActions, behavioralFollowupMessage } from '../../fixtures/agent/behavioral-followup-fixtures.js';
import { getStructuredTurnSchema } from '../../../src/agent/contracts/foreground-turn-schema.js';
import { matchesSchema } from '../../../src/agent/contracts/schema-value-contract.js';
import { validateForegroundContent } from '../../../src/agent/contracts/foreground-turn-validator.js';
import { buildDomainCall } from '../../../src/agent/orchestration/domain-call.js';
import { executeReminderAcknowledgement } from '../../../src/agent/tools/reminder-acknowledge.js';
import { acknowledgeReminder } from '../../../src/infrastructure/database/index.js';
import { createMemoryTool } from '../../../src/agent/tools/memory-tool.js';
import { formatMemoryListCard } from '../../../src/agent/tools/formatters.js';
import { clearWorkingMemory } from '../../../src/agent/core/working-memory.js';

const user = { id: 'followup-fixture-owner', phone_number: '573990001122', timezone: 'America/Bogota' };
beforeEach(() => {
  vi.clearAllMocks();
  state.rows = [];
  clearWorkingMemory(user.id);
  clearWorkingMemory(user.phone_number);
});

function domainCall(key: keyof typeof behavioralFollowupActions) {
  const message = behavioralFollowupMessage(key);
  expect(matchesSchema(JSON.parse(message.content), getStructuredTurnSchema() as Parameters<typeof matchesSchema>[1])).toBe(true);
  const validation = validateForegroundContent(message.content);
  if (!validation.valid) throw new Error(validation.error);
  expect(validation.intent.actions).toHaveLength(1);
  const call = buildDomainCall(validation.intent.actions[0], {
    user, timezone: user.timezone, language: 'es', referenceTime: '2026-09-02T17:00:00Z',
  });
  if (!call.valid || !('toolName' in call)) throw new Error('Fixture did not select a domain tool');
  return call;
}

function reminder(id: string, content: string): ReminderRow {
  return { id, content, user_id: user.id, phone_number: user.phone_number,
    send_at: '2026-09-02T17:00:00Z', status: 'pending', acknowledged_at: null };
}

describe('current behavioral follow-up integration fixtures', () => {
  it.each([
    ['calendarBirthdays', 'manage_google_calendar', 'search_events'],
    ['memoryInventory', 'manage_memory', 'list'],
    ['acknowledgeVeterinary', 'manage_reminder', 'acknowledge'],
    ['acknowledgeBandage', 'manage_reminder', 'acknowledge'],
    ['ambiguousDoctor', 'manage_reminder', 'acknowledge'],
  ] as const)('%s selects its canonical domain call', (key, name, action) => {
    const call = domainCall(key);
    expect(call.toolName).toBe(name);
    expect(call.params.action).toBe(action);
    if (key === 'calendarBirthdays') expect(call.params).toMatchObject({ scope: 'full_year', query: 'cumpleaños' });
    if (key === 'memoryInventory') expect(call.params.limit).toBe(5);
    if ('target' in behavioralFollowupActions[key]) expect(call.params.target).toBe(behavioralFollowupActions[key].target);
  });

  it.each([
    ['acknowledgeVeterinary', 'Escribirle a la veterinaria para comprar más vendaje a Borona'],
    ['acknowledgeBandage', 'Comprar más vendaje a Borona en la droguería'],
  ] as const)('%s acknowledges only the matching owned reminder', async (key, content) => {
    state.rows = [reminder('matching-reminder', content), reminder('unrelated-reminder', 'Pagar internet')];
    const call = domainCall(key);
    const result = await executeReminderAcknowledgement({ params: call.params, user, language: 'es' });
    expect(result).toMatchObject({ success: true, reminderId: 'matching-reminder' });
    expect(acknowledgeReminder).toHaveBeenCalledExactlyOnceWith('matching-reminder', user.id);
    expect(state.rows[0]!.acknowledged_at).not.toBeNull();
    expect(state.rows[1]!.acknowledged_at).toBeNull();
    expect(result.confirmation).toMatch(/confirmado/i);
  });

  it('ambiguous doctor confirmation asks clarification without mutation', async () => {
    state.rows = [reminder('doctor-maria', 'Llamar a la doctora María para la cita de control'),
      reminder('doctor-marcela', 'Llamar a la doctora Marcela para los exámenes')];
    const result = await executeReminderAcknowledgement({ params: domainCall('ambiguousDoctor').params, user, language: 'es' });
    expect(result).toMatchObject({ success: false, errorCode: 'AMBIGUOUS_TARGET', requiresClarification: true });
    expect(acknowledgeReminder).not.toHaveBeenCalled();
    expect(state.rows.map(row => row.acknowledged_at)).toEqual([null, null]);
  });

  it('memory inventory renders the stored birthday using a scoped read, without extraction', async () => {
    const memories = [{ id: 'stored-birthday', user_id: user.id, content: 'Mi cumpleaños es el 14 de octubre.' }];
    const getActiveMemories = vi.fn(async () => ({ status: 'available' as const, memories }));
    const extractAndSaveMemories = vi.fn(async () => []);
    const searchMemories = vi.fn(async () => ({ status: 'available' as const, memories: [] }));
    const { executeMemoryTool } = createMemoryTool({ getActiveMemories, searchMemories, extractAndSaveMemories,
      forgetMemories: vi.fn(async () => ({ success: true, deletedCount: 0, deletedMemories: [] })),
      selectMemoriesToForget: vi.fn(async () => []), formatMemoryListCard });
    const result = await executeMemoryTool({ action: 'list', params: domainCall('memoryInventory').params, user, language: 'es' });
    expect(result.success).toBe(true);
    expect(getActiveMemories).toHaveBeenCalledExactlyOnceWith({ userId: user.id, limit: 5, withStatus: true, throwOnError: true });
    expect(result.formattedCard).toContain('14 de octubre');
    expect(extractAndSaveMemories).not.toHaveBeenCalled();
    expect(searchMemories).not.toHaveBeenCalled();
  });
});

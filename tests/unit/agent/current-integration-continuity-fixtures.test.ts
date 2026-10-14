import { untrustedResultMock } from '../../support/unit/contract-boundary.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  getDailyOverview: vi.fn().mockResolvedValue(null),
  getUserSubscription: vi.fn().mockResolvedValue({ status: 'authorized', plan: 'pro' }),
  getUserIntegration: vi.fn().mockResolvedValue(null),
  hasProAccess: vi.fn().mockReturnValue(true),
  createPendingSubscription: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../src/integrations/google/auth.js', () => ({
  getGoogleConnectUrl: vi.fn(() => 'https://example.test/google'),
  hasUsableGoogleCredentials: vi.fn(() => false),
}));


import { afterEach } from 'vitest';
import { behavioralContinuityActions, behavioralContinuityMessage, earliestReminderObservationMessage, observedReadPayload } from '../../fixtures/agent/behavioral-continuity-fixtures.js';
import { getStructuredTurnSchema } from '../../../src/agent/contracts/foreground-turn-schema.js';
import { matchesSchema } from '../../../src/agent/contracts/schema-value-contract.js';
import { validateForegroundContent } from '../../../src/agent/contracts/foreground-turn-validator.js';
import { routeMessage } from '../../../src/agent/orchestration/router.js';
import { callChatCompletion } from '../../../src/agent/providers/client.js';
import { executeTool } from '../../../src/agent/tools/index.js';
import { clearWorkingMemory, getWorkingMemory, sanitizeResponseText } from '../../../src/agent/core/working-memory.js';

const user = { id: 'continuity-fixture-owner', phone_number: '573990001122', timezone: 'America/Bogota', locale: 'es-CO' };
const referenceTime = new Date('2026-09-02T17:00:00Z');
const first = { id: '11111111-1111-4111-8111-111111111111', user_id: user.id, content: 'Cita con el dentista a las 8am', send_at: '2026-09-03T13:00:00Z', status: 'pending' };
const second = { id: '22222222-2222-4222-8222-222222222222', user_id: user.id, content: 'Almuerzo con el cliente a las 11am', send_at: '2026-09-03T16:00:00Z', status: 'pending' };

beforeEach(() => {
  vi.clearAllMocks();
  clearWorkingMemory(user);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(referenceTime);
});
afterEach(() => { vi.useRealTimers(); clearWorkingMemory(user); });

function plan(key: keyof typeof behavioralContinuityActions) {
  untrustedResultMock(callChatCompletion).mockResolvedValueOnce(behavioralContinuityMessage(key));
}

describe('current behavioral continuity integration fixtures', () => {
  it.each(Object.keys(behavioralContinuityActions) as (keyof typeof behavioralContinuityActions)[])('%s is valid strict foreground wire', key => {
    const message = behavioralContinuityMessage(key);
    expect(matchesSchema(JSON.parse(message.content), getStructuredTurnSchema() as Parameters<typeof matchesSchema>[1])).toBe(true);
    const validation = validateForegroundContent(message.content);
    expect(validation.valid).toBe(true);
    if (!validation.valid) throw new Error(validation.error);
    expect(validation.intent.actions).toHaveLength(key === 'compoundCreation' ? 2 : 1);
    if (key === 'cancelFirst') expect(validation.intent.actions[0]?.contextRef).toEqual({ source: 'working_memory', position: 1 });
  });

  it('reads current reminders for earliest interpretation then binds cancellation to the first displayed identity', async () => {
    plan('agendaTomorrow');
    untrustedResultMock(executeTool).mockResolvedValueOnce({ success: true, action: 'unified_agenda_listed',
      data: { scope: 'tomorrow', complete: false, calendar: { state: 'DISCONNECTED', events: [] }, reminders: [first, second], tasks: [] } });
    const t1 = await routeMessage('¿Qué tengo mañana?', user, [], { referenceTime });
    expect(t1.confirmation).toContain('dentista');
    plan('earliestReminder');
    let observedAccepted = false;
    untrustedResultMock(callChatCompletion).mockImplementationOnce(async (messages, options) => {
      expect(options?.purpose).toBe('observed_answer');
      const payload = observedReadPayload(messages);
      if (typeof payload !== 'string') throw new Error('Expected current observations');
      expect(payload).toContain(first.content);
      expect(payload).toContain(second.content);
      const answer = earliestReminderObservationMessage(payload);
      const validation = options!.validateStructuredContent!(answer.content) as { valid: boolean };
      expect(validation.valid).toBe(true);
      observedAccepted = validation.valid;
      return answer;
    });
    untrustedResultMock(executeTool).mockResolvedValueOnce({ success: true, action: 'listed_reminders', data: { reminders: [first, second] } });
    const history = [{ role: 'user', content: '¿Qué tengo mañana?' }, { role: 'assistant', content: t1.confirmation }];
    const t2 = await routeMessage('¿Cuál es el más temprano?', user, history, { referenceTime });
    expect(observedAccepted).toBe(true);
    expect(t2.confirmation).toContain('más temprano');
    expect(t2.confirmation).toContain('dentista');
    expect(getWorkingMemory(user)?.items[0]?.internalId).toBe(first.id);
    plan('cancelFirst');
    untrustedResultMock(executeTool).mockResolvedValueOnce({ success: true, action: 'cancelled_reminder', data: { ...first, status: 'cancelled' } });
    await routeMessage('Cancela el primero', user, [...history, { role: 'user', content: '¿Cuál es el más temprano?' }, { role: 'assistant', content: t2.confirmation }], { referenceTime });
    const calls = untrustedResultMock(executeTool).mock.calls.map(([call]) => {
      if (!call || typeof call !== 'object') throw new Error('Expected object tool call');
      return call;
    });
    expect(calls.map(call => ({ name: call.toolName, action: call.params?.action }))).toEqual([
      { name: 'get_unified_agenda', action: undefined }, { name: 'manage_reminder', action: 'list' }, { name: 'manage_reminder', action: 'cancel' },
    ]);
    expect(calls[2]!.params?.target).toBe(first.id);
  });

  it('executes both compound intents and resolves 5 PM in the user timezone', async () => {
    plan('compoundCreation');
    untrustedResultMock(executeTool).mockResolvedValueOnce({ success: true, action: 'created_reminders', data: { reminders: [{ ...first, content: 'Llamar al banco', send_at: '2026-09-02T22:00:00Z' }] } })
      .mockResolvedValueOnce({ success: true, action: 'created_task', data: { id: '33333333-3333-4333-8333-333333333333', title: 'Reporte de finanzas', user_id: user.id } });
    await routeMessage('Recuérdame hoy a las 5pm llamar al banco y crea la tarea reporte de finanzas en Proyecto Alfa', user, [], { referenceTime });
    const calls = untrustedResultMock(executeTool).mock.calls.map(([call]) => call!);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ toolName: 'manage_reminder', params: { action: 'create', items: [{ content: 'Llamar al banco', targetTime: '2026-09-02T22:00:00.000Z' }] } });
    expect(calls[1]).toMatchObject({ toolName: 'manage_task', params: { action: 'create', items: [{ title: 'Reporte de finanzas', entityName: 'Proyecto Alfa' }] } });
  });

  it('clarification chat performs no domain tool execution', async () => {
    plan('clarificationOnly');
    const result = await routeMessage('¿cómo así? no entendí lo que dijiste', user, [], { referenceTime });
    expect(result.intent).toBe('chat');
    expect(result.confirmation).toContain('aclarar');
    expect(result.confirmation).not.toMatch(/cancelado|completado|eliminado/i);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('retains user-visible titles while removing the original integration identity markers', () => {
    const clean = sanitizeResponseText('Tus tareas son: [id: 79f71c4c] Comprar pan y [id: 550e8400-e29b-41d4-a716-446655440000] Enviar correo a hermes7a8f9b00112233.');
    expect(clean).not.toMatch(/79f71c4c|550e8400-e29b-41d4-a716-446655440000|hermes7a8f9b00112233|\[id:/);
    expect(clean).toContain('Comprar pan');
    expect(clean).toContain('Enviar correo');
  });
});

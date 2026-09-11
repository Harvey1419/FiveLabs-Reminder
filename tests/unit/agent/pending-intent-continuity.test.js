import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/agent/tools/index.js', () => ({ executeTool: vi.fn() }));

const { executeTool } = await import('../../../src/agent/tools/index.js');
const { executeTurnIntent } = await import('../../../src/agent/orchestration/intent-executor.js');
const {
  clearWorkingMemory,
  getWorkingMemory,
  getWorkingMemorySnapshot,
  hydrateWorkingMemoryFromHistory,
} = await import('../../../src/agent/core/working-memory-store.js');
const {
  getClarificationStateSnapshot,
  hydrateClarificationStateFromHistory,
} = await import('../../../src/agent/orchestration/clarification-flow.js');

const user = {
  id: 'pending-intent-user',
  phone_number: '573009876543',
  timezone: 'America/Bogota',
};
const context = {
  user,
  isPro: true,
  language: 'es',
  timezone: 'America/Bogota',
  referenceTime: new Date('2026-09-10T18:00:00.000Z'),
  correlationId: 'test-66',
};

function partialReminder(content, schedule, missingFields) {
  return { domain: 'reminder', action: 'create', content, schedule, missingFields };
}

function clarification(question, missingFields) {
  return { domain: 'clarification', action: 'request', question, missingFields };
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  clearWorkingMemory(user);
  executeTool.mockImplementation(async ({ toolName, params }) => ({
    success: true,
    complete: true,
    action: 'executed',
    data: { items: (params.items || []).map((item, index) => ({ ...item, id: `${toolName}-${index}` })) },
    rawSummary: 'ok',
  }));
});

describe('TEST #66 — typed pending-intent continuity', () => {
  it('materializes one clarification when strict output supplies only a typed partial action', async () => {
    const result = await executeTurnIntent({ actions: [{
      ...partialReminder('Revisar Alfa', null, ['schedule']),
      question: '¿Cuándo quieres que te lo recuerde?',
    }] }, context);

    expect(executeTool).not.toHaveBeenCalled();
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]).toMatchObject({ requiresClarification: true });
    expect(getWorkingMemory(user).pendingIntent).toMatchObject({
      actions: [{ domain: 'reminder', action: 'create', content: 'Revisar Alfa', missingFields: ['schedule'] }],
      question: '¿Cuándo quieres que te lo recuerde?',
    });
    expect(getWorkingMemory(user).pendingClarifications).toEqual([]);
  });

  it('preserves one coherent multi-action intent and merges later clocks into its known date', async () => {
    const contents = ['Pendiente A', 'Pendiente B', 'Pendiente C'];
    const first = await executeTurnIntent({
      actions: [
        ...contents.map((content) => partialReminder(
          content,
          { kind: 'relative_day_time', dayOffset: 1 },
          ['time'],
        )),
        clarification('¿A qué hora va cada pendiente?', ['time']),
      ],
    }, context);

    expect(executeTool).not.toHaveBeenCalled();
    expect(first.facts).toHaveLength(1);
    const pending = getWorkingMemory(user)?.pendingIntent;
    expect(pending?.actions).toHaveLength(3);
    expect(getWorkingMemory(user)?.pendingClarifications).toEqual([]);
    expect(pending.actions.every((action) => action.schedule.dayOffset === 1)).toBe(true);

    const second = await executeTurnIntent({
      pendingIntentEffect: 'resolve',
      actions: [8, 10, 12].map((hour, index) => ({
        domain: 'reminder',
        action: 'create',
        continuationIndex: index + 1,
        schedule: { kind: 'local_time', hour, minute: 0, clockMode: 'explicit_24h' },
      })),
    }, context);

    expect(second.facts).toHaveLength(3);
    expect(second.facts.every((fact) => fact.success && fact.errorCode !== 'TIME_IN_PAST')).toBe(true);
    expect(executeTool.mock.calls.map(([call]) => call.params.items[0])).toEqual([
      { content: 'Pendiente A', targetTime: '2026-09-11T13:00:00.000Z' },
      { content: 'Pendiente B', targetTime: '2026-09-11T15:00:00.000Z' },
      { content: 'Pendiente C', targetTime: '2026-09-11T17:00:00.000Z' },
    ]);
    expect(getWorkingMemory(user)?.pendingIntent || null).toBeNull();
  });

  it('never executes a clock that Hermes explicitly marks as ambiguous', async () => {
    const result = await executeTurnIntent({ actions: [{
      domain: 'reminder', action: 'create', content: 'Revisar Alfa',
      schedule: { kind: 'relative_day_time', dayOffset: 1, hour: 8, minute: 0, clockMode: 'ambiguous_12h' },
    }] }, context);

    expect(executeTool).not.toHaveBeenCalled();
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]).toMatchObject({ requiresClarification: true });
    expect(getWorkingMemory(user).pendingIntent.actions).toHaveLength(1);
  });

  it('expands several supplied times from one coherent pending action without creating separate clarification states', async () => {
    await executeTurnIntent({ actions: [
      partialReminder('Revisar pendientes', { kind: 'relative_day_time', dayOffset: 1 }, ['time']),
      clarification('¿A qué horas?', ['time']),
    ] }, context);

    await executeTurnIntent({
      pendingIntentEffect: 'resolve',
      actions: [8, 10, 12].map((hour) => ({
        domain: 'reminder', action: 'create', continuationIndex: 1,
        schedule: { kind: 'local_time', hour, minute: 0, clockMode: 'explicit_24h' },
      })),
    }, context);

    expect(executeTool).toHaveBeenCalledTimes(3);
    expect(executeTool.mock.calls.map(([call]) => call.params.items[0].content)).toEqual([
      'Revisar pendientes', 'Revisar pendientes', 'Revisar pendientes',
    ]);
    expect(executeTool.mock.calls.map(([call]) => call.params.items[0].targetTime)).toEqual([
      '2026-09-11T13:00:00.000Z', '2026-09-11T15:00:00.000Z', '2026-09-11T17:00:00.000Z',
    ]);
  });

  it('completes either missing half of a typed schedule without losing the known half', async () => {
    await executeTurnIntent({ actions: [
      partialReminder('Pagar factura', { kind: 'relative_day_time', dayOffset: 1 }, ['time']),
      clarification('¿A qué hora?', ['time']),
    ] }, context);
    await executeTurnIntent({
      pendingIntentEffect: 'resolve',
      actions: [{
        domain: 'reminder', action: 'create', continuationIndex: 1,
        schedule: { kind: 'local_time', hour: 9, minute: 0, clockMode: 'explicit_24h' },
      }],
    }, context);
    expect(executeTool.mock.calls[0][0].params.items[0]).toEqual({
      content: 'Pagar factura', targetTime: '2026-09-11T14:00:00.000Z',
    });

    clearWorkingMemory(user);
    executeTool.mockClear();
    await executeTurnIntent({ actions: [
      partialReminder('Llamar a Juan', { kind: 'local_time', hour: 16, minute: 0, clockMode: 'explicit_24h' }, ['date']),
      clarification('¿Qué día?', ['date']),
    ] }, context);
    await executeTurnIntent({
      pendingIntentEffect: 'resolve',
      actions: [{
        domain: 'reminder', action: 'create', continuationIndex: 1,
        schedule: { kind: 'relative_day_time', dayOffset: 1 },
      }],
    }, context);
    expect(executeTool.mock.calls[0][0].params.items[0]).toEqual({
      content: 'Llamar a Juan', targetTime: '2026-09-11T21:00:00.000Z',
    });
  });

  it('lets an explicit structured correction replace an earlier temporal anchor', async () => {
    await executeTurnIntent({ actions: [
      partialReminder('Enviar informe', { kind: 'relative_day_time', dayOffset: 1 }, ['time']),
      clarification('¿A qué hora?', ['time']),
    ] }, context);

    await executeTurnIntent({
      pendingIntentEffect: 'resolve',
      actions: [{
        domain: 'reminder', action: 'create', continuationIndex: 1,
        schedule: { kind: 'weekday_time', weekday: 'friday', weekOffset: 0, hour: 9, minute: 0, clockMode: 'explicit_24h' },
      }],
    }, context);

    expect(executeTool.mock.calls[0][0].params.items[0]).toEqual({
      content: 'Enviar informe', targetTime: '2026-09-11T14:00:00.000Z',
    });
  });

  it('keeps a correction pending when another required field is still missing', async () => {
    await executeTurnIntent({ actions: [
      partialReminder('Enviar informe', { kind: 'relative_day_time', dayOffset: 1 }, ['time']),
      clarification('¿A qué hora?', ['time']),
    ] }, context);

    await executeTurnIntent({
      pendingIntentEffect: 'replace',
      actions: [
        {
          domain: 'reminder', action: 'create', continuationIndex: 1,
          schedule: { kind: 'weekday_time', weekday: 'friday', weekOffset: 0 }, missingFields: ['time'],
        },
        clarification('¿A qué hora el viernes?', ['time']),
      ],
    }, context);

    expect(executeTool).not.toHaveBeenCalled();
    expect(getWorkingMemory(user).pendingIntent.actions[0]).toMatchObject({
      content: 'Enviar informe',
      schedule: { kind: 'weekday_time', weekday: 'friday', weekOffset: 0 },
      missingFields: ['time'],
    });
  });

  it('can resolve a pending confirmation by inheriting the already known canonical fields', async () => {
    await executeTurnIntent({ actions: [
      {
        domain: 'reminder', action: 'create', content: 'Enviar informe',
        schedule: { kind: 'relative_day_time', dayOffset: 1, hour: 9, minute: 0, clockMode: 'explicit_24h' },
        missingFields: ['selection'],
      },
      clarification('¿Confirmas esta operación?', ['selection']),
    ] }, context);

    await executeTurnIntent({
      pendingIntentEffect: 'resolve',
      actions: [{ domain: 'reminder', action: 'create', continuationIndex: 1 }],
    }, context);

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool.mock.calls[0][0].params.items[0]).toEqual({
      content: 'Enviar informe', targetTime: '2026-09-11T14:00:00.000Z',
    });
  });

  it('discards a pending intent without invoking a domain tool', async () => {
    await executeTurnIntent({ actions: [
      partialReminder('Pagar factura', { kind: 'relative_day_time', dayOffset: 1 }, ['time']),
      clarification('¿A qué hora?', ['time']),
    ] }, context);

    const result = await executeTurnIntent({
      actions: [{ domain: 'pending', action: 'discard' }],
    }, context);

    expect(result.facts[0]).toMatchObject({ success: true, action: 'discarded_pending' });
    expect(executeTool).not.toHaveBeenCalled();
    expect(getWorkingMemory(user)).toBeNull();
  });

  it('completes a shared target for several task actions without rebuilding their contents', async () => {
    await executeTurnIntent({ actions: [
      { domain: 'task', action: 'create', title: 'Comprar leche', missingFields: ['target'] },
      { domain: 'task', action: 'create', title: 'Comprar pan', missingFields: ['target'] },
      clarification('¿En cuál lista?', ['target']),
    ] }, context);

    await executeTurnIntent({
      pendingIntentEffect: 'resolve',
      actions: [1, 2].map((continuationIndex) => ({
        domain: 'task', action: 'create', continuationIndex, entityName: 'Compras', category: 'project',
      })),
    }, context);

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool.mock.calls[0][0].params.items.map((item) => item.title)).toEqual(['Comprar leche', 'Comprar pan']);
    expect(executeTool.mock.calls[0][0].params.items.every((item) => item.entityName === 'Compras')).toBe(true);
  });

  it('preserves the pending intent and its original TTL across independent operations', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T18:00:00.000Z'));
    await executeTurnIntent({ actions: [
      partialReminder('Pagar factura', { kind: 'relative_day_time', dayOffset: 1 }, ['time']),
      clarification('¿A qué hora?', ['time']),
    ] }, context);
    const original = structuredClone(getWorkingMemory(user).pendingIntent);
    const originalExpiry = getWorkingMemory(user).pendingExpiresAt;

    vi.advanceTimersByTime(5 * 60 * 1000);
    await executeTurnIntent({
      pendingIntentEffect: 'preserve',
      actions: [{ domain: 'task', action: 'create', title: 'Comprar café', projectless: true }],
    }, context);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(getWorkingMemory(user).pendingIntent).toEqual(original);
    expect(getWorkingMemory(user).pendingExpiresAt).toBe(originalExpiry);

    vi.advanceTimersByTime(5 * 60 * 1000);
    await executeTurnIntent({
      pendingIntentEffect: 'preserve',
      actions: [{ domain: 'task', action: 'create', title: 'Revisar contrato', projectless: true }],
    }, context);
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(getWorkingMemory(user).pendingIntent).toEqual(original);
    expect(getWorkingMemory(user).pendingExpiresAt).toBe(originalExpiry);

    executeTool.mockClear();
    const unsafe = await executeTurnIntent({
      actions: [{ domain: 'task', action: 'create', title: 'Otra tarea', projectless: true }],
    }, context);
    expect(unsafe.facts[0].errorCode).toBe('PENDING_INTENT_EFFECT_REQUIRED');
    expect(executeTool).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(getWorkingMemory(user).pendingIntent).toBeNull();
    const stale = await executeTurnIntent({
      pendingIntentEffect: 'resolve',
      actions: [{
        domain: 'reminder', action: 'create', continuationIndex: 1,
        schedule: { kind: 'local_time', hour: 9, minute: 0, clockMode: 'explicit_24h' },
      }],
    }, context);
    expect(stale.facts[0].errorCode).toBe('NO_PENDING_INTENT');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('does not execute or discard a compound intent when only part of it was resolved', async () => {
    await executeTurnIntent({ actions: [
      partialReminder('Pendiente A', { kind: 'relative_day_time', dayOffset: 1 }, ['time']),
      partialReminder('Pendiente B', { kind: 'relative_day_time', dayOffset: 1 }, ['time']),
      clarification('¿A qué hora va cada uno?', ['time']),
    ] }, context);
    executeTool.mockClear();

    const result = await executeTurnIntent({
      pendingIntentEffect: 'resolve',
      actions: [{
        domain: 'reminder', action: 'create', continuationIndex: 1,
        schedule: { kind: 'local_time', hour: 8, minute: 0, clockMode: 'explicit_24h' },
      }],
    }, context);

    expect(result.facts[0].errorCode).toBe('INCOMPLETE_PENDING_CONTINUATION');
    expect(executeTool).not.toHaveBeenCalled();
    expect(getWorkingMemory(user).pendingIntent.actions).toHaveLength(2);
  });

  it('persists the typed pending intent in snapshot v3 and refuses to hydrate it after expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T18:00:00.000Z'));
    await executeTurnIntent({ actions: [
      partialReminder('Pagar factura', { kind: 'relative_day_time', dayOffset: 1 }, ['time']),
      clarification('¿A qué hora?', ['time']),
    ] }, context);
    const snapshot = getClarificationStateSnapshot(user);
    expect(snapshot.version).toBe(3);
    expect(snapshot.pendingIntent.actions[0].content).toBe('Pagar factura');

    clearWorkingMemory(user);
    hydrateClarificationStateFromHistory(user, [{ role: 'assistant', entities: { _conversationState: snapshot } }]);
    expect(getWorkingMemory(user).pendingIntent.actions[0].schedule.dayOffset).toBe(1);

    clearWorkingMemory(user);
    vi.advanceTimersByTime(16 * 60 * 1000);
    hydrateClarificationStateFromHistory(user, [{ role: 'assistant', entities: { _conversationState: snapshot } }]);
    expect(getWorkingMemory(user)).toBeNull();
  });

  it('rejects a stale continuation without mutating backend state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T18:00:00.000Z'));
    await executeTurnIntent({ actions: [
      partialReminder('Pagar factura', { kind: 'relative_day_time', dayOffset: 1 }, ['time']),
      clarification('¿A qué hora?', ['time']),
    ] }, context);
    vi.advanceTimersByTime(16 * 60 * 1000);
    executeTool.mockClear();

    const result = await executeTurnIntent({
      pendingIntentEffect: 'resolve',
      actions: [{
        domain: 'reminder', action: 'create', continuationIndex: 1,
        schedule: { kind: 'local_time', hour: 9, minute: 0, clockMode: 'explicit_24h' },
      }],
    }, context);

    expect(result.facts[0].errorCode).toBe('NO_PENDING_INTENT');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('does not resurrect an expired pending intent from a recent persisted working-memory turn', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T18:00:00.000Z'));
    await executeTurnIntent({ actions: [
      partialReminder('Pagar factura', { kind: 'relative_day_time', dayOffset: 1 }, ['time']),
      clarification('¿A qué hora?', ['time']),
    ] }, context);
    vi.advanceTimersByTime(5 * 60 * 1000);
    await executeTurnIntent({
      pendingIntentEffect: 'preserve',
      actions: [{ domain: 'task', action: 'create', title: 'Revisar contrato', projectless: true }],
    }, context);
    const snapshot = getWorkingMemorySnapshot(user);

    vi.advanceTimersByTime(11 * 60 * 1000);
    clearWorkingMemory(user);
    hydrateWorkingMemoryFromHistory(user, [{
      role: 'assistant',
      createdAt: new Date().toISOString(),
      entities: { _workingMemory: snapshot },
    }], new Date());

    expect(getWorkingMemory(user)?.pendingIntent || null).toBeNull();
    expect(getWorkingMemory(user)?.items).toHaveLength(1);
    expect(getWorkingMemory(user)?.items[0].title).toBe('Revisar contrato');
    executeTool.mockClear();
    const result = await executeTurnIntent({
      pendingIntentEffect: 'resolve',
      actions: [{
        domain: 'reminder', action: 'create', continuationIndex: 1,
        schedule: { kind: 'local_time', hour: 9, minute: 0, clockMode: 'explicit_24h' },
      }],
    }, context);
    expect(result.facts[0].errorCode).toBe('NO_PENDING_INTENT');
    expect(executeTool).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
import {
  compileTurnManifest,
  findRepairableManifestIssue,
  resolveTypedSchedule,
  TURN_OPERATION_LIMIT,
} from '../../../src/agent/orchestration/turn-plan.js';
import { validateToolCall } from '../../../src/agent/contracts/tool-contracts.js';

const referenceTime = new Date('2026-09-05T03:20:00.000Z'); // Sep 4, 10:20 PM in Bogota

describe('typed turn planning contract', () => {
  it('resolves an unqualified 12-hour clock to the nearest future occurrence on the requested local day', () => {
    const result = resolveTypedSchedule({
      kind: 'relative_day_time', dayOffset: 0, hour: 8, minute: 0, clockMode: 'ambiguous_12h',
    }, {
      timezone: 'America/Bogota',
      referenceTime: new Date('2026-09-05T23:24:00.000Z'), // 6:24 PM local
    });

    expect(result).toMatchObject({
      valid: true,
      canonical: '2026-09-06T01:00:00.000Z', // 8:00 PM local
      clockResolution: 'nearest_future_on_local_date',
      resolvedHour: 20,
    });
  });

  it.each([
    ['explicit_am', 8, '2026-09-05T13:00:00.000Z'],
    ['explicit_pm', 8, '2026-09-06T01:00:00.000Z'],
    ['explicit_24h', 20, '2026-09-06T01:00:00.000Z'],
  ])('preserves %s clock semantics without guessing', (clockMode, hour, expected) => {
    const result = resolveTypedSchedule({
      kind: 'relative_day_time', dayOffset: 0, hour, minute: 0, clockMode,
    }, {
      timezone: 'America/Bogota',
      referenceTime: new Date('2026-09-05T23:24:00.000Z'),
    });

    expect(result).toMatchObject({ valid: true, canonical: expected });
  });

  it.each([
    ['America/Bogota', '2026-09-05T15:00:00.000Z'],
    ['Europe/Madrid', '2026-09-05T08:00:00.000Z'],
    ['Asia/Tokyo', '2026-09-05T01:00:00.000Z'],
    ['America/New_York', '2026-09-05T14:00:00.000Z'],
  ])('resolves the same local clock in %s using its real timezone', (timezone, expected) => {
    const result = resolveTypedSchedule({
      kind: 'calendar_date_time', year: 2026, month: 9, day: 5, hour: 10, minute: 0,
    }, { timezone, referenceTime });

    expect(result).toMatchObject({ valid: true, canonical: expected });
  });

  it('preserves tomorrow wall-clock time across DST instead of adding 24 hours', () => {
    const result = resolveTypedSchedule({
      kind: 'relative_day_time', dayOffset: 1, hour: 10, minute: 0,
    }, {
      timezone: 'America/New_York',
      referenceTime: new Date('2026-03-07T17:00:00.000Z'), // Mar 7, noon local
    });

    expect(result).toMatchObject({ valid: true, canonical: '2026-03-08T14:00:00.000Z' });
  });

  it('normalizes an already typed whole-hour clock to minute zero without parsing language', () => {
    const result = resolveTypedSchedule({
      kind: 'relative_day_time', dayOffset: 1, hour: 15,
    }, { timezone: 'America/Bogota', referenceTime });

    expect(result).toMatchObject({
      valid: true,
      canonical: '2026-09-05T20:00:00.000Z',
      temporalKind: 'relative_day_time',
    });
  });

  it('combines a typed calendar date field with a local clock without language parsing', () => {
    const message = 'A las 9 y avísame 30 minutos antes';
    const result = compileTurnManifest({
      operations: [{
        sequence: 1,
        kind: 'reminder_create',
        sourceQuote: message,
        content: 'Cita pendiente',
        date: '2026-09-09',
        schedule: { kind: 'local_time', hour: 9, minute: 0 },
        advanceMinutes: 30,
      }],
      excludedClauses: [],
    }, { userMessage: message, referenceTime, timezone: 'America/Bogota' });

    expect(result.entries[0]).toMatchObject({
      valid: true,
      temporalKind: 'calendar_date_time',
      params: {
        action: 'create',
        items: [{ targetTime: '2026-09-09T14:00:00.000Z', advanceMinutes: 30 }],
      },
    });
  });

  it('fills the current local year for a typed yearless calendar date', () => {
    const result = resolveTypedSchedule({
      kind: 'calendar_date_time', month: 9, day: 9, hour: 9, minute: 0,
    }, { timezone: 'America/Bogota', referenceTime });

    expect(result).toMatchObject({
      valid: true,
      canonical: '2026-09-09T14:00:00.000Z',
      temporalKind: 'calendar_date_time',
    });
  });

  it.each([
    ['Europe/Madrid', { year: 2026, month: 3, day: 29, hour: 2, minute: 30 }],
    ['America/New_York', { year: 2026, month: 3, day: 8, hour: 2, minute: 30 }],
  ])('rejects a nonexistent spring-forward wall clock in %s', (timezone, localTime) => {
    const result = resolveTypedSchedule({ kind: 'calendar_date_time', ...localTime }, { timezone, referenceTime });

    expect(result).toMatchObject({ valid: false, errorCode: 'INVALID_LOCAL_TIME' });
  });

  it('accepts a valid clock immediately after the New York DST gap', () => {
    const result = resolveTypedSchedule({
      kind: 'calendar_date_time', year: 2026, month: 3, day: 8, hour: 3, minute: 30,
    }, { timezone: 'America/New_York', referenceTime });

    expect(result).toMatchObject({ valid: true, canonical: '2026-03-08T07:30:00.000Z' });
  });

  it('calculates a named weekday from backend calendar parts and rejects impossible dates', () => {
    const monday = resolveTypedSchedule({
      kind: 'weekday_time', weekday: 'monday', weekOffset: 0, hour: 9, minute: 0,
    }, { timezone: 'America/Bogota', referenceTime });
    const impossible = resolveTypedSchedule({
      kind: 'calendar_date_time', year: 2026, month: 9, day: 31, hour: 9, minute: 0,
    }, { timezone: 'America/Bogota', referenceTime });

    expect(monday).toMatchObject({ valid: true, canonical: '2026-09-07T14:00:00.000Z' });
    expect(impossible).toMatchObject({ valid: false, errorCode: 'INVALID_CALENDAR_DATE' });
  });

  it('compiles every independent operation in a dense cross-domain turn', () => {
    const userMessage = [
      'Recuérdame llamar en 10 minutos y enviar el informe mañana a las 9.',
      'Crea la tarea preparar demo en Trabajo.',
      'Crea los proyectos Casa y Salud.',
      'Muestra las tareas pendientes de Trabajo.',
      'Cancela la tarea antigua y cancela el recordatorio de agua.',
    ].join(' ');
    const manifest = {
      operations: [
        { sequence: 1, kind: 'reminder_create', sourceQuote: 'llamar en 10 minutos', content: 'Llamar', schedule: { kind: 'relative_offset', offsetMinutes: 10 } },
        { sequence: 2, kind: 'reminder_create', sourceQuote: 'enviar el informe mañana a las 9', content: 'Enviar el informe', schedule: { kind: 'relative_day_time', dayOffset: 1, hour: 9, minute: 0 } },
        { sequence: 3, kind: 'task_create', sourceQuote: 'Crea la tarea preparar demo en Trabajo', title: 'Preparar demo', entityName: 'Trabajo' },
        { sequence: 4, kind: 'entity_create', sourceQuote: 'Crea los proyectos Casa y Salud', entityName: 'Casa', category: 'project' },
        { sequence: 5, kind: 'entity_create', sourceQuote: 'Crea los proyectos Casa y Salud', entityName: 'Salud', category: 'project' },
        { sequence: 6, kind: 'task_list', sourceQuote: 'Muestra las tareas pendientes de Trabajo', entityName: 'Trabajo', status: 'pending' },
        { sequence: 7, kind: 'task_delete', sourceQuote: 'Cancela la tarea antigua', title: 'tarea antigua' },
        { sequence: 8, kind: 'reminder_cancel', sourceQuote: 'cancela el recordatorio de agua', content: 'recordatorio de agua' },
      ],
    };

    const result = compileTurnManifest(manifest, {
      userMessage, referenceTime, timezone: 'America/Bogota', workingMemory: { items: [] },
    });

    expect(result.valid).toBe(true);
    expect(result.entries).toHaveLength(7);
    expect(result.entries.every((entry) => entry.valid)).toBe(true);
    expect(result.entries.map((entry) => entry.toolName)).toEqual([
      'manage_reminder', 'manage_task', 'manage_entity',
      'manage_entity', 'manage_task', 'manage_task', 'manage_reminder',
    ]);
    expect(result.entries[0].params.items).toHaveLength(2);
    expect(result.entries[0].params.items[0].targetTime).toBe('2026-09-05T03:30:00.000Z');
    expect(result.entries[0].params.items[1].targetTime).toBe('2026-09-05T14:00:00.000Z');
  });

  it('normalizes a typed merge destination supplied as entityName', () => {
    const message = 'Fusiona Mudanza dentro de Hogar';
    const result = compileTurnManifest({
      operations: [{
        sequence: 1,
        kind: 'entity_merge',
        sourceQuote: message,
        sourceName: 'Mudanza',
        entityName: 'Hogar',
      }],
      excludedClauses: [],
    }, { userMessage: message, referenceTime, timezone: 'America/Bogota' });

    expect(result.entries[0]).toMatchObject({
      valid: true,
      params: { action: 'merge', sourceName: 'Mudanza', targetName: 'Hogar' },
    });
  });

  it('requires current-message evidence and typed references for follow-up advances', () => {
    const oneReminder = { items: [{ position: 1, type: 'reminder', title: 'Cita médica', time: '2026-09-06T15:00:00.000Z' }] };
    const twoReminders = { items: [...oneReminder.items, { position: 2, type: 'reminder', title: 'Llamada', time: '2026-09-06T16:00:00.000Z' }] };
    const operation = {
      sequence: 1, kind: 'reminder_add_advance', sourceQuote: 'Avísame 10 minutos antes', advanceMinutes: 10,
    };

    const implicitSingle = compileTurnManifest({ operations: [operation] }, {
      userMessage: operation.sourceQuote, referenceTime, timezone: 'America/Bogota', workingMemory: oneReminder,
    });
    const implicitAmbiguous = compileTurnManifest({ operations: [operation] }, {
      userMessage: operation.sourceQuote, referenceTime, timezone: 'America/Bogota', workingMemory: twoReminders,
    });
    const inventedEvidence = compileTurnManifest({ operations: [{ ...operation, sourceQuote: 'diez minutos antes' }] }, {
      userMessage: 'Hazlo con tiempo', referenceTime, timezone: 'America/Bogota', workingMemory: oneReminder,
    });

    expect(implicitSingle.entries[0]).toMatchObject({ valid: true, params: { action: 'update', target: '1', advanceMinutes: 10 } });
    expect(implicitAmbiguous.entries[0]).toMatchObject({ valid: false, errorCode: 'AMBIGUOUS_REFERENCE', requiresClarification: true });
    expect(inventedEvidence.entries[0]).toMatchObject({ valid: false, errorCode: 'UNTRUSTED_SOURCE_QUOTE' });
  });

  it('anchors minor source-quote inflections to a contiguous current-message span', () => {
    const userMessage = 'Bueno, me convenciste: anotá revisar el portafolio como tarea suelta.';
    const aligned = compileTurnManifest({ operations: [{
      sequence: 1,
      kind: 'task_create',
      sourceQuote: 'anoté revisar el portafolio como tarea suelta',
      title: 'Revisar el portafolio',
    }] }, { userMessage, referenceTime, timezone: 'America/Bogota' });
    const reconstructed = compileTurnManifest({ operations: [{
      sequence: 1,
      kind: 'task_create',
      sourceQuote: 'convenciste revisar tarea suelta',
      title: 'Revisar el portafolio',
    }] }, { userMessage, referenceTime, timezone: 'America/Bogota' });

    expect(aligned.entries[0]).toMatchObject({ valid: true, toolName: 'manage_task' });
    expect(reconstructed.entries[0]).toMatchObject({ valid: false, errorCode: 'UNTRUSTED_SOURCE_QUOTE' });
  });

  it('repairs stale evidence only for safe reads while keeping mutations strict', () => {
    const userMessage = '¿Qué recuerdas sobre mis reuniones?';
    const safeRead = compileTurnManifest({ operations: [{
      sequence: 1,
      kind: 'memory_search',
      sourceQuote: 'prefiero reuniones después de las diez',
      query: 'reuniones',
    }] }, { userMessage, referenceTime, timezone: 'America/Bogota' });
    const mutation = compileTurnManifest({ operations: [{
      sequence: 1,
      kind: 'memory_forget',
      sourceQuote: 'olvida mis reuniones',
      query: 'reuniones',
    }] }, { userMessage, referenceTime, timezone: 'America/Bogota' });

    expect(safeRead.entries[0]).toMatchObject({
      valid: true,
      operation: { sourceQuote: userMessage, sourceQuoteRepaired: true },
    });
    expect(mutation.entries[0]).toMatchObject({ valid: false, errorCode: 'UNTRUSTED_SOURCE_QUOTE' });
  });

  it('folds a same-turn advance reference into the created reminder and batches its sibling reminders', () => {
    const message = 'Recuérdame llamar en 10 minutos, escribir en 20 minutos y la cita hoy a las 4. Avísame 30 minutos antes de esa cita.';
    for (const referenceSource of ['turn_operation', 'working_memory']) {
      const result = compileTurnManifest({
        operations: [
          { sequence: 1, kind: 'reminder_create', sourceQuote: 'llamar en 10 minutos', content: 'Llamar', schedule: { kind: 'relative_offset', offsetMinutes: 10 } },
          { sequence: 2, kind: 'reminder_create', sourceQuote: 'escribir en 20 minutos', content: 'Escribir', schedule: { kind: 'relative_offset', offsetMinutes: 20 } },
          { sequence: 3, kind: 'reminder_create', sourceQuote: 'la cita hoy a las 4', content: 'La cita', schedule: { kind: 'relative_day_time', dayOffset: 0, hour: 16, minute: 0 } },
          { sequence: 4, kind: 'reminder_add_advance', sourceQuote: 'Avísame 30 minutos antes de esa cita', contextRef: { source: referenceSource, position: 3 }, advanceMinutes: 30 },
        ],
      }, { userMessage: message, referenceTime, timezone: 'America/Bogota', workingMemory: { items: [] } });

      expect(result.valid).toBe(true);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toMatchObject({
        toolName: 'manage_reminder',
        params: {
          action: 'create',
          items: [
            expect.objectContaining({ content: 'Llamar' }),
            expect.objectContaining({ content: 'Escribir' }),
            expect.objectContaining({ content: 'La cita', advanceMinutes: 30 }),
          ],
        },
      });
    }
  });

  it('folds a provider-split WhatsApp advance notice into its calendar event', () => {
    const message = 'Crea revisión semanal mañana a las dos y avísame 20 minutos antes por WhatsApp.';
    const result = compileTurnManifest({ operations: [
      {
        sequence: 1,
        kind: 'calendar_create',
        sourceQuote: 'Crea revisión semanal mañana a las dos',
        title: 'Revisión semanal',
        schedule: { kind: 'relative_day_time', dayOffset: 1, hour: 14, minute: 0 },
      },
      {
        sequence: 2,
        kind: 'reminder_create',
        sourceQuote: 'avísame 20 minutos antes por WhatsApp',
        content: 'Revisión semanal en Google Calendar',
        schedule: { kind: 'relative_day_time', dayOffset: 1, hour: 13, minute: 40 },
        advanceMinutes: 20,
      },
    ] }, { userMessage: message, referenceTime, timezone: 'America/Bogota' });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      valid: true,
      toolName: 'manage_google_calendar',
      params: { action: 'create_event', advanceMinutes: 20 },
    });
  });

  it('folds an inherited same-turn calendar notice through unique typed context', () => {
    const message = 'Crea revisión semanal mañana a las dos y avísame 20 minutos antes por WhatsApp.';
    const result = compileTurnManifest({ operations: [
      {
        sequence: 1,
        kind: 'calendar_create',
        sourceQuote: message,
        title: 'Revisión semanal',
        schedule: { kind: 'relative_day_time', dayOffset: 1, hour: 14, minute: 0 },
      },
      {
        sequence: 2,
        kind: 'reminder_create',
        sourceQuote: message,
        content: 'Revisión semanal',
        schedule: { kind: 'inherit_context' },
        advanceMinutes: 20,
      },
    ] }, { userMessage: message, referenceTime, timezone: 'America/Bogota' });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      valid: true,
      toolName: 'manage_google_calendar',
      params: { action: 'create_event', advanceMinutes: 20 },
    });
  });

  it('executes a revised pending proposal once even if a provider adds a redundant execute step', () => {
    const message = 'Sí, pero mejor mañana a las 5:30.';
    const result = compileTurnManifest({
      operations: [
        {
          sequence: 1,
          kind: 'revise_pending',
          sourceQuote: message,
          contextRef: { source: 'pending_state', position: 1 },
          schedule: { kind: 'relative_day_time', dayOffset: 1, hour: 17, minute: 30 },
        },
        {
          sequence: 2,
          kind: 'execute_pending',
          sourceQuote: 'Sí',
          contextRef: { source: 'pending_state', position: 1 },
        },
      ],
    }, { userMessage: message, referenceTime, timezone: 'America/Bogota' });

    expect(result.valid).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ valid: true, type: 'pending', operation: { kind: 'revise_pending' } });
  });

  it('compiles a bulk project deletion with explicit exceptions for confirmation staging', () => {
    const message = 'Elimina todos mis proyectos excepto Reminder Pro.';
    const result = compileTurnManifest({
      operations: [{
        sequence: 1,
        kind: 'entity_delete',
        sourceQuote: message,
        category: 'project',
        scope: 'all',
        preserveNames: ['Reminder Pro'],
      }],
    }, { userMessage: message, referenceTime, timezone: 'America/Bogota' });

    expect(result).toMatchObject({
      valid: true,
      entries: [{
        toolName: 'manage_entity',
        params: {
          action: 'delete',
          category: 'project',
          scope: 'all',
          preserveNames: ['Reminder Pro'],
        },
      }],
    });
  });

  it('compiles elapsed reminder cleanup as one typed collection operation without a target', () => {
    const message = 'Elimina todos los recordatorios cuya hora ya pasó.';
    const result = compileTurnManifest({
      operations: [{
        sequence: 1,
        kind: 'reminder_cancel',
        sourceQuote: message,
        scope: 'elapsed',
      }],
    }, { userMessage: message, referenceTime, timezone: 'America/Bogota' });

    expect(result).toMatchObject({
      valid: true,
      entries: [{
        valid: true,
        toolName: 'manage_reminder',
        params: { action: 'cancel', scope: 'elapsed' },
      }],
    });
  });

  it('preserves a typed day offset when a provider labels it as local time', () => {
    const resolved = resolveTypedSchedule({
      kind: 'local_time', dayOffset: 1, hour: 17, minute: 30,
    }, {
      referenceTime: new Date('2026-09-05T16:00:00.000Z'),
      timezone: 'America/Bogota',
    });

    expect(resolved).toMatchObject({
      valid: true,
      canonical: '2026-09-06T22:30:00.000Z',
      temporalKind: 'relative_day_time',
    });
  });

  it('normalizes a calendar search subject supplied in the typed description field', () => {
    const message = 'Buscá en Calendar la revisión semanal.';
    const result = compileTurnManifest({
      operations: [{
        sequence: 1,
        kind: 'calendar_search',
        sourceQuote: 'revisión semanal',
        description: 'revisión semanal',
      }],
    }, { userMessage: message, referenceTime, timezone: 'America/Bogota' });

    expect(result.entries[0]).toMatchObject({
      valid: true,
      params: { action: 'search_events', query: 'revisión semanal' },
    });
  });

  it('normalizes an exception-bearing entity deletion to collection scope', () => {
    const message = 'Elimina todos mis proyectos excepto Reminder Pro.';
    const result = compileTurnManifest({
      operations: [{
        sequence: 1,
        kind: 'entity_delete',
        sourceQuote: message,
        targetName: 'todos mis proyectos',
        category: 'project',
        preserveNames: ['Reminder Pro'],
      }],
    }, { userMessage: message, referenceTime, timezone: 'America/Bogota' });

    expect(result.entries[0]).toMatchObject({
      valid: true,
      params: {
        action: 'delete',
        category: 'project',
        scope: 'all',
        preserveNames: ['Reminder Pro'],
      },
    });
  });

  it('rejects a bulk deletion that omits the explicit exception list', () => {
    const message = 'Elimina todos mis proyectos excepto Reminder Pro.';
    const result = compileTurnManifest({ operations: [{
      sequence: 1,
      kind: 'entity_delete',
      sourceQuote: message,
      category: 'project',
      scope: 'all',
    }] }, { userMessage: message, referenceTime, timezone: 'America/Bogota' });

    expect(result.entries[0]).toMatchObject({
      valid: false,
      errorCode: 'MISSING_PRESERVE_NAMES',
    });
  });

  it('rejects a bulk deletion that could broaden a category-specific request', () => {
    const message = 'Elimina todos mis proyectos excepto Reminder Pro.';
    const result = compileTurnManifest({ operations: [{
      sequence: 1,
      kind: 'entity_delete',
      sourceQuote: message,
      scope: 'all',
      preserveNames: ['Reminder Pro'],
    }] }, { userMessage: message, referenceTime, timezone: 'America/Bogota' });

    expect(result.entries[0]).toMatchObject({
      valid: false,
      errorCode: 'MISSING_CATEGORY',
    });
    expect(findRepairableManifestIssue({ valid: true }, result)).toMatchObject({
      errorCode: 'MISSING_CATEGORY',
    });
  });

  it('classifies task containers as projects by default', () => {
    const message = 'Agrega preparar demo al proyecto Reunión del trabajo.';
    const result = compileTurnManifest({
      operations: [{
        sequence: 1,
        kind: 'task_create',
        sourceQuote: message,
        title: 'Preparar demo',
        entityName: 'Reunión del trabajo',
      }],
    }, { userMessage: message, referenceTime, timezone: 'America/Bogota' });

    expect(result.entries[0].params.items[0]).toMatchObject({
      title: 'Preparar demo',
      entityName: 'Reunión del trabajo',
      entityCategory: 'project',
    });
  });

  it('keeps explicitly projectless tasks unassigned even if a provider invents a container', () => {
    const message = 'Anota revisar el portafolio como tarea suelta.';
    const result = compileTurnManifest({ operations: [{
      sequence: 1,
      kind: 'task_create',
      sourceQuote: message,
      title: 'Revisar el portafolio',
      projectless: true,
      entityName: 'General',
    }] }, { userMessage: message, referenceTime, timezone: 'America/Bogota' });

    expect(result.entries[0].params).toEqual({
      action: 'create',
      items: [{ title: 'Revisar el portafolio' }],
    });
  });

  it('normalizes a typed agenda day into the read scope expected by the backend', () => {
    const message = '¿Qué tengo mañana entre calendario, recordatorios y tareas?';
    const result = compileTurnManifest({
      operations: [{
        sequence: 1,
        kind: 'agenda_read',
        sourceQuote: message,
        schedule: { kind: 'relative_day_time', dayOffset: 1, hour: 9, minute: 0 },
      }],
    }, { userMessage: message, referenceTime, timezone: 'America/Bogota' });

    expect(result.entries[0]).toMatchObject({
      valid: true,
      toolName: 'get_unified_agenda',
      params: { scope: 'tomorrow' },
    });
  });

  it('resolves calendar mutations from source evidence against unique working-memory events', () => {
    const message = 'Mové la revisión semanal para mañana a las tres. Y el evento Almuerzo con Nico sí borralo.';
    const workingMemory = {
      items: [
        { position: 1, type: 'calendar_event', title: 'Revisión semanal' },
        { position: 2, type: 'calendar_event', title: 'Almuerzo con Nico' },
      ],
    };
    const result = compileTurnManifest({ operations: [
      {
        sequence: 1,
        kind: 'calendar_update',
        sourceQuote: 'Mové la revisión semanal para mañana a las tres',
        schedule: { kind: 'relative_day_time', dayOffset: 1, hour: 15, minute: 0 },
      },
      {
        sequence: 2,
        kind: 'calendar_delete',
        sourceQuote: 'el evento Almuerzo con Nico sí borralo',
      },
    ] }, {
      userMessage: message,
      referenceTime,
      timezone: 'America/Bogota',
      workingMemory,
    });

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toMatchObject({
      valid: true,
      params: { action: 'update_event', target: '1', startDateTime: '2026-09-05T20:00:00.000Z' },
    });
    expect(result.entries[1]).toMatchObject({
      valid: true,
      params: { action: 'delete_event', target: '2' },
    });
  });

  it('uses authenticated current-turn evidence as the semantic memory-forget query', () => {
    const message = 'Olvidá mi preferencia de horario para reuniones.';
    const result = compileTurnManifest({ operations: [{
      sequence: 1,
      kind: 'memory_forget',
      sourceQuote: 'Olvidá mi preferencia de horario para reuniones',
    }] }, { userMessage: message, referenceTime, timezone: 'America/Bogota' });

    expect(result.entries[0]).toMatchObject({
      valid: true,
      toolName: 'manage_memory',
      params: { action: 'forget', query: 'Olvidá mi preferencia de horario para reuniones' },
    });
  });

  it('uses trusted current-turn evidence as durable memory content when the model omits the duplicate field', () => {
    const message = 'Recuerda que Borona es mi mascota.';
    const result = compileTurnManifest({ operations: [{
      sequence: 1,
      kind: 'memory_save',
      sourceQuote: 'Borona es mi mascota',
    }] }, { userMessage: message, referenceTime, timezone: 'America/Bogota' });

    expect(result.entries[0]).toMatchObject({
      valid: true,
      toolName: 'manage_memory',
      params: { action: 'save', content: 'Borona es mi mascota' },
    });
  });

  it('classifies invalid excluded evidence and malformed typed schedules as repairable before execution', () => {
    expect(findRepairableManifestIssue(
      { valid: true },
      { valid: false, errorCode: 'UNTRUSTED_EXCLUDED_QUOTE', error: 'invalid quote' },
    )).toMatchObject({ errorCode: 'UNTRUSTED_EXCLUDED_QUOTE' });

    expect(findRepairableManifestIssue(
      { valid: true },
      { valid: true, entries: [{ valid: false, errorCode: 'MISSING_CLOCK_TIME', error: 'missing time', sequence: 2 }] },
    )).toMatchObject({ errorCode: 'MISSING_CLOCK_TIME', sequence: 2 });

    expect(findRepairableManifestIssue(
      { valid: true },
      { valid: true, entries: [{ valid: false, errorCode: 'INVALID_LOCAL_TIME', error: 'DST gap', sequence: 3 }] },
    )).toBeNull();
  });

  it('uses authenticated current-turn evidence as a task completion target', () => {
    const message = 'Completa la tarea Llevar exposición.';
    const result = compileTurnManifest({ operations: [{
      sequence: 1,
      kind: 'task_complete',
      sourceQuote: 'Completa la tarea Llevar exposición',
    }] }, { userMessage: message, referenceTime, timezone: 'America/Bogota' });

    expect(result.entries[0]).toMatchObject({
      valid: true,
      toolName: 'manage_task',
      params: { action: 'complete', target: 'Completa la tarea Llevar exposición' },
    });
  });

  it('enforces the production operation ceiling in schema validation and compilation', () => {
    const operations = Array.from({ length: TURN_OPERATION_LIMIT + 1 }, (_unused, index) => ({
      sequence: index + 1,
      kind: 'entity_list',
      sourceQuote: 'lista',
    }));
    const manifest = { operations };

    expect(validateToolCall({ toolName: 'execute_turn', params: manifest })).toMatchObject({ valid: false });
    expect(compileTurnManifest(manifest, { userMessage: 'lista' })).toMatchObject({
      valid: false, errorCode: 'TURN_OPERATION_LIMIT',
    });
  });
});

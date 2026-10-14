import { describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '../../../src/agent/contracts/tool-names.js';
import { createExecutionFact, composeExecutionReply } from '../../../src/agent/core/execution-facts.js';
import {
  formatCanonicalReminderCreate,
  formatCanonicalReminderCreateBatch,
} from '../../../src/shared/reminder-presentation.js';

const context = { language: 'es', timezone: 'America/Bogota' };

function createData(content: string, formattedTime: string, recurrenceRule: string | null = null) {
  return [{
    id: `id-${content}`,
    content,
    sendAt: '2026-09-09T12:30:00.000Z',
    formattedTime,
    recurrenceRule,
    recurrence_rule: recurrenceRule,
    isAdvanceNotice: false,
  }];
}

function createFact(data: ReturnType<typeof createData>) {
  return createExecutionFact({
    toolName: TOOL_NAMES.MANAGE_REMINDER,
    params: { action: 'create' },
    result: {
      success: true,
      action: 'created_reminders_batch',
      data,
      rawSummary: 'legacy create card',
    },
    language: 'es',
  });
}

describe('canonical reminder batch presentation', () => {
  it('keeps a single reminder creation compact', () => {
    const card = formatCanonicalReminderCreate(
      createData('Tomar vitaminas', 'Mañana a las 7:30 AM', 'daily'),
      context,
    );

    expect(card).toContain('✅ *Recordatorio programado*');
    expect(card).toContain('🔁 *Tomar vitaminas*');
    expect(card).toContain('🔁 Todos los días');
  });

  it('aggregates several create actions under one header', () => {
    const card = formatCanonicalReminderCreateBatch([
      createData('Tomar vitaminas', 'Mañana a las 7:30 AM', 'daily'),
      createData('Preparar la ropa', 'Hoy a las 9:00 PM', 'daily'),
      createData('Revisar presupuesto', 'Viernes a las 3:00 PM'),
    ], context);

    expect(card).toContain('✅ *3 recordatorios programados*');
    expect(card.match(/recordatorios programados/g)).toHaveLength(1);
    expect(card).toContain('*Tomar vitaminas*');
    expect(card).toContain('*Preparar la ropa*');
    expect(card).toContain('*Revisar presupuesto*');
  });

  it('renders an advance notice as metadata of its primary reminder', () => {
    const card = formatCanonicalReminderCreate([
      {
        id: 'advance-1',
        content: '🔔 [Aviso Previo] En 30 minutos: llamar al veterinario',
        displayContent: 'llamar al veterinario',
        isAdvanceNotice: true,
        formattedTime: 'Mañana a las 9:45 AM',
      },
      {
        id: 'main-1',
        content: 'llamar al veterinario',
        isAdvanceNotice: false,
        formattedTime: 'Mañana a las 10:15 AM',
      },
    ], context);

    expect(card).toContain('✅ *Recordatorio programado*');
    expect(card).toContain('⏰ *llamar al veterinario*');
    expect(card).toContain('🔔 Aviso previo · Mañana a las 9:45 AM');
    expect(card.match(/\*llamar al veterinario\*/g)).toHaveLength(1);
    expect(card).not.toContain('[Aviso Previo]');
  });

  it('composes multiple reminder create facts into one verified card', () => {
    const facts = [
      createFact(createData('Tomar vitaminas', 'Mañana a las 7:30 AM', 'daily')),
      createFact(createData('Preparar la ropa', 'Hoy a las 9:00 PM', 'daily')),
      createFact(createData('Revisar presupuesto', 'Viernes a las 3:00 PM')),
    ];

    const reply = composeExecutionReply(facts, 'es');

    expect(reply).toContain('✅ *3 recordatorios programados*');
    expect(reply.match(/✅/g)).toHaveLength(1);
  });

  it('aggregates several successful cancellations into one card', () => {
    const facts = [
      ['Tomar vitaminas', true],
      ['Preparar la ropa', true],
      ['Revisar presupuesto', false],
    ].map(([content, recurring]) => createExecutionFact({
      toolName: TOOL_NAMES.MANAGE_REMINDER,
      params: { action: 'cancel' },
      result: {
        success: true,
        action: recurring ? 'cancelled_recurring_reminder_series' : 'cancelled_reminder',
        data: { content, recurring, recurrenceRule: recurring ? 'daily' : null, cancelledCount: 1 },
        rawSummary: `Eliminado: ${content}`,
      },
      language: 'es',
    }));

    const reply = composeExecutionReply(facts, 'es');

    expect(reply).toContain('🗑️ *3 recordatorios eliminados*');
    expect(reply).toContain('🔁 *Tomar vitaminas*');
    expect(reply).toContain('🔔 *Revisar presupuesto*');
    expect(reply.match(/recordatorios eliminados/g)).toHaveLength(1);
  });
});

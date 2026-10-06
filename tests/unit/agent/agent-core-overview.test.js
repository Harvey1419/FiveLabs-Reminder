import { describe, expect, it } from 'vitest';
import { buildAgentCorePrompt, formatActiveFollowups, formatCompactOverview, formatReferencedProjectTasks } from '../../../src/agent/core/agent-core.js';
import { EXECUTE_TURN_DESCRIPTION } from '../../../src/agent/contracts/intent-contracts.js';
import { getStructuredTurnSchema } from '../../../src/agent/contracts/foreground-turn-schema.js';

describe('static prompt deduplication', () => {
  // Bounded c6ab77e baseline, measured with these exact synthetic inputs and
  // the full provider schema. Characters/bytes are not token or quality proof.
  it.each([
    { isAdmin: false, baselineChars: 25544, baselineBytes: 25587 },
    { isAdmin: true, baselineChars: 25645, baselineBytes: 25689 },
  ])('reduces serialized prompt + unchanged schema without dropping context (admin=$isAdmin)', ({ isAdmin, baselineChars, baselineBytes }) => {
    const prompt = buildAgentCorePrompt({
      nowStr: '2026-10-01 11:30',
      nowHumanStr: 'jueves, 1 de octubre de 2026, 11:30 a. m.',
      timezone: 'America/Bogota', language: 'es', isAdmin, isPro: isAdmin,
      billingContext: { provider: 'Stripe', subscriptionStatus: isAdmin ? 'active' : 'pending', entitlementKnown: true },
      memoryHints: 'Prefiere respuestas breves.', preferenceHints: 'No ofrecer planes sin solicitud.',
      workingMemoryText: '[Working Memory: referencia, no estado vivo]',
      referencedProjectTasks: '[Tareas vivas: contexto limitado]',
      overview: { openTasks: [{ title: 'Synthetic task' }] },
    });
    const serialized = JSON.stringify({ prompt, schema: getStructuredTurnSchema({ isAdmin }) });
    expect(baselineChars - serialized.length).toBeGreaterThanOrEqual(700);
    expect(baselineChars - serialized.length).toBeLessThanOrEqual(1100);
    expect(baselineBytes - Buffer.byteLength(serialized)).toBeGreaterThanOrEqual(700);
    expect(baselineBytes - Buffer.byteLength(serialized)).toBeLessThanOrEqual(1100);
    // The description is actually consumed by the foreground system prompt,
    // not by its strict response schema. Never remove its unique action rules.
    expect(prompt.split(EXECUTE_TURN_DESCRIPTION)).toHaveLength(2);
    for (const context of [
      'Prefiere respuestas breves.', 'No ofrecer planes sin solicitud.',
      '[Working Memory: referencia, no estado vivo]', '[Tareas vivas: contexto limitado]',
      'Tareas abiertas sin fecha: 1', 'fechas de compromisos históricos: evidencia canónica, no el año del reloj',
      'Runtime renders subscription.info even with reply', 'Social replies get no billing card',
      'future-day reminder scheduling and recurring reminders', 'keep prose persuasive',
      'For existing Pro access acknowledge access and benefits, never suggest another payment',
      'If access is UNKNOWN do not assert Free or Pro',
      'No fixed card, invented features, unlimited usage, prices, trials or app instructions',
      'plan information never charges or creates a subscription',
    ]) expect(prompt).toContain(context);
    expect(prompt.includes('Métricas administrativas')).toBe(isAdmin);
  });

  it('preserves caller-supplied Free guidance and unknown entitlement without inferring a plan', () => {
    const proGuidance = '- Cumple primero la solicitud.\n- No agregues publicidad a saludos u operaciones rutinarias.';
    const prompt = buildAgentCorePrompt({
      nowStr: '2026-10-01 11:30', timezone: 'America/Bogota',
      proGuidance, isPro: true, billingContext: { entitlementKnown: false },
    });
    expect(prompt).toContain(proGuidance);
    expect(prompt).toContain('Plan: UNKNOWN');
    expect(prompt).toContain('Canonical Pro access: UNKNOWN');
    expect(prompt).toContain('Checkout confirmation: UNKNOWN');
    expect(prompt).toContain('Charge outcome: UNKNOWN');
    expect(prompt).toContain('Payment outcome: UNKNOWN');
  });
});

describe('agent live overview', () => {
  it('exposes counts for orientation but never item content', () => {
    const text = formatCompactOverview({
      pendingConfirmationReminders: [{ content: 'Recordatorio antiguo sensible' }],
      timedRemindersToday: [{ content: 'Comprar leche', localTime: '9:00 a. m.' }],
      tasksDueToday: [{ title: 'Pagar factura' }],
      openTasks: [{ title: 'Tarea sin fecha' }],
      openTasksByEntity: { Reminder: [{ title: 'Mejorar memoria' }] },
    });

    expect(text).toContain('Avisos de seguimiento activos: 1');
    expect(text).toContain('Recordatorios programados hoy: 1');
    expect(text).toContain('Tareas con vencimiento hoy: 1');
    expect(text).not.toContain('Recordatorio antiguo sensible');
    expect(text).not.toContain('Comprar leche');
    expect(text).not.toContain('Pagar factura');
    expect(text).not.toContain('Tarea sin fecha');
    expect(text).not.toContain('Mejorar memoria');
  });

  it('exposes only active confirmation reminders as authoritative interaction context', () => {
    const text = formatActiveFollowups({
      pendingConfirmationReminders: [
        { id: 'internal-id-never-exposed', content: 'cita', localFormatted: 'Hoy a las 4:00 PM', nudgeCount: 1 },
      ],
      timedRemindersToday: [{ content: 'Comprar leche' }],
    });

    expect(text).toContain('Seguimientos activos');
    expect(text).toContain('cita');
    expect(text).toContain('Hoy a las 4:00 PM');
    expect(text).toContain('avisos_enviados=1');
    expect(text).not.toContain('internal-id-never-exposed');
    expect(text).not.toContain('Comprar leche');
  });

  it('returns no follow-up context when nothing awaits confirmation', () => {
    expect(formatActiveFollowups({ pendingConfirmationReminders: [] })).toBe('');
  });


  it('anchors Hermes identity to Temple Labs and keeps casual conversation open', () => {
    const text = buildAgentCorePrompt({
      nowStr: '2026-09-27 22:54',
      nowHumanStr: 'domingo, 27 de septiembre de 2026, 10:54 p. m.',
      timezone: 'America/Bogota',
      memoryHints: '',
      overview: null,
      isPro: true,
    });

    expect(text).toContain('creado por Temple Labs');
    expect(text).toContain('Hermes, nunca el proveedor del modelo');
    expect(text).toContain('Conversa con naturalidad y empatía');
    expect(text).toContain('Saluda cuando corresponda');
    expect(text).toContain('no repitas ofertas de ayuda mecánicamente');
  });

  it('formats referenced project tasks when user message targets a known entity', () => {
    const overview = {
      pendingTasksByEntity: {
        Apartamento: [
          { title: 'devolver 465.000 pesos', localFormatted: 'Mañana a las 12:00 PM' },
          { title: 'comprar escritorio' },
        ],
        Trabajo: [
          { title: 'enviar reporte' },
        ],
      },
    };

    const formatted = formatReferencedProjectTasks(overview, 'Oye, ¿cuánto debo del apartamento?');
    expect(formatted).toContain('[Tareas vivas del proyecto/entidad: Apartamento]');
    expect(formatted).toContain('• devolver 465.000 pesos [Mañana a las 12:00 PM]');
    expect(formatted).toContain('• comprar escritorio');
    expect(formatted).not.toContain('Trabajo');
    expect(formatted).not.toContain('enviar reporte');
  });

  it('states when the live task context is truncated instead of implying a complete total', () => {
    const overview = {
      pendingTasksByEntity: {
        Apartment: Array.from({ length: 12 }, (_, index) => ({ title: `Task ${index + 1}`, status: 'pending' })),
      },
    };

    const formatted = formatReferencedProjectTasks(overview, 'List the tasks for Apartment', 'en');

    expect(formatted).toContain('Showing 10 of 12 open tasks');
    expect(formatted).toContain('Task 10');
    expect(formatted).not.toContain('Task 11');
  });

  it('provides project references while requiring authoritative reads for totals', () => {
    const overview = {
      pendingTasksByEntity: {
        Apartamento: [
          { title: 'devolver 465.000 pesos', localFormatted: 'Mañana a las 12:00 PM' },
        ],
      },
    };

    const promptWithProject = buildAgentCorePrompt({
      nowStr: '2026-09-29 16:30',
      nowHumanStr: 'martes, 29 de septiembre de 2026, 4:30 p. m.',
      timezone: 'America/Bogota',
      overview,
      userMessage: 'cuánto debo del apartamento',
    });

    expect(promptWithProject).toContain('[Tareas vivas del proyecto/entidad: Apartamento]');
    expect(promptWithProject).toContain('• devolver 465.000 pesos [Mañana a las 12:00 PM]');
    expect(promptWithProject).toContain('Estado/deuda/saldo: task.list(entityName)');

    const promptWithoutProject = buildAgentCorePrompt({
      nowStr: '2026-09-29 16:30',
      nowHumanStr: 'martes, 29 de septiembre de 2026, 4:30 p. m.',
      timezone: 'America/Bogota',
      overview,
      userMessage: 'hola cómo estás hoy',
    });

    expect(promptWithoutProject).not.toContain('[Tareas vivas del proyecto/entidad: Apartamento]');
  });

  it('enforces English prompt directives when user language is English', () => {
    const prompt = buildAgentCorePrompt({
      nowStr: '2026-10-01 11:30',
      nowHumanStr: 'jueves, 1 de octubre de 2026, 11:30 a. m.',
      timezone: 'America/New_York',
      language: 'en',
    });

    expect(prompt).toContain('Stored language fallback: en');
    expect(prompt).toContain("CURRENT USER's language");
    expect(prompt).toContain('no repitas ofertas de ayuda mecánicamente');
    expect(prompt).toContain('usa perfil/memoria verificados');
    expect(prompt).not.toContain('Harvey');
  });

  it('does not equate unavailable memory retrieval with no stored memories', () => {
    const prompt = buildAgentCorePrompt({
      nowStr: '2026-10-01 11:30',
      nowHumanStr: 'jueves, 1 de octubre de 2026, 11:30 a. m.',
      timezone: 'America/Bogota',
      memoryRetrievalStatus: 'unavailable',
    });

    expect(prompt).toContain('Memory retrieval is temporarily unavailable');
    expect(prompt).toContain('Do not claim that no memories or standing preferences exist');
    expect(prompt).not.toContain('(Ninguna memoria relevante para este turno)');
  });

  it('defaults to Spanish prompt directives when user language is Spanish', () => {
    const prompt = buildAgentCorePrompt({
      nowStr: '2026-10-01 11:30',
      nowHumanStr: 'jueves, 1 de octubre de 2026, 11:30 a. m.',
      timezone: 'America/Bogota',
      language: 'es',
    });

    expect(prompt).toContain('Stored language fallback: es');
    expect(prompt).toContain("CURRENT USER's language");
    expect(prompt).toContain('neutral Colombian Spanish with tuteo');
    expect(prompt).toContain('si falta el nombre, pregunta');
    expect(prompt).not.toContain('Harvey');
  });
});

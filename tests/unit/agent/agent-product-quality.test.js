import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAgentCorePrompt, formatCompactOverview } from '../../../src/agent/core/agent-core.js';
import { composeExecutionReply, createExecutionFact } from '../../../src/agent/core/execution-facts.js';
import { getIntentToolDefinitions, normalizeIntentAction, validateTurnIntent } from '../../../src/agent/contracts/intent-contracts.js';
import { clearWorkingMemory, formatWorkingMemoryPrompt, saveWorkingMemory } from '../../../src/agent/core/working-memory.js';

vi.mock('../../../src/integrations/google/auth.js', () => ({
  hasUsableGoogleCredentials: vi.fn(() => false),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearWorkingMemory('573001112233');
});

describe('Hermes product-quality core', () => {
  it('exposes one small semantic execution boundary instead of domain CRUD tools', () => {
    const tools = getIntentToolDefinitions({ isAdmin: false });
    expect(tools).toHaveLength(1);
    expect(tools[0].function.name).toBe('execute_turn');

    const action = tools[0].function.parameters.properties.actions.items.properties;
    expect(action).toHaveProperty('domain');
    expect(action).toHaveProperty('action');
    expect(action).toHaveProperty('target');
    expect(action).not.toHaveProperty('kind');
    expect(action).not.toHaveProperty('sequence');
    expect(action).not.toHaveProperty('sourceQuote');
    expect(action).not.toHaveProperty('contextRef');
  });

  it('normalizes harmless semantic verb variation at the Node boundary', () => {
    expect(normalizeIntentAction('memory', 'add')).toBe('save');
    expect(normalizeIntentAction('memory', 'recall')).toBe('search');
    expect(normalizeIntentAction('task', 'done')).toBe('complete');

    const result = validateTurnIntent({
      actions: [{ domain: 'memory', action: 'store', content: 'Trabajo en Globant' }],
    });
    expect(result.valid).toBe(true);
    expect(result.intent.actions[0].action).toBe('save');
  });

  it('keeps live overview as counts only so it cannot answer inventory queries from stale prompt state', () => {
    const overview = formatCompactOverview({
      pendingConfirmationReminders: [{ content: 'No debe filtrarse' }],
      timedRemindersToday: [{ content: 'Tampoco esto' }],
      tasksDueToday: [{ title: 'Ni esta tarea' }],
      openTasks: [{ title: 'Sin fecha' }],
      openTasksByEntity: { Reminder: [{ title: 'Privado' }] },
    });

    expect(overview).toContain('Avisos de seguimiento activos: 1');
    expect(overview).toContain('Tareas abiertas sin fecha: 1');
    expect(overview).not.toContain('No debe filtrarse');
    expect(overview).not.toContain('Ni esta tarea');
    expect(overview).not.toContain('Privado');
  });

  it('instructs Hermes to use authoritative reads for agenda inventory and direct recall for known personal facts', () => {
    const prompt = buildAgentCorePrompt({
      nowStr: '2026-09-07T10:00:00-05:00',
      nowHumanStr: 'lunes, 7 de septiembre, 10:00 a. m.',
      timezone: 'America/Bogota',
      memoryHints: '- [fact] Vives en Barranquilla',
      overview: { openTasks: [{ title: 'oculta' }] },
      workingMemoryText: '',
      googleIntegration: null,
      isAdmin: false,
      isPro: true,
      displayName: 'Juan',
    });

    expect(prompt).toContain('pregunta que pida inventario vivo');
    expect(prompt).toContain('requiere una lectura de agenda');
    expect(prompt).toContain('Si un dato personal ya aparece');
    expect(prompt).not.toContain('sourceQuote');
    expect(prompt).not.toContain('manifest');
  });

  it('keeps backend cards intact without a repetitive ticket-style closing', () => {
    const result = {
      success: true,
      complete: true,
      action: 'created_reminder',
      formattedCard: '✅ *Recordatorio programado*\n\n⏰ *Comprar leche*\n📅 Hoy 4:00 p. m.',
      confirmation: '✅ *Recordatorio programado*\n\n⏰ *Comprar leche*\n📅 Hoy 4:00 p. m.',
    };
    const fact = createExecutionFact({
      toolName: 'manage_reminder', params: { action: 'create' }, result, language: 'es',
    });
    const reply = composeExecutionReply([fact], 'es');

    expect(reply).toBe(result.formattedCard);
    expect(reply).not.toContain('¿Algo más en lo que pueda ayudarte?');
  });

  it('keeps Working Memory as conversational references rather than model-owned IDs', () => {
    saveWorkingMemory('573001112233', {
      source: 'unified',
      scope: 'all_pending',
      entityType: 'all',
      items: [
        { position: 1, type: 'task', internalId: 'internal-uuid-1', summary: 'Comprar comida' },
        { position: 2, type: 'reminder', internalId: 'internal-uuid-2', summary: 'Llamar a Pedro' },
      ],
    });

    const text = formatWorkingMemoryPrompt('573001112233');
    expect(text).toContain('Comprar comida');
    expect(text).toContain('Llamar a Pedro');
    expect(text).not.toContain('internal-uuid-1');
    expect(text).not.toContain('internal-uuid-2');
  });
});

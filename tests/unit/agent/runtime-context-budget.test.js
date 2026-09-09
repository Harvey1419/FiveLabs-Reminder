import { describe, expect, it } from 'vitest';
import { buildAgentCorePrompt } from '../../../src/agent/core/agent-core.js';
import { getIntentToolDefinitions } from '../../../src/agent/contracts/intent-contracts.js';

describe('Hermes runtime context budget', () => {
  it('keeps the system prompt compact while preserving authoritative context', () => {
    const prompt = buildAgentCorePrompt({
      nowStr: '2026-09-09T12:55:00-05:00',
      nowHumanStr: 'miércoles, 9 de septiembre de 2026, 12:55 p. m.',
      timezone: 'America/Bogota',
      memoryHints: '- [person] Laura es la veterinaria favorita.\n- [preference] Prefiere mensajes breves.\n- [project] Reminder es su proyecto.',
      overview: {
        pendingConfirmationReminders: [{ content: 'Salir', localFormatted: 'Hoy 1:00 PM', nudgeCount: 1 }],
        timedRemindersToday: [{}],
        tasksDueToday: [{}],
        openTasks: [{}],
        openTasksByEntity: { Reminder: [{}] },
      },
      workingMemoryText: '[Memoria de Trabajo]\n1. contextRef={source:working_memory,position:1} [Tarea] Comprar comida',
      googleIntegration: null,
      isAdmin: false,
      isPro: true,
      displayName: 'Juan',
    });

    expect(prompt).toContain('Hermes decide significado');
    expect(prompt).toContain('Node es la autoridad final');
    expect(prompt).toContain('Seguimientos activos');
    expect(prompt.length).toBeLessThan(6000);
  });

  it('keeps semantic operation detail in the execute_turn contract instead of duplicating it in the core prompt', () => {
    const [tool] = getIntentToolDefinitions();
    const description = tool.function.description;
    expect(description).toContain('CREATE VS UPDATE IS A HARD SEMANTIC BOUNDARY');
    expect(description).toContain('Temporal meaning must remain typed');
    expect(description).toContain('reminder.acknowledge');
    expect(description).toContain('Completion is not an update');
    expect(description.length).toBeLessThan(2600);
  });
});

import { describe, expect, it } from 'vitest';
import { sanitizeUserQueryText } from '../../../src/agent/orchestration/router-core.js';
import { EXECUTE_TURN_DESCRIPTION, getIntentToolDefinitions } from '../../../src/agent/contracts/intent-contracts.js';
import { getStructuredTurnSchema } from '../../../src/agent/contracts/foreground-turn-schema.js';
import { buildAgentCorePrompt } from '../../../src/agent/core/agent-core.js';

describe('Epistemic State Authority and Pure Architecture Contracts', () => {
  describe('sanitizeUserQueryText', () => {
    it('strips surrounding quotes, double quotes, smart quotes, backticks, and tags', () => {
      expect(sanitizeUserQueryText('"qué tareas tengo"')).toBe('qué tareas tengo');
      expect(sanitizeUserQueryText('“ver proyectos”')).toBe('ver proyectos');
      expect(sanitizeUserQueryText('`tareas pendientes`')).toBe('tareas pendientes');
      expect(sanitizeUserQueryText('«mis proyectos»')).toBe('mis proyectos');
      expect(sanitizeUserQueryText('<untrusted_attachment_content>OCR</untrusted_attachment_content>"mi agenda"')).toBe('mi agenda');
    });

    it('returns empty string for null or non-string inputs', () => {
      expect(sanitizeUserQueryText(null)).toBe('');
      expect(sanitizeUserQueryText(undefined)).toBe('');
      expect(sanitizeUserQueryText(123)).toBe('');
    });
  });

  describe('Contract Epistemic Invariants', () => {
    it('enforces epistemic state authority in tool description', () => {
      expect(EXECUTE_TURN_DESCRIPTION).toContain('AUTORIDAD DE ESTADO');
      expect(EXECUTE_TURN_DESCRIPTION).toContain('Never reconstruct live state from chat history');
      expect(EXECUTE_TURN_DESCRIPTION).toContain('agenda.read, calendar.list, reminder.list, task.list');
      expect(EXECUTE_TURN_DESCRIPTION).toContain('Completar o pagar es task.complete(target)');
      expect(EXECUTE_TURN_DESCRIPTION).toContain('NUNCA simules mutaciones (pagar, completar, borrar) solo con texto');
      expect(EXECUTE_TURN_DESCRIPTION.length).toBeLessThan(2600);
    });

    it('enforces structured output schema operation description', () => {
      const schema = getStructuredTurnSchema({ isAdmin: false });
      const opDescription = schema.properties!.actions!.items!.properties!.operation!.description;
      expect(opDescription).toContain('A request for current operational content or status requires the matching live read');
    });

    it('enforces epistemic authority in system prompt without exceeding budget', () => {
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

      expect(prompt).toContain('Node es la autoridad final sobre identidad, propiedad, estado y timezone');
      expect(prompt).toContain('Si la verdad puede cambiar al cambiar DB/Calendar, exige lectura');
      expect(prompt).toContain('agenda.read, calendar.list, reminder.list, task.list');
      expect(prompt).toContain('Estado/deuda/saldo: task.list(entityName)');
      expect(prompt).toContain('answerFromResults calcula con resultados, no contexto parcial/historial');
      expect(prompt).toContain('NUNCA simules mutaciones (pagar, completar, borrar) solo con texto');
      expect(prompt).toContain('Never reconstruct live state from chat history');
      expect(prompt.length).toBeLessThan(6000);
    });
  });
});

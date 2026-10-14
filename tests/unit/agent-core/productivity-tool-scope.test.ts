import { describe, expect, it } from 'vitest';
import { initialProductivityTools } from '../../../src/adapters/agent-core/productivity-tool-scope.js';
describe('authored-text schema prefetch', () => {
  it.each([
    ['Oye, ¿qué recordatorios tengo para hoy?', ['reminder_read']],
    ['Show my reminders', ['reminder_read']],
    ['Lista mis tareas', ['task_read']],
    ['Muestra mi calendario', ['calendar_read']],
    ['Lista mis tareas y recordatorios', ['reminder_read', 'task_read']],
    ['Lista mis tareas y recordatorios y eventos', ['reminder_read', 'task_read']],
    ['Lista recordatorios y crea una tarea', ['task_create', 'reminder_create']],
    ['Recuérdame que tengo que salir en diez minutos', ['task_create', 'reminder_create']],
    ['Buenos días', ['task_create', 'reminder_create']],
  ])('prefetches only bounded schema hints for %s', (text, tools) => {
    expect(initialProductivityTools(String(text))).toEqual(tools);
  });
});

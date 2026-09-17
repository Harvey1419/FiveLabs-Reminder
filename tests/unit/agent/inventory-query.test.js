import { describe, expect, it } from 'vitest';
import { sanitizeUserQueryText, detectInventoryQuery } from '../../../src/agent/orchestration/inventory-query.js';

describe('inventory query interceptor', () => {
  describe('sanitizeUserQueryText', () => {
    it('strips leading and trailing quotes, double quotes, smart quotes, and backticks', () => {
      expect(sanitizeUserQueryText('"qué tareas tengo en reminder')).toBe('qué tareas tengo en reminder');
      expect(sanitizeUserQueryText('"qué tareas tengo en reminder"')).toBe('qué tareas tengo en reminder');
      expect(sanitizeUserQueryText('“ver proyectos”')).toBe('ver proyectos');
      expect(sanitizeUserQueryText('`tareas pendientes`')).toBe('tareas pendientes');
      expect(sanitizeUserQueryText('«mis proyectos»')).toBe('mis proyectos');
    });

    it('handles untrusted attachment content tags cleanly', () => {
      const input = '<untrusted_attachment_content>some OCR</untrusted_attachment_content>"qué tareas tengo"';
      expect(sanitizeUserQueryText(input)).toBe('qué tareas tengo');
    });
  });

  describe('detectInventoryQuery', () => {
    it('detects project list queries', () => {
      expect(detectInventoryQuery('proyectos')).toEqual({ domain: 'project', action: 'list' });
      expect(detectInventoryQuery('mis proyectos')).toEqual({ domain: 'project', action: 'list' });
      expect(detectInventoryQuery('ver proyectos')).toEqual({ domain: 'project', action: 'list' });
      expect(detectInventoryQuery('qué proyectos tengo?')).toEqual({ domain: 'project', action: 'list' });
      expect(detectInventoryQuery('cuáles son mis proyectos')).toEqual({ domain: 'project', action: 'list' });
      expect(detectInventoryQuery('list projects')).toEqual({ domain: 'project', action: 'list' });
    });

    it('detects scoped task queries with entityName', () => {
      expect(detectInventoryQuery('"qué tareas tengo en reminder')).toEqual({
        domain: 'task',
        action: 'list',
        entityName: 'reminder',
        scope: 'all_pending',
      });
      expect(detectInventoryQuery('tareas de Reforma baño')).toEqual({
        domain: 'task',
        action: 'list',
        entityName: 'Reforma baño',
        scope: 'all_pending',
      });
      expect(detectInventoryQuery('ver tareas del proyecto Yax')).toEqual({
        domain: 'task',
        action: 'list',
        entityName: 'Yax',
        scope: 'all_pending',
      });
      expect(detectInventoryQuery('ver tareas de la 1')).toEqual({
        domain: 'task',
        action: 'list',
        entityName: 'la 1',
        scope: 'all_pending',
      });
    });

    it('maps temporal expressions to scope instead of entityName', () => {
      expect(detectInventoryQuery('tareas de hoy')).toEqual({
        domain: 'task',
        action: 'list',
        scope: 'today',
      });
      expect(detectInventoryQuery('tareas de mañana')).toEqual({
        domain: 'task',
        action: 'list',
        scope: 'tomorrow',
      });
    });

    it('detects general task list queries', () => {
      expect(detectInventoryQuery('qué tareas tengo?')).toEqual({
        domain: 'task',
        action: 'list',
        scope: 'all_pending',
      });
      expect(detectInventoryQuery('cuáles son mis tareas pendientes')).toEqual({
        domain: 'task',
        action: 'list',
        scope: 'all_pending',
      });
      expect(detectInventoryQuery('mis tareas')).toEqual({
        domain: 'task',
        action: 'list',
        scope: 'all_pending',
      });
      expect(detectInventoryQuery('qué tengo pendiente')).toEqual({
        domain: 'task',
        action: 'list',
        scope: 'all_pending',
      });
      expect(detectInventoryQuery('show pending tasks')).toEqual({
        domain: 'task',
        action: 'list',
        scope: 'all_pending',
      });
    });

    it('detects completed task queries (wrap-up)', () => {
      expect(detectInventoryQuery('qué completé hoy?')).toEqual({
        domain: 'task',
        action: 'list',
        status: 'completed',
        scope: 'today',
      });
      expect(detectInventoryQuery('qué tareas completé hoy')).toEqual({
        domain: 'task',
        action: 'list',
        status: 'completed',
        scope: 'today',
      });
      expect(detectInventoryQuery('qué hice hoy?')).toEqual({
        domain: 'task',
        action: 'list',
        status: 'completed',
        scope: 'today',
      });
      expect(detectInventoryQuery('tareas completadas hoy')).toEqual({
        domain: 'task',
        action: 'list',
        status: 'completed',
        scope: 'today',
      });
      expect(detectInventoryQuery('what did I complete today?')).toEqual({
        domain: 'task',
        action: 'list',
        status: 'completed',
        scope: 'today',
      });
    });

    it('detects unified agenda queries with correct temporal scopes', () => {
      expect(detectInventoryQuery('Que tengo para mañana ?')).toEqual({
        domain: 'agenda',
        action: 'read',
        scope: 'tomorrow',
      });
      expect(detectInventoryQuery('que tengo mañana')).toEqual({
        domain: 'agenda',
        action: 'read',
        scope: 'tomorrow',
      });
      expect(detectInventoryQuery('qué tengo hoy')).toEqual({
        domain: 'agenda',
        action: 'read',
        scope: 'today',
      });
      expect(detectInventoryQuery('qué tengo para hoy?')).toEqual({
        domain: 'agenda',
        action: 'read',
        scope: 'today',
      });
      expect(detectInventoryQuery('cuál es mi agenda?')).toEqual({
        domain: 'agenda',
        action: 'read',
        scope: 'all_pending',
      });
      expect(detectInventoryQuery('mi agenda')).toEqual({
        domain: 'agenda',
        action: 'read',
        scope: 'all_pending',
      });
      expect(detectInventoryQuery('agenda de mañana')).toEqual({
        domain: 'agenda',
        action: 'read',
        scope: 'tomorrow',
      });
      expect(detectInventoryQuery('qué hay mañana?')).toEqual({
        domain: 'agenda',
        action: 'read',
        scope: 'tomorrow',
      });
      expect(detectInventoryQuery('what do I have tomorrow?')).toEqual({
        domain: 'agenda',
        action: 'read',
        scope: 'tomorrow',
      });
      expect(detectInventoryQuery('show my agenda')).toEqual({
        domain: 'agenda',
        action: 'read',
        scope: 'all_pending',
      });
    });

    it('strips conversational prefixes and detects underlying inventory query', () => {
      expect(detectInventoryQuery('Súper, qué tengo para mañana ?')).toEqual({
        domain: 'agenda',
        action: 'read',
        scope: 'tomorrow',
      });
      expect(detectInventoryQuery('Oye, qué tengo hoy ?')).toEqual({
        domain: 'agenda',
        action: 'read',
        scope: 'today',
      });
      expect(detectInventoryQuery('Porfa dime que tengo hoy')).toEqual({
        domain: 'agenda',
        action: 'read',
        scope: 'today',
      });
      expect(detectInventoryQuery('Hermes, cuál es mi agenda?')).toEqual({
        domain: 'agenda',
        action: 'read',
        scope: 'all_pending',
      });
      expect(detectInventoryQuery('Genial, ver proyectos')).toEqual({
        domain: 'project',
        action: 'list',
      });
    });

    it('detects calendar-specific queries', () => {
      expect(detectInventoryQuery('qué reuniones tengo mañana?')).toEqual({
        domain: 'calendar',
        action: 'list',
        scope: 'tomorrow',
      });
      expect(detectInventoryQuery('Revisa mi calendario para mañana')).toEqual({
        domain: 'calendar',
        action: 'list',
        scope: 'tomorrow',
      });
      expect(detectInventoryQuery('qué eventos tengo hoy?')).toEqual({
        domain: 'calendar',
        action: 'list',
        scope: 'today',
      });
      expect(detectInventoryQuery('mis reuniones')).toEqual({
        domain: 'calendar',
        action: 'list',
        scope: 'all_pending',
      });
      expect(detectInventoryQuery('mi calendario')).toEqual({
        domain: 'calendar',
        action: 'list',
        scope: 'all_pending',
      });
      expect(detectInventoryQuery('check my calendar for tomorrow')).toEqual({
        domain: 'calendar',
        action: 'list',
        scope: 'tomorrow',
      });
    });

    it('detects reminder-specific queries', () => {
      expect(detectInventoryQuery('qué recordatorios tengo para mañana?')).toEqual({
        domain: 'reminder',
        action: 'list',
        scope: 'tomorrow',
      });
      expect(detectInventoryQuery('revisa mis recordatorios')).toEqual({
        domain: 'reminder',
        action: 'list',
        scope: 'all_pending',
      });
      expect(detectInventoryQuery('mis recordatorios de hoy')).toEqual({
        domain: 'reminder',
        action: 'list',
        scope: 'today',
      });
      expect(detectInventoryQuery('show my reminders')).toEqual({
        domain: 'reminder',
        action: 'list',
        scope: 'all_pending',
      });
    });

    it('returns null for conversational or mutation messages', () => {
      expect(detectInventoryQuery('hola, cómo estás?')).toBeNull();
      expect(detectInventoryQuery('crea una tarea comprar leche')).toBeNull();
      expect(detectInventoryQuery('elimina el proyecto reminder')).toBeNull();
      expect(detectInventoryQuery('completa la tarea 1')).toBeNull();
    });
  });
});

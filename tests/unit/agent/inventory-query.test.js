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

    it('returns null for conversational or mutation messages', () => {
      expect(detectInventoryQuery('hola, cómo estás?')).toBeNull();
      expect(detectInventoryQuery('crea una tarea comprar leche')).toBeNull();
      expect(detectInventoryQuery('elimina el proyecto reminder')).toBeNull();
      expect(detectInventoryQuery('completa la tarea 1')).toBeNull();
    });
  });
});

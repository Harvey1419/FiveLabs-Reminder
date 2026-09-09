import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { normalizeTurnIntentForRuntime } from '../../../src/agent/orchestration/intent-normalizer.js';
import { executeTurnIntent } from '../../../src/agent/orchestration/intent-executor.js';
import { createExecutionFact } from '../../../src/agent/core/execution-facts.js';
import { TOOL_NAMES } from '../../../src/agent/contracts/tool-names.js';
import { normalizeAgendaScope, normalizeTaskScope, parseTaskScope } from '../../../src/shared/agenda-scopes.js';
import { getMemoryEligibleText } from '../../../src/features/memory/service.js';

const context = {
  user: { id: 'u1', timezone: 'America/Bogota', locale: 'es-CO' },
  referenceTime: new Date('2026-09-07T15:00:00.000Z'),
  timezone: 'America/Bogota',
};

describe('architecture hardening', () => {
  it('loads the canonical intent executor boundary', () => {
    expect(typeof executeTurnIntent).toBe('function');
  });

  it('keeps a single semantic boundary before deterministic domain tools', () => {
    const providerSource = readFileSync(new URL('../../../src/agent/providers/client.js', import.meta.url), 'utf8');
    const executorSource = readFileSync(new URL('../../../src/agent/orchestration/intent-executor.js', import.meta.url), 'utf8');
    const toolsSource = readFileSync(new URL('../../../src/agent/tools/index.js', import.meta.url), 'utf8');

    expect(providerSource).not.toContain('callPendingTransitionVerification');
    expect(providerSource).not.toContain('verify_pending_transition');
    expect(executorSource).not.toContain('userMessage: context.userMessage');
    expect(toolsSource).not.toContain('userMessage');
  });

  it('normalizes collection scopes from one vocabulary', () => {
    expect(normalizeAgendaScope('pendientes')).toBe('all_pending');
    expect(normalizeTaskScope('todos')).toBe('all_pending');
    expect(parseTaskScope('explicit_date@2026-09-09')).toEqual({
      scope: 'explicit_date', date: '2026-09-09', runtimeScope: 'explicit_date@2026-09-09',
    });
  });

  it('turns task schedule meaning into a deterministic task read scope', () => {
    const normalized = normalizeTurnIntentForRuntime({
      actions: [{ domain: 'task', action: 'list', schedule: { kind: 'relative_day_time', dayOffset: 1 } }],
    }, context);
    expect(normalized.actions[0].scope).toBe('tomorrow');
  });

  it('never turns a calendar identity reference into event content', () => {
    const normalized = normalizeTurnIntentForRuntime({
      actions: [{ domain: 'calendar', action: 'update', target: 'la segunda' }],
    }, context);
    expect(normalized.actions[0].title).toBeUndefined();
    expect(normalized.actions[0].content).toBeUndefined();
    expect(normalized.actions[0].schedule).toEqual({ kind: 'inherit_context' });
  });

  it('uses result presentation context instead of silently assuming Bogota', () => {
    const fact = createExecutionFact({
      toolName: TOOL_NAMES.MANAGE_TASK,
      params: { action: 'list' },
      language: 'es',
      result: {
        success: true,
        action: 'listed_tasks',
        data: {
          timezone: 'Europe/Madrid', locale: 'es-ES',
          tasks: [{ title: 'Reunión', due_date: '2026-09-09T10:00:00.000Z', entities: { name: 'Trabajo' } }],
        },
      },
    });
    expect(fact.card).toContain('📁 *Trabajo*');
    expect(fact.card).toContain('Reunión');
  });

  it('keeps durable residual text from mixed operational turns eligible for memory', () => {
    const eligible = getMemoryEligibleText(
      'Recuérdame llamar a Pedro mañana. Trabajo en Globant.',
      [{ tool: 'manage_reminder', card: '✅ Recordatorio programado: llamar a Pedro mañana', summary: 'llamar a Pedro mañana' }],
    );
    expect(eligible).toContain('Trabajo en Globant');
    expect(eligible).not.toContain('Recuérdame llamar a Pedro');
  });
});

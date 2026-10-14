import { describe, expect, it, vi } from 'vitest';
import { createIntentNormalizer } from '../../../src/agent/orchestration/runtime-intent-normalizer.js';
import type { RuntimeNormalizationDependencies } from '../../../src/agent/orchestration/runtime-intent-normalizer.js';
import { resolveContextReference, parseStructuredOrdinal } from '../../../src/agent/core/context-reference-resolver.js';
import type { ContextMemory } from '../../../src/agent/core/context-reference-resolver.js';
function fixture(memory: ContextMemory | null = null, overrides: Partial<RuntimeNormalizationDependencies> = {}) {
  const deps: RuntimeNormalizationDependencies = {
    getWorkingMemory: () => memory,
    resolveContextReference: options => resolveContextReference({ ...options, preferredType: options.preferredType ?? null, workingMemory: options.workingMemory ?? null }),
    parseStructuredOrdinal,
    getLocalDateParts: () => ({ year: 2027, month: 1, day: 1 }),
    shiftZonedCalendarDays: () => new Date('2027-01-04T12:00:00Z'),
    resolveTypedSchedule: () => ({ valid: true, date: new Date('2027-01-01T08:00:00Z') }),
    normalizeAgendaScope: (scope, fallback) => typeof scope === 'string' ? scope : fallback,
    normalizeTaskScope: (scope, fallback) => typeof scope === 'string' ? scope : fallback,
    buildExplicitTaskDateScope: date => date ? `explicit_date@${date}` : null,
    buildExplicitReminderDateScope: date => `explicit_date@${date}`,
    parseReminderScope: scope => ({ scope: String(scope), runtimeScope: String(scope) }),
    sanitizeCalendarQueryAndScope: () => ({ query: null, scope: 'tomorrow' }),
    ...overrides,
  };
  return { ...createIntentNormalizer(deps), deps };
}
const context = { user: { id: 'owned-host' }, timezone: 'America/Bogota', referenceTime: new Date('2027-01-01T15:00:00Z') };
describe('typed runtime intent normalization', () => {
  it('binds contextual identity while preserving a pure description delta and original action', () => {
    const original = { domain: 'calendar', action: 'update', description: 'Llevar avances', contextRef: { source: 'working_memory', position: 1 } };
    const { normalizeTurnActionForRuntime } = fixture({ items: [{ position: 1, type: 'calendar_event', internalId: 'event-id', title: 'Old title', raw: { start: 'old time' } }] });
    expect(normalizeTurnActionForRuntime(original, context)).toEqual({ domain: 'calendar', action: 'update', description: 'Llevar avances', target: 'event-id' });
    expect(original).toHaveProperty('contextRef');
  });
  it('flags deleted or incompatible contextual items without supplying an executable target', () => {
    for (const state of [{ type: 'task', status: 'pending' }, { type: 'calendar_event', status: 'deleted' }]) {
      const { normalizeTurnActionForRuntime } = fixture({ items: [{ position: 1, type: state.type, internalId: 'old-id', raw: { status: state.status } }] });
      const result = normalizeTurnActionForRuntime({ domain: 'calendar', action: 'delete', contextRef: { source: 'working_memory', position: 1 } }, context);
      expect(result._referenceError).toBe(true);
      expect(result.target).toBeUndefined();
    }
  });
  it('uses the supplied local year and preserves an explicit year', () => {
    const { normalizeTurnIntentForRuntime } = fixture();
    const result = normalizeTurnIntentForRuntime({ metadata: 'retained', actions: [{ domain: 'calendar', action: 'create', schedule: { kind: 'calendar_date_time', month: 1, day: 3 } }, { domain: 'calendar', action: 'create', schedule: { kind: 'calendar_date_time', year: 2028, month: 1, day: 3 } }] }, context);
    expect(result.metadata).toBe('retained');
    expect(result.actions.map(action => action.schedule?.year)).toEqual([2027, 2028]);
  });
  it('converts an empty sanitized calendar search to a scoped list without leaving a target', () => {
    const { normalizeTurnActionForRuntime } = fixture();
    const result = normalizeTurnActionForRuntime({ domain: 'calendar', action: 'search', query: 'mañana', target: 'mañana' }, context);
    expect(result).toEqual({ domain: 'calendar', action: 'list', scope: 'tomorrow' });
  });
  it('does not infer destructive bulk scope from conversational target text', () => {
    const { normalizeTurnActionForRuntime } = fixture();
    for (const domain of ['entity', 'project']) expect(normalizeTurnActionForRuntime({ domain, action: 'delete', target: 'todos los proyectos' }, context)).toEqual({ domain, action: 'delete', target: 'todos los proyectos' });
  });
  it('does not advance a daily reminder when recurrence is explicitly cleared', () => {
    const resolve = vi.fn(() => ({ valid: true, date: new Date('2027-01-01T08:00:00Z') }));
    const { normalizeTurnActionForRuntime } = fixture({ items: [{ position: 1, type: 'reminder', internalId: 'r1', raw: { recurrence_rule: 'daily' } }] }, { resolveTypedSchedule: resolve });
    const result = normalizeTurnActionForRuntime({ domain: 'reminder', action: 'update', target: '1', clearFields: ['recurrence'], schedule: { kind: 'local_time', hour: 8, minute: 0 } }, context);
    expect(result.schedule?.kind).toBe('local_time');
    expect(resolve).not.toHaveBeenCalled();
  });
  it('passes the inherited future occurrence to the time resolver rather than replacing it', () => {
    const resolve = vi.fn(() => ({ valid: true, date: new Date('2027-01-02T08:00:00Z') }));
    const { normalizeTurnActionForRuntime } = fixture({ items: [{ position: 1, type: 'reminder', internalId: 'r1', raw: { recurrence_rule: 'daily', send_at: '2027-01-02T09:00:00Z' } }] }, { resolveTypedSchedule: resolve });
    const result = normalizeTurnActionForRuntime({ domain: 'reminder', action: 'update', target: '1', schedule: { kind: 'local_time', hour: 8, minute: 0 } }, context);
    expect(resolve.mock.calls[0]).toBeDefined();
    expect(resolve).toHaveBeenCalledWith(result.schedule, expect.objectContaining({ baseDate: '2027-01-02T09:00:00Z' }));
    expect(result.schedule?.kind).toBe('local_time');
  });
  it('leaves an ambiguous referenced task unresolved when creating a reminder', () => {
    const { normalizeTurnActionForRuntime } = fixture({ items: [1, 2].map(position => ({ position, type: 'task', internalId: `t${position}`, title: 'Enviar informe' })) });
    expect(normalizeTurnActionForRuntime({ domain: 'reminder', action: 'create', target: 'Enviar informe' }, context)).toEqual({ domain: 'reminder', action: 'create', target: 'Enviar informe' });
  });
});

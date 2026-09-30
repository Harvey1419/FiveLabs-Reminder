import { describe, expect, it } from 'vitest';
import { validateTurnIntent, TURN_INTENT_SCHEMA } from '../../../src/agent/contracts/intent-contracts.js';
import { getStructuredTurnSchema, stripStructuredNulls } from '../../../src/agent/contracts/foreground-turn-schema.js';
import { presentReadAnswer } from '../../../src/agent/core/read-answer.js';
import { composeExecutionReply, createExecutionFact } from '../../../src/agent/core/execution-facts.js';
import { normalizeTurnIntentForRuntime } from '../../../src/agent/orchestration/intent-normalizer.js';

const actions = [{ domain: 'task', action: 'list', entityName: 'Taller' }];
const plan = { actionIndex: 0, mode: 'records', fields: ['title', 'status'] };
const task = { id: 'task-a', user_id: 'owner', title: 'devolver 720.000 pesos', status: 'pending' };
function execution({ rows = [task], complete = true, success = true, tool = 'manage_task', action = 'list', data = {}, index = 0 } = {}) {
  const fact = createExecutionFact({ toolName: tool, params: { action }, callId: 'call_1', result: {
    success, action: success ? 'listed_tasks' : 'task_read_error', errorCode: success ? null : 'DATABASE_ERROR',
    error: success ? null : 'No pude consultar tus tareas.',
    data: { tasks: rows, entityName: 'Taller', readCoverage: { complete }, readAt: '2026-09-29T20:00:00Z', ...data },
  } });
  return { facts: [fact], records: [{ fact, sourceActionIndex: index }] };
}
function render(options, readAnswer = plan, intentActions = actions) {
  return presentReadAnswer({ actions: intentActions, readAnswer }, execution(options), { userId: 'owner' });
}

describe('typed read-answer contract', () => {
  it('round-trips the plan without letting the model supply operational values', () => {
    const validated = validateTurnIntent({ actions, readAnswer: plan });
    expect(validated.valid).toBe(true);
    const normalized = normalizeTurnIntentForRuntime(validated.intent, { timezone: 'America/Bogota', user: {} });
    expect(normalized.readAnswer).toEqual(plan);
    const provider = getStructuredTurnSchema();
    expect(provider.required).toContain('readAnswer');
    expect(provider.properties.readAnswer.type).toEqual(['object', 'null']);
    expect(provider.properties.readAnswer.required).toEqual(['actionIndex', 'mode', 'fields']);
    expect(TURN_INTENT_SCHEMA.required).toEqual(['actions']);
    expect(getStructuredTurnSchema({ attachmentOnly: true }).properties).not.toHaveProperty('readAnswer');
  });
  it('accepts omitted/null plans and nullable fields while preserving zero', () => {
    expect(validateTurnIntent({ actions }).valid).toBe(true);
    expect(validateTurnIntent({ actions, readAnswer: null }).valid).toBe(true);
    const parsed = stripStructuredNulls({ actions, readAnswer: { actionIndex: 0, mode: 'count', fields: null } });
    expect(validateTurnIntent(parsed).intent.readAnswer).toEqual({ actionIndex: 0, mode: 'count' });
  });
  it.each([
    { ...plan, actionIndex: -1 }, { ...plan, actionIndex: 1 }, { ...plan, actionIndex: '0' },
    { ...plan, mode: 'sum' }, { ...plan, fields: ['amount'] }, { ...plan, fields: ['title', 'title'] },
    { ...plan, fields: [] }, { ...plan, content: 'saldo 190.000' }, { ...plan, amount: 190000 },
    { ...plan, mode: 'count', fields: ['title'] },
  ])('rejects invalid references, fields and ungrounded operands: %j', (readAnswer) => {
    expect(validateTurnIntent({ actions, readAnswer })).toMatchObject({ valid: false, errorCode: 'INVALID_READ_ANSWER' });
  });
  it.each([
    { domain: 'conversation', action: 'reply', content: 'saldo inventado' },
    { domain: 'memory', action: 'search', query: 'Taller' },
    { domain: 'task', action: 'complete', target: 'devolver' },
  ])('cannot treat %j as live read evidence', (source) => {
    expect(validateTurnIntent({ actions: [source], readAnswer: plan }).valid).toBe(false);
  });
});

describe('deterministic read projection', () => {
  it('copies the current title and status, never subtracting a pending obligation', () => {
    const result = render();
    expect(result.facts[0].card).toContain('720.000');
    expect(result.facts[0].card).toContain('pendiente');
    expect(result.facts[0].card).not.toContain('190.000');
    expect(result.facts[0].card).not.toContain('pagado');
    expect(result.evidence).toMatchObject({ tool: 'manage_task', recordIds: ['task-a'], complete: true });
  });
  it('reflects changed/completed records instead of freezing an earlier value', () => {
    const result = render({ rows: [{ ...task, title: 'devolver 340.000 pesos', status: 'completed' }] });
    expect(result.facts[0].card).toContain('340.000');
    expect(result.facts[0].card).toContain('completado');
    expect(result.facts[0].card).not.toContain('720.000');
  });
  it('never turns a successful empty read into a zero financial balance', () => {
    const result = render({ rows: [] });
    expect(result.facts[0].card).toContain('No encontré tareas');
    expect(result.facts[0].card).not.toContain('0 pesos');
    expect(result.evidence.recordIds).toEqual([]);
  });
  it('preserves source failure and does not synthesize a fallback amount', () => {
    const result = render({ success: false });
    expect(result.evidence).toBeNull();
    expect(result.facts[0].success).toBe(false);
    expect(result.facts[0].card).not.toContain('720.000');
  });
  it.each([false, undefined])('does not present an incomplete/unknown sample as an exact count (%s)', (complete) => {
    const result = render({ data: { readCoverage: { complete } } }, { actionIndex: 0, mode: 'count' });
    expect(result.facts[0].card).toContain('no puedo confirmar el total');
    expect(result.evidence.complete).toBe(false);
  });
  it('counts records only when the source certifies completeness', () => {
    const result = render({}, { actionIndex: 0, mode: 'count' });
    expect(result.facts[0].card).toContain('1 tarea');
    expect(result.facts[0].card).not.toContain('720.000');
  });
  it.each([
    [{ ...task, user_id: 'other-owner' }], [{ ...task, id: null }], [task, task], [null],
  ])('fails closed for wrong owner, missing identity or duplicate records: %j', (rows) => {
    const result = render({ rows });
    expect(result.evidence).toBeNull();
    expect(result.facts[0].card).toContain('No pude verificar');
    expect(result.facts[0].card).not.toContain('720.000');
  });
  it('does not count an unrelated memory read as evidence for tasks', () => {
    const result = render({ tool: 'manage_memory' });
    expect(result.evidence).toBeNull();
    expect(result.facts.at(-1).errorCode).toBe('READ_EVIDENCE_MISSING');
    expect(result.facts[0].card).not.toContain('720.000');
  });
  it('uses executor source indexes instead of confusing a staged action with the read', () => {
    const result = render({ index: 1 }, { ...plan, actionIndex: 2 }, [
      { domain: 'conversation', action: 'reply', content: 'anything' },
      { domain: 'reminder', action: 'create', content: 'a draft', missingFields: ['time'] },
      ...actions,
    ]);
    expect(result.evidence.recordIds).toEqual(['task-a']);
  });
  it('keeps original facts immutable and removes the full-list flow for a concise answer', () => {
    const source = execution();
    const originalCard = source.facts[0].card;
    const rendered = presentReadAnswer({ actions, readAnswer: plan }, source, { userId: 'owner' });
    expect(source.facts[0].card).toBe(originalCard);
    expect(rendered.facts[0].flow).toBeNull();
    expect(Object.isFrozen(rendered.evidence)).toBe(true);
  });
  it('projects recorded descriptions and schedules rather than model-provided claims', () => {
    const result = render({ rows: [{ ...task, description: 'Referencia guardada', localFormatted: '30/09/2026, 12:00' }] },
      { ...plan, fields: ['description', 'schedule'] });
    expect(result.facts[0].card).toContain('Referencia guardada');
    expect(result.facts[0].card).toContain('30/09/2026, 12:00');
  });
  it('preserves an explicitly requested empty read answer alongside a mutation confirmation', () => {
    const rendered = render({ rows: [] });
    const mutation = createExecutionFact({ toolName: 'manage_task', params: { action: 'create' },
      result: { success: true, data: [{ id: 'created', title: 'Comprar pan' }] } });
    expect(composeExecutionReply([mutation, ...rendered.facts])).toContain('No encontré tareas');
  });
  it('supports the calendar native operation and civil all-day display without timezone shifts', () => {
    const calendarActions = [{ domain: 'calendar', action: 'search', query: 'Diseño' }];
    const result = render({ tool: 'manage_google_calendar', action: 'search_events', data: {
      tasks: undefined, events: [{ id: 'event-1', summary: 'Diseño', status: 'confirmed', isAllDay: true,
        displayDate: '30/09/2026 (Todo el día)' }],
    } }, { ...plan, fields: ['title', 'schedule'] }, calendarActions);
    expect(result.evidence.tool).toBe('manage_google_calendar');
    expect(result.facts[0].card).toContain('30/09/2026 (Todo el día)');
  });
});

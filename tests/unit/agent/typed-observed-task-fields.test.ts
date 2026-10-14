import { describe, expect, it } from 'vitest';
import { answerFromTaskReturnFields, freezeTaskReferenceSnapshot, taskClaimRows, returnedTaskFacts, renderTaskFields, publicReceiptSummary, type ObservedTaskFact, type ObservedTaskAnswer } from '../../../src/agent/orchestration/observed-task-fields.js';
const row = { id: 'task-id', user_id: 'owner', title: 'Observed task', status: 'pending' };
const fact: ObservedTaskFact = { tool: 'manage_task', requestedAction: 'list', success: true, complete: true, callId: 'call-1', presentationData: { tasks: [row] } };
const action = { domain: 'task', action: 'list', returnFields: ['status', 'description', 'due_date'] };
const claim: ObservedTaskAnswer = { kind: 'task_status', answer: '', evidenceCallIds: ['call-1'], taskClaims: [{ callId: 'call-1', itemId: 'task-id', referencePosition: 3, fields: ['status'] }] };
describe('typed observed task field projection', () => {
  it('distinguishes an absent value from an unobserved field using owned returned rows', () => {
    const input = { ...fact, presentationData: { tasks: [{ ...row, due_date: null }] } };
    expect(answerFromTaskReturnFields(action, [input], 'owner', 'en')).toBe('Observed task: pending; description: unknown; due_date: absent.');
    expect(answerFromTaskReturnFields(action, [input], 'owner', 'es')).toContain('pendiente; descripción: desconocido; fecha de vencimiento: ausente');
  });
  it.each([
    { ...row, user_id: 'other' }, { ...row, id: '' }, { ...row, title: '' }, { ...row, status: 4 },
  ])('refuses foreign or invalid rows %j', invalid => {
    expect(answerFromTaskReturnFields(action, [{ ...fact, presentationData: { tasks: [invalid] } }], 'owner', 'en')).toBe('I could not verify the requested task fields.');
  });
  it('rejects multiple facts, duplicate identities, duplicate fields and unsupported fields', () => {
    const failure = 'I could not verify the requested task fields.';
    expect(answerFromTaskReturnFields(action, [fact, fact], 'owner', 'en')).toBe(failure);
    expect(answerFromTaskReturnFields(action, [{ ...fact, presentationData: { tasks: [row, row] } }], 'owner', 'en')).toBe(failure);
    expect(answerFromTaskReturnFields({ ...action, returnFields: ['status', 'status'] }, [fact], 'owner', 'en')).toBe(failure);
    expect(answerFromTaskReturnFields({ ...action, returnFields: ['title'] }, [fact], 'owner', 'en')).toBe(failure);
  });
  it('does not infer a complete inventory from empty or bounded reads', () => {
    expect(answerFromTaskReturnFields(action, [{ ...fact, presentationData: { tasks: [] } }], 'owner', 'en')).toBe('No tasks returned for this query.');
    expect(answerFromTaskReturnFields(action, [{ ...fact, presentationData: { tasks: Array.from({ length: 13 }, (_, i) => ({ ...row, id: String(i) })) } }], 'owner', 'en')).toBe('I could not verify the requested task fields.');
  });
  it('rejects overlong direct answers and keeps fallback output within its item and text budgets', () => {
    const tasks = Array.from({ length: 12 }, (_, i) => ({ ...row, id: `id-${i}`, title: 'x'.repeat(400), description: 'y'.repeat(400) }));
    expect(answerFromTaskReturnFields({ ...action, returnFields: ['description'] }, [{ ...fact, presentationData: { tasks } }], 'owner', 'en')).toBe('I could not verify the requested task fields.');
    const fallback = returnedTaskFacts([{ ...fact, presentationData: { tasks } }], 'owner', 'en');
    expect(fallback.split('\n')).toHaveLength(2);
    const many = Array.from({ length: 20 }, (_, i) => ({ ...row, id: `id-${i}` }));
    expect(returnedTaskFacts([{ ...fact, presentationData: { tasks: many } }], 'owner', 'en').split('\n')).toHaveLength(13);
  });
  it('binds claim identity to cited observations and reports unresolved positions without guessing', () => {
    const selected = taskClaimRows(claim, [fact], [{ position: 3, itemId: 'different-task' }], 'owner');
    expect(selected?.[0]?.row).toBe(row); expect(selected?.[0]?.referenceUnresolved).toBe(true);
    expect(taskClaimRows(claim, [fact], [{ position: 3, itemId: 'task-id' }], 'owner')?.[0]?.referenceUnresolved).toBe(false);
    expect(taskClaimRows({ ...claim, evidenceCallIds: ['other'] }, [fact], [], 'owner')).toBeNull();
  });
  it('ignores unused inventory claims and rejects unsupported status or insufficient claims', () => {
    expect(taskClaimRows({ ...claim, kind: 'inventory', evidenceCallIds: [] }, [], [], 'owner')).toEqual([]);
    expect(taskClaimRows({ kind: 'task_status', answer: '', evidenceCallIds: [] }, [fact], [], 'owner')).toBeNull();
    expect(taskClaimRows({ ...claim, kind: 'insufficient' }, [fact], [], 'owner')).toBeNull();
  });
  it('redacts full UUIDs before clipping titles and field text', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(publicReceiptSummary('_' + id + '_' + 'x'.repeat(500))).toHaveLength(400);
    expect(renderTaskFields([{ row: { title: `Task _${id}_`, description: id }, fields: ['description'] }], 'en')).toBe('Task _[redacted]_: description: [redacted].');
  });
  it('does not repeat fields already covered by the matching call and item', () => {
    expect(returnedTaskFacts([fact], 'owner', 'en', [{ callId: 'call-1', itemId: 'task-id', fields: ['status'] }])).toBe('');
    expect(returnedTaskFacts([fact], 'owner', 'en', [{ callId: 'different', itemId: 'task-id', fields: ['status'] }])).toContain('Observed task: pending.');
    expect(returnedTaskFacts([{ ...fact, complete: false }], 'owner', 'en')).toBe('');
  });
});
describe('typed frozen task reference view', () => {
  it('copies identity and original positions without raw metadata or renumbering', () => {
    const memory = { items: [{ type: 'reminder', position: 1 }, { type: 'task', position: 3, internalId: 'task-id', title: 'Observed task', raw: { secret: true } }] };
    const frozen = freezeTaskReferenceSnapshot(memory);
    expect(frozen).toEqual({ items: [{ position: 3, type: 'task', internalId: 'task-id', title: 'Observed task' }] });
    memory.items[1]!.title = 'Changed'; expect(frozen && frozen.items[0]?.title).toBe('Observed task');
    expect(freezeTaskReferenceSnapshot(null)).toBeNull(); expect(freezeTaskReferenceSnapshot({ items: [] })).toEqual({ items: [] });
  });
  it('rejects duplicate positions, oversized views and invalid identities instead of silently clipping', () => {
    const item = { type: 'task', position: 2, internalId: 'task-id', title: 'Task' };
    expect(freezeTaskReferenceSnapshot({ items: [item, item] })).toBe(false);
    expect(freezeTaskReferenceSnapshot({ items: Array.from({ length: 101 }, () => ({ type: 'reminder' })) })).toBe(false);
    expect(freezeTaskReferenceSnapshot({ items: [{ ...item, position: 0 }] })).toBe(false);
    expect(freezeTaskReferenceSnapshot({ items: [{ ...item, title: 'x'.repeat(401) }] })).toBe(false);
    expect(freezeTaskReferenceSnapshot({ items: Array.from({ length: 20 }, (_, i) => ({ ...item, position: i + 1, title: 'x'.repeat(400) })) })).toBe(false);
  });
});

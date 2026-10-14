import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/agent/providers/client.js', () => ({ callChatCompletion: vi.fn() }));
import { untrustedResultMock } from '../../support/unit/contract-boundary.js';
import { callChatCompletion } from '../../../src/agent/providers/client.js';
import { answerFromObservedReads } from '../../../src/agent/orchestration/observed-answer.js';
import { createExecutionFact, TASK_CARD_COVERAGE } from '../../../src/agent/core/execution-facts.js';
import { TOOL_NAMES } from '../../../src/agent/contracts/tool-names.js';

const snapshot = { items: [
  { position: 1, type: 'task', internalId: 'alfa', title: 'Alfa' },
  { position: 2, type: 'task', internalId: 'beta', title: 'Beta' },
] };
const input = { userText: 'Is the first completed and the second pending?', language: 'en', userId: 'owner', referenceSnapshot: snapshot,
  facts: [{ tool: TOOL_NAMES.MANAGE_TASK, requestedAction: 'list', success: true, complete: true, callId: 'fresh', presentationData: { tasks: [
    { id: 'beta', user_id: 'owner', title: 'Beta', status: 'pending' },
    { id: 'alfa', user_id: 'owner', title: 'Alfa', status: 'completed' },
  ] } }] };
const claims = [
  { callId: 'fresh', itemId: 'alfa', referencePosition: 1, fields: ['status'] },
  { callId: 'fresh', itemId: 'beta', referencePosition: 2, fields: ['status'] },
];
function response(taskClaims: unknown[] = claims) {
  untrustedResultMock(callChatCompletion).mockClear();
  untrustedResultMock(callChatCompletion).mockResolvedValue({ content: JSON.stringify({ kind: 'task_status', answer: '', evidenceCallIds: ['fresh'], taskClaims }) });
}
describe('typed task status evidence binding', () => {
  it.each(['Redundant correct prose', 'Alfa pending; Beta completed.'])('validates actual claims independently of unused prose: %s', async answer => {
    untrustedResultMock(callChatCompletion).mockClear();
    untrustedResultMock(callChatCompletion).mockImplementation(async (_messages, options) => {
      const content = JSON.stringify({ kind: 'task_status', answer, evidenceCallIds: ['fresh'], taskClaims: claims });
      expect(options!.validateStructuredContent!(content)!.valid).toBe(true);
      return { content };
    });
    const outcome = vi.fn();
    expect(await answerFromObservedReads({ ...input, onInterpretationOutcome: outcome })).toBe('Alfa: completed.\nBeta: pending.');
    expect(outcome).toHaveBeenCalledWith('accepted');
    expect(callChatCompletion).toHaveBeenCalledTimes(1);
  });
  it.each([1, 2])('recovers named fields with explicit unresolved position %s against a Beta-only display', async referencePosition => {
    untrustedResultMock(callChatCompletion).mockClear();
    untrustedResultMock(callChatCompletion).mockImplementation(async (_messages, options) => {
      const content = JSON.stringify({ kind: 'task_status', answer: 'The second is completed.', evidenceCallIds: ['fresh'], taskClaims: [
        { ...claims[0]!, referencePosition, fields: ['status', 'description'] }, claims[1]!,
      ] });
      expect(options!.validateStructuredContent!(content)!.valid).toBe(true);
      return { content };
    });
    const outcome = vi.fn();
    const tasks = input.facts[0]!.presentationData.tasks.map(row => ({ ...row, description: row.id === 'alfa' ? 'Actual notes' : null }));
    const result = await answerFromObservedReads({ ...input, facts: [{ ...input.facts[0], presentationData: { tasks } }],
      referenceSnapshot: { items: [{ ...snapshot.items[1], position: 1 }] }, onInterpretationOutcome: outcome,
      conversationHistory: [{ role: 'assistant', entities: { _turnMetadata: { kind: 'operational_result', mutationReceipts: [{ operation: 'task.create', summary: 'Old creation receipt' }] } } }],
    });
    expect(result).toContain('Alfa: completed; description: Actual notes.');
    expect(result).toContain('Beta: pending.');
    expect(result).toContain('requested positions cannot be bound to the last display');
    expect(result).not.toMatch(/The second is completed|unsupported comparisons|Old creation receipt/);
    expect(outcome).toHaveBeenCalledWith('reference_unresolved');
    expect(callChatCompletion).toHaveBeenCalledTimes(1);
  });
  it('suppresses only proven retained-card fields, preserving direct fallback and selected answers', async () => {
    const tasks = [{ id: 'alfa', title: '2 Borona', status: 'completed', description: 'Original notes', due_date: null }];
    const fact = createExecutionFact({ toolName: TOOL_NAMES.MANAGE_TASK, params: { action: 'list' }, result: { success: true, data: { tasks } }, callId: 'fresh', language: 'en' });
    expect(fact[TASK_CARD_COVERAGE]).toEqual([{ itemId: 'alfa', fields: ['status'] }]);
    expect(JSON.stringify(fact)).not.toContain('itemId');
    untrustedResultMock(callChatCompletion).mockResolvedValue({ unavailable: true });
    const direct = await answerFromObservedReads({ ...input, facts: [fact] });
    const retainedTaskCoverage = fact[TASK_CARD_COVERAGE].map(item => ({ ...item, callId: fact.callId }));
    const composed = await answerFromObservedReads({ ...input, facts: [fact], retainedTaskCoverage });
    expect(direct).toContain('2 Borona: completed');
    expect(composed).not.toContain('2 Borona: completed');
    expect(composed).toContain('description: Original notes');
    expect(composed).toContain('due_date: absent');
    const payload = (untrustedResultMock(callChatCompletion).mock.calls.at(-1)![0]![1] as { content: string }).content;
    expect(Object.keys(JSON.parse(payload).observedReads[0])).toEqual(['callId', 'tool', 'operation', 'data']);
    expect(payload).not.toContain('retainedTaskCoverage');
    response([{ ...claims[0]!, referencePosition: null }]);
    expect(await answerFromObservedReads({ ...input, facts: [fact], retainedTaskCoverage })).toBe('2 Borona: completed.');
    untrustedResultMock(callChatCompletion).mockClear();
  });
  it.each([
    ['all_pending', 'Exact notes', ['description']],
    ['today', 'Exact notes', ['description']],
    ['all_pending', '  Normalized notes  ', []],
    ['today', 'Line one\nLine two', []],
  ])('reports actual full description coverage for %s / %j', (scope, description, fields) => {
    const fact = createExecutionFact({ toolName: TOOL_NAMES.MANAGE_TASK, params: { action: 'list' }, result: { success: true, data: { scope, tasks: [{ id: 'alfa', title: 'Alfa', status: 'pending', description, due_date: '2031-01-14T15:00:00Z' }] } }, language: 'en' });
    expect(fact[TASK_CARD_COVERAGE]).toEqual([{ itemId: 'alfa', fields }]);
  });
  it('keeps coverage bounded and unknown for partial, duplicate and oversized views', () => {
    for (const result of [
      { success: true, partialSuccess: true, data: { tasks: [{ id: 'alfa', title: 'Alfa', status: 'completed' }] } },
      { success: true, data: { tasks: [{ id: 'alfa', title: 'Alfa', status: 'completed' }, { id: 'alfa', title: 'Other', status: 'completed' }] } },
      { success: true, data: { tasks: Array.from({ length: 101 }, (_, i) => ({ id: String(i), title: 'Task', status: 'completed' })) } },
    ]) {
      const fact = createExecutionFact({ toolName: TOOL_NAMES.MANAGE_TASK, params: { action: 'list' }, result, language: 'en' });
      expect(fact[TASK_CARD_COVERAGE]).toEqual([]);
    }
  });
  it('retains useful named facts instead of a blanket refusal after rejecting task prose', async () => {
    untrustedResultMock(callChatCompletion).mockResolvedValue({ content: JSON.stringify({ kind: 'derived', answer: 'Alfa pending; Beta completed.', evidenceCallIds: ['fresh'], taskClaims: [] }) });
    const tasks = [{ id: 'alfa', title: 'Alfa', status: 'completed', description: 'Original notes', due_date: '2031-01-14T15:00:00Z' }, input.facts[0]!.presentationData.tasks[0]];
    const result = await answerFromObservedReads({ ...input, facts: [{ ...input.facts[0], presentationData: { tasks } }] });
    expect(result).not.toContain('Alfa pending; Beta completed.');
    expect(result).toContain('Alfa: completed');
    expect(result).toContain('Beta: pending');
    expect(result).toContain('Original notes');
    expect(result).toContain('2031-01-14T15:00:00Z');
    expect(result).toContain('returned facts');
    expect(callChatCompletion).toHaveBeenCalledTimes(1);
  });
  it.each(['derived', 'recap', 'insufficient'])('never accepts raw contradictory task prose under kind %s', async kind => {
    untrustedResultMock(callChatCompletion).mockResolvedValue({ content: JSON.stringify({ kind, answer: 'Alfa pending; Beta completed.', evidenceCallIds: ['fresh'], taskClaims: [] }) });
    expect(await answerFromObservedReads(input)).not.toContain('Alfa pending; Beta completed.');
  });
  it('ignores unused inventory claims without publishing their identities or coverage', async () => {
    untrustedResultMock(callChatCompletion).mockClear();
    untrustedResultMock(callChatCompletion).mockImplementation(async (_messages, options) => {
      const content = JSON.stringify({ kind: 'inventory', answer: '', evidenceCallIds: ['fresh'], taskCoverage: 'both_statuses', taskClaims: [
        { callId: 'not-a-task', itemId: 'foreign-secret-id', referencePosition: 99, fields: ['status'] },
      ] });
      expect(options!.validateStructuredContent!(content)!.valid).toBe(true);
      return { content };
    });
    const result = await answerFromObservedReads({ ...input, facts: [{ ...input.facts[0], presentationData: { tasks: [input.facts[0]!.presentationData.tasks[0]] } }] });
    expect(result).toBeNull(); // Router retains the actual cards; no synthetic prose.
    expect(callChatCompletion).toHaveBeenCalledTimes(1);
  });
  it.each([
    { kind: 'inventory', answer: 'Alfa is completed.', evidenceCallIds: ['fresh'], taskClaims: [] },
    { kind: 'inventory', answer: '', evidenceCallIds: ['unobserved-call'], taskClaims: [] },
  ])('rejects inventory prose or nonexistent cited observations', async decision => {
    untrustedResultMock(callChatCompletion).mockImplementation(async (_messages, options) => {
      expect(options!.validateStructuredContent!(JSON.stringify(decision))!.valid).toBe(false);
      return { unavailable: true };
    });
    const result = await answerFromObservedReads(input);
    expect(result).not.toContain('Alfa is completed');
    expect(result).not.toContain('unobserved-call');
  });
  it('preserves non-task derived answers without a task-state channel', async () => {
    untrustedResultMock(callChatCompletion).mockResolvedValue({ content: JSON.stringify({ kind: 'derived', answer: 'A general explanation.', evidenceCallIds: ['fresh'], taskClaims: [] }) });
    expect(await answerFromObservedReads({ ...input, facts: [{ ...input.facts[0], tool: TOOL_NAMES.MANAGE_REMINDER, presentationData: { reminders: [] } } as Parameters<typeof answerFromObservedReads>[0]['facts'][number]] })).toBe('A general explanation.');
  });
  it('keeps stable positions across non-task entries and rejects duplicate fields', async () => {
    response([{ callId: 'fresh', itemId: 'alfa', referencePosition: 2, fields: ['status'] }]);
    const items = [{ position: 1, type: 'reminder', internalId: 'reminder', title: 'Other' }, { ...snapshot.items[0], position: 2 }];
    expect(await answerFromObservedReads({ ...input, referenceSnapshot: { items } })).toBe('Alfa: completed.');
    response([{ ...claims[0]!, fields: ['status', 'status'] }]);
    expect(await answerFromObservedReads(input)).toContain('could not verify');
  });
  it('renders selected actual public fields, numeric names, explicit absence and missing unknown', async () => {
    untrustedResultMock(callChatCompletion).mockResolvedValue({ content: JSON.stringify({ kind: 'derived', answer: '', evidenceCallIds: ['fresh'], taskClaims: [
      { callId: 'fresh', itemId: 'alfa', referencePosition: null, fields: ['status', 'description', 'due_date', 'completed_at'] },
    ] }) });
    const tasks = [{ id: 'alfa', title: '2 Borona', status: 'completed', description: 'Original notes', due_date: null }];
    const result = await answerFromObservedReads({ ...input, facts: [{ ...input.facts[0], presentationData: { tasks } }] });
    expect(result).toContain('2 Borona');
    expect(result).toContain('completed');
    expect(result).toContain('Original notes');
    expect(result).toContain('due_date: absent');
    expect(result).toContain('completed_at: unknown');
  });
  it('renders actual dates and masks underscore-wrapped UUIDs before clipping fields', async () => {
    const uuid = '12345678-1234-1234-1234-123456789abc';
    untrustedResultMock(callChatCompletion).mockResolvedValue({ content: JSON.stringify({ kind: 'derived', answer: '', evidenceCallIds: ['fresh'], taskClaims: [
      { callId: 'fresh', itemId: 'alfa', referencePosition: null, fields: ['description', 'due_date'] },
    ] }) });
    const tasks = [{ id: 'alfa', title: `Alfa _${uuid}_`, description: 'x'.repeat(380) + `_${uuid}_` + 'x'.repeat(500), due_date: '2031-01-14T15:00:00Z' }];
    const result = await answerFromObservedReads({ ...input, facts: [{ ...input.facts[0], presentationData: { tasks } }] });
    expect(result).toContain('2031-01-14T15:00:00Z');
    expect(result).not.toContain(uuid.slice(0, 8));
    expect(result).toContain('[redacted]');
    expect(result!.length).toBeLessThan(700);
  });
  it.each([
    Array.from({ length: 101 }, (_, i) => ({ ...snapshot.items[0], position: i + 1 })),
    [{ ...snapshot.items[0], title: 'x'.repeat(401) }],
    [{ ...snapshot.items[0], internalId: 'x'.repeat(81) }],
    Array.from({ length: 30 }, (_, i) => ({ ...snapshot.items[0], position: i + 1, title: 'x'.repeat(400) })),
  ].map(items => [items]))('rejects oversized reference projection before calling the provider', async items => {
    response();
    await answerFromObservedReads({ ...input, referenceSnapshot: { items } });
    expect(callChatCompletion).not.toHaveBeenCalled();
  });
  it('includes references and dialogue in the combined 24000-character guard', async () => {
    response();
    const items = Array.from({ length: 18 }, (_, i) => ({ ...snapshot.items[0], position: i + 1, title: 'x'.repeat(350) }));
    const history = Array.from({ length: 6 }, () => ({ role: 'user', content: 'x'.repeat(2000) }));
    await answerFromObservedReads({ ...input, userText: 'x'.repeat(6000), referenceSnapshot: { items }, conversationHistory: history });
    expect(callChatCompletion).not.toHaveBeenCalled();
  });
  it('rejects declared both-status recap coverage backed only by pending rows', async () => {
    untrustedResultMock(callChatCompletion).mockResolvedValue({ content: JSON.stringify({ kind: 'recap', answer: '', evidenceCallIds: ['fresh'], taskClaims: [], taskCoverage: 'both_statuses' }) });
    const result = await answerFromObservedReads({ ...input, currentRecap: true, facts: [{ ...input.facts[0], presentationData: { tasks: [input.facts[0]!.presentationData.tasks[0]] } }] });
    expect(result).not.toContain('Both statuses verified');
    expect(result).toContain('does not verify');
  });
  it('accepts declared both-status returned-row coverage without claiming a complete inventory', async () => {
    untrustedResultMock(callChatCompletion).mockResolvedValue({ content: JSON.stringify({ kind: 'recap', answer: '', evidenceCallIds: ['fresh'], taskClaims: claims, taskCoverage: 'both_statuses' }) });
    const result = await answerFromObservedReads({ ...input, currentRecap: true });
    expect(result).toContain('Alfa: completed.\nBeta: pending.');
    expect(result).toContain('Unseen or filtered items remain unknown');
  });
  it('renders names and fresh states against pre-read order, not fresh Beta-first order', async () => {
    response();
    expect(await answerFromObservedReads(input)).toBe('Alfa: completed.\nBeta: pending.');
    expect(callChatCompletion).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((untrustedResultMock(callChatCompletion).mock.calls[0]![0]![1] as { content: string }).content);
    expect(payload.taskReferences.map((item: { itemId: string }) => item.itemId)).toEqual(['alfa', 'beta']);
  });
  it.each([
    [{ ...claims[0]!, status: 'pending' }],
    [{ ...claims[0]!, callId: 'invented' }],
    [{ ...claims[0]!, itemId: 'missing', referencePosition: null }],
    [{ ...claims[0]!, status: 'unknown' }],
  ])('fails closed for unsupported binding %j', async claim => {
    response([claim]);
    expect(await answerFromObservedReads(input)).toContain('could not verify');
  });
  it.each([
    [{ ...claims[0]!, itemId: 'beta' }],
    [{ ...claims[0]!, referencePosition: 3 }],
    claims,
  ].map(taskClaims => [taskClaims]))('does not assert mismatched or missing ordinal bindings %j', async taskClaims => {
    response(taskClaims);
    const outcome = vi.fn();
    const result = await answerFromObservedReads({ ...input, referenceSnapshot: { items: [snapshot.items[0]] }, onInterpretationOutcome: outcome });
    expect(result).toContain('requested positions cannot be bound to the last display');
    expect(result).not.toContain('could not verify');
    expect(outcome).toHaveBeenCalledWith('reference_unresolved');
  });
  it.each(['unknown', 'duplicate-claim', 'duplicate-row', 'foreign', 'invalid-field', 'empty'])('unused prose does not bypass %s claim safety', async mode => {
    const row = { id: 'alfa', user_id: mode === 'foreign' ? 'other' : 'owner', title: 'Alfa', status: mode === 'invalid-field' ? {} : 'completed' };
    const claim = { ...claims[0]!, itemId: mode === 'unknown' ? 'unknown' : 'alfa' };
    const taskClaims = mode === 'empty' ? [] : mode === 'duplicate-claim' ? [claim, claim] : [claim];
    const content = JSON.stringify({ kind: 'task_status', answer: 'UNTRUSTED FREE TASK PROSE', evidenceCallIds: ['fresh'], taskClaims });
    untrustedResultMock(callChatCompletion).mockImplementation(async (_messages, options) => {
      expect(options!.validateStructuredContent!(content)!.valid).toBe(false);
      return { content };
    });
    const outcome = vi.fn();
    const result = await answerFromObservedReads({ ...input, facts: [{ ...input.facts[0], presentationData: { tasks: mode === 'duplicate-row' ? [row, row] : [row] } }], onInterpretationOutcome: outcome });
    expect(result).not.toContain('UNTRUSTED FREE TASK PROSE');
    expect(outcome).toHaveBeenCalledWith('rejected');
  });
  it('rejects nonowned, partial and duplicate-identity observations', async () => {
    for (const tasks of [
      [{ id: 'alfa', user_id: 'another', title: 'Alfa', status: 'completed' }],
      [{ id: 'alfa', title: 'Alfa', status: 'completed' }, { id: 'alfa', title: 'Other', status: 'pending' }],
    ]) {
      response([claims[0]!]);
      expect(await answerFromObservedReads({ ...input, facts: [{ ...input.facts[0], presentationData: { tasks } }] })).toContain('could not verify');
    }
    response([claims[0]!]);
    expect(await answerFromObservedReads({ ...input, facts: [{ ...input.facts[0], complete: false }] })).toBeNull();
  });
  it('permits named identity without positional binding and numeric titles without parsing', async () => {
    response([{ ...claims[0]!, referencePosition: null }]);
    const tasks = [{ id: 'alfa', title: '2 Borona', description: 'the first is not a reference', status: 'completed' }];
    expect(await answerFromObservedReads({ ...input, referenceSnapshot: null, facts: [{ ...input.facts[0], presentationData: { tasks } }] })).toBe('2 Borona: completed.');
  });
});

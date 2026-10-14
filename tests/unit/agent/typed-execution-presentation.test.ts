import { describe, expect, it, vi } from 'vitest';
import { createExecutionPresentation, TASK_CARD_COVERAGE } from '../../../src/agent/core/execution-presentation.js';
import type { ExecutionPresentationDependencies, PresentationContext } from '../../../src/agent/core/execution-presentation.js';
const blank = () => null;
function fixture(overrides: Partial<ExecutionPresentationDependencies> = {}) {
  const deps: ExecutionPresentationDependencies = {
    sanitizeResponseText: value => typeof value === 'string' ? value.replace(/PRIVATE/g, '').trim() : '',
    composeTurnPresentation: facts => facts.map(fact => fact.card).join('\n\n'),
    formatCanonicalAgenda: blank, formatCanonicalTaskList: blank, formatCanonicalTaskComplete: blank,
    formatCanonicalTaskCreate: blank, formatCanonicalTaskDelete: blank, formatCanonicalTaskUpdate: blank,
    formatCanonicalEntityCreate: blank, formatCanonicalEntityDeduplicate: blank, formatCanonicalEntityDelete: blank,
    formatCanonicalEntityList: blank, formatCanonicalEntityMerge: blank, formatCanonicalEntityRename: blank,
    formatCanonicalReminderAcknowledge: blank, formatCanonicalReminderCancel: blank,
    formatCanonicalReminderCreate: blank, formatCanonicalReminderList: blank, formatCanonicalReminderUpdate: blank,
    ...overrides,
  };
  return createExecutionPresentation(deps);
}
function taskRenderer(rows: { id: unknown }[], fields: string[] = ['status']) {
  return (_data: unknown, context: unknown) => {
    for (const row of rows) (context as PresentationContext).onTaskRendered?.(row, fields);
    return 'Task card';
  };
}
describe('typed tool observation presentation', () => {
  it('overrides optimistic cards when a reply reports an unknown outcome without mutating it', () => {
    const formatter = vi.fn(() => 'Confirmed');
    const { createExecutionFact } = fixture({ formatCanonicalTaskComplete: formatter });
    const result = { success: true, outcome: 'unknown', confirmation: 'Completed', formattedCard: 'Success', data: { id: 'a' } };
    const fact = createExecutionFact({ toolName: 'manage_task', params: { action: 'complete' }, result, language: 'en' });
    expect(fact.success).toBe(false); expect(fact.complete).toBe(false); expect(fact.outcome).toBe('unknown');
    expect(fact.card).toContain('could not confirm'); expect(fact.summary).toContain('could not confirm');
    expect(formatter).not.toHaveBeenCalled(); expect(result.confirmation).toBe('Completed');
  });
  it('never publishes complete task coverage for partial success or incomplete observations', () => {
    const { createExecutionFact } = fixture({ formatCanonicalTaskList: taskRenderer([{ id: 'a' }]) });
    for (const result of [{ success: true, partialSuccess: true, data: {} }, { success: true, complete: false, data: {} }]) {
      const fact = createExecutionFact({ toolName: 'manage_task', params: { action: 'list' }, result });
      expect(fact.outcome).toBe('partial_success'); expect(fact[TASK_CARD_COVERAGE]).toEqual([]);
    }
  });
  it('excludes duplicate identities while preserving unique rendered coverage', () => {
    const { createExecutionFact } = fixture({ formatCanonicalTaskList: taskRenderer([{ id: 'a' }, { id: 'b' }, { id: 'a' }]) });
    const fact = createExecutionFact({ toolName: 'manage_task', params: { action: 'list' }, result: { success: true, data: {} } });
    expect(fact[TASK_CARD_COVERAGE]).toEqual([{ itemId: 'b', fields: ['status'] }]);
  });
  it('clears oversized coverage and ignores invalid row identities', () => {
    const { createExecutionFact } = fixture({ formatCanonicalTaskList: taskRenderer(Array.from({ length: 101 }, (_, i) => ({ id: String(i) }))) });
    expect(createExecutionFact({ toolName: 'manage_task', params: { action: 'list' }, result: { success: true, data: {} } })[TASK_CARD_COVERAGE]).toEqual([]);
    const invalid = fixture({ formatCanonicalTaskList: taskRenderer([{ id: '' }, { id: 12 }, { id: 'x'.repeat(81) }]) });
    expect(invalid.createExecutionFact({ toolName: 'manage_task', params: { action: 'list' }, result: { success: true, data: {} } })[TASK_CARD_COVERAGE]).toEqual([]);
  });
  it('keeps frozen coverage local and snapshots fields without serializing the symbol', () => {
    const fields = ['status'];
    const { createExecutionFact } = fixture({ formatCanonicalTaskList: taskRenderer([{ id: 'a' }], fields) });
    const fact = createExecutionFact({ toolName: 'manage_task', params: { action: 'list' }, result: { success: true, data: {} } });
    fields.push('description');
    expect(fact[TASK_CARD_COVERAGE]).toEqual([{ itemId: 'a', fields: ['status'] }]);
    expect(Object.isFrozen(fact)).toBe(true); expect(Object.isFrozen(fact[TASK_CARD_COVERAGE][0]?.fields)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(fact, TASK_CARD_COVERAGE)?.enumerable).toBe(false);
    expect(JSON.stringify(fact)).not.toContain('itemId');
  });
  it('retains caller timezone precedence and snapshots parameters while leaving payload metadata opaque', () => {
    const { createExecutionFact } = fixture();
    const params = { action: 'list' }; const data = { timezone: 'UTC', locale: 'en-GB', metadata: { opaque: true } };
    const fact = createExecutionFact({ toolName: 'other', params, result: { success: true, data, rawSummary: 'PRIVATE observed' }, language: 'en', timezone: 'America/Bogota' });
    params.action = 'delete';
    expect(fact.presentationParams).toEqual({ action: 'list' }); expect(fact.presentationData).toBe(data);
    expect(fact.presentationContext).toMatchObject({ timezone: 'America/Bogota', locale: 'en-GB' }); expect(fact.summary).toBe('observed');
  });
  it('composes once with sanitized framing and returns no framing for an empty turn', () => {
    const compose = vi.fn(() => 'PRIVATE Body');
    const { createExecutionFact, composeExecutionReply } = fixture({ composeTurnPresentation: compose });
    const fact = createExecutionFact({ toolName: 'other', result: { success: true } });
    expect(composeExecutionReply([null, fact], 'en', { framing: { before: 'PRIVATE Before', after: 'After PRIVATE' } })).toBe('Before\n\nBody\n\nAfter');
    expect(compose).toHaveBeenCalledTimes(1);
    expect(composeExecutionReply([], 'en', { framing: { before: 'Before' } })).toBe('');
  });
  it('does not infer a confirmed payment from a subscription response with unknown payment outcome', () => {
    const { createExecutionFact } = fixture();
    const fact = createExecutionFact({ toolName: 'manage_subscription', params: { action: 'info' }, result: { success: true, action: 'subscription_info', data: { provider: 'sandbox', paymentOutcome: null } }, language: 'en' });
    expect(fact.card).toContain('payment outcome and subscription status: unknown');
    expect(fact.card).toContain('Do not retry manually');
  });
});

import { describe, expect, it } from 'vitest';
import { formatCanonicalEntityCreate, formatCanonicalEntityRename, formatCanonicalEntityMerge, formatCanonicalEntityDeduplicate, formatCanonicalEntityList, formatCanonicalEntityDelete } from '../../../src/shared/entity-card-presentation.js';
import { createExecutionFact, composeExecutionReply } from '../../../src/agent/core/execution-facts.js';
describe('typed canonical entity and project cards', () => {
  it('retains bilingual category labels and the existing unknown-category fallback', () => {
    expect(formatCanonicalEntityCreate({ name: 'Ana', category: 'person' }, { language: 'es' })).toContain('*Ana* — persona');
    expect(formatCanonicalEntityCreate({ name: 'Ana', category: 'person' }, { language: 'en' })).toContain('*Ana* — person');
    expect(formatCanonicalEntityCreate({ name: 'Unknown', category: 'custom' }, { language: 'es' })).toContain('*Unknown* — otro');
    expect(formatCanonicalEntityCreate({ name: 'Unknown', category: 'custom' }, { language: 'en' })).toContain('*Unknown* — custom');
  });
  it('distinguishes absent counts from explicit zero and preserves count alias precedence', () => {
    const text = formatCanonicalEntityList([{ name: 'Unspecified' }, { name: 'Zero', taskCount: 0 }, { name: 'Alias', pendingTaskCount: 1 }, { name: 'Preferred', taskCount: 2, pendingTaskCount: 9 }], { category: 'project', language: 'en' });
    expect(text).toContain('1. *Unspecified*\n'); expect(text).toContain('2. *Zero* · _no pending tasks_'); expect(text).toContain('3. *Alias* · 1 pending task'); expect(text).toContain('4. *Preferred* · 2 pending tasks'); expect(text).not.toContain('9 pending tasks');
  });
  it('keeps project list order and raw records unchanged while hiding private identity fields', () => {
    const records = Object.freeze([Object.freeze({ id: 'private-b', name: 'B' }), Object.freeze({ id: 'private-a', name: 'A' })]);
    const text = formatCanonicalEntityList(records, { category: 'project', language: 'es' });
    expect(text).toContain('1. *B*'); expect(text).toContain('2. *A*'); expect(text).not.toContain('private-'); expect(records[0]?.name).toBe('B');
  });
  it('uses requested rename and merge names ahead of fallback service metadata', () => {
    const params = Object.freeze({ oldName: 'Old requested', newName: 'New requested' });
    expect(formatCanonicalEntityRename({ oldName: 'Old fallback', name: 'New fallback' }, params, { language: 'en' })).toContain('Old requested → New requested');
    expect(formatCanonicalEntityMerge({ sourceName: 'Fallback', targetName: 'Fallback target', tasksMovedCount: 1 }, { sourceName: 'Source', targetName: 'Target' }, { language: 'en' })).toContain('Source → Target\n1 task moved');
    expect(params.newName).toBe('New requested');
  });
  it('preserves explicit deletion counts and reports all companion outcomes from metadata', () => {
    const text = formatCanonicalEntityDelete({ projects: [{ name: 'Work' }, { name: 'Home' }], deletedCount: 0, deletedTaskCount: 1, cancelledReminderCount: 2, preservedCompletedTaskCount: 1 }, { language: 'en' });
    expect(text).toContain('0 projects deleted'); expect(text).toContain('• Work\n• Home'); expect(text).toContain('1 unfinished task was also deleted'); expect(text).toContain('2 related reminders were cancelled'); expect(text).toContain('1 completed task remains in history');
  });
  it('shows incomplete-cleanup warnings and preserves partial classification in whole-turn replies', () => {
    const data = { entities: [{ name: 'Work' }], deletedCount: 1, deletedTaskCount: 0, taskCleanupError: 'Uncertain', partialSuccess: true };
    const direct = formatCanonicalEntityDelete(data, { language: 'en' }); expect(direct).toContain('could not be cleaned up completely');
    const fact = createExecutionFact({ toolName: 'manage_entity', params: { action: 'delete' }, result: { success: true, partialSuccess: true, data, rawSummary: 'Work deleted; cleanup incomplete.' }, language: 'en' });
    expect(fact.outcome).toBe('partial_success'); expect(fact.card).toContain('could not be cleaned up completely'); const reply = composeExecutionReply([fact], 'en'); expect(reply).toContain('partially completed'); expect(reply).toContain('cleanup incomplete');
  });
  it('keeps empty project lists distinct from other entities and supports singular cleanup counts', () => {
    expect(formatCanonicalEntityList([], { category: 'project', language: 'en' })).toContain('You have no registered projects');
    expect(formatCanonicalEntityList([], { category: 'person', language: 'en' })).toContain('You have no registered entities');
    expect(formatCanonicalEntityDeduplicate({ mergedCount: 1 }, { language: 'es' })).toContain('Se fusionó 1 entidad redundante');
    expect(formatCanonicalEntityDeduplicate({ mergedCount: 2 }, { language: 'en' })).toContain('2 redundant entities were merged');
  });
  it('prevents unknown observed outcomes from reusing optimistic deletion cards', () => {
    const fact = createExecutionFact({ toolName: 'manage_project', params: { action: 'delete' }, result: { success: true, outcome: 'unknown', data: { projects: [{ name: 'Work' }], deletedCount: 1 }, formattedCard: 'Confirmed deletion' }, language: 'en' });
    expect(fact.success).toBe(false); expect(fact.card).toContain('could not confirm'); expect(fact.card).not.toContain('Project deleted'); expect(fact.card).not.toContain('Confirmed deletion');
  });
});

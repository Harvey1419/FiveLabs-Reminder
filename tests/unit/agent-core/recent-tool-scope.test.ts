import { describe, expect, it } from 'vitest';
import type { AIMessage } from '@templelabs/contracts';
import { recentToolScope } from '../../../src/adapters/agent-core/recent-tool-scope.js';
const defaults = ['task_create', 'reminder_create'];
const available = [...defaults, 'reminder_read'];
function pair(name: string, status = 'success'): AIMessage[] {
  return [{ role: 'assistant', content: '', toolCalls: [{ id: name, name, arguments: {} }] },
    { role: 'tool', toolCallId: name, content: { status }, isError: status !== 'success' }];
}
describe('owner-scoped successful schema cache', () => {
  it('reserves action defaults before historical reads without classifying user text', () => {
    const history = [...pair('task_create'), ...pair('reminder_read')];
    expect(recentToolScope(history, available, defaults)).toEqual(defaults);
  });
  it.each(['failed', 'indeterminate', 'partial'])('does not warm schemas from %s outcomes', status => {
    expect(recentToolScope(pair('reminder_read', status), available, defaults)).toEqual(defaults);
  });
  it('filters capabilities and ignores discovery or orphan observations', () => {
    expect(recentToolScope([...pair('reminder_read'), ...pair('tools_select')], defaults, defaults)).toEqual(defaults);
    expect(recentToolScope([{ role: 'tool', toolCallId: 'orphan', content: { status: 'success' }, isError: false }], available, defaults)).toEqual(defaults);
  });
  it('does not alter durable history or exceed the two-schema bound', () => {
    const history = [...pair('reminder_create'), ...pair('task_create'), ...pair('reminder_read')], original = structuredClone(history);
    expect(recentToolScope(history, available, defaults)).toEqual(defaults);
    expect(history).toEqual(original);
  });
  it('does not let two passive reads displace either creation default', () => {
    const history = [...pair('calendar_read'), ...pair('reminder_read')];
    expect(recentToolScope(history, [...available, 'calendar_read'], defaults)).toEqual(defaults);
  });
  it('uses recent successes for remaining slots when defaults are capability-filtered', () => {
    const history = [...pair('calendar_read'), ...pair('reminder_read')];
    expect(recentToolScope(history, ['reminder_create', 'reminder_read', 'calendar_read'], defaults))
      .toEqual(['reminder_create', 'reminder_read']);
    expect(recentToolScope(history, ['reminder_read', 'calendar_read'], defaults))
      .toEqual(['reminder_read', 'calendar_read']);
  });
  it('honors configured creation defaults for other domains and deduplicates them', () => {
    expect(recentToolScope(pair('reminder_read'), [...available, 'calendar_create'], ['calendar_create', 'calendar_create']))
      .toEqual(['calendar_create', 'reminder_read']);
  });
});

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
  it('prefers the last verified interaction without reading or classifying user text', () => {
    const history = [...pair('task_create'), ...pair('reminder_read')];
    expect(recentToolScope(history, available, defaults)).toEqual(['reminder_read', 'task_create']);
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
    expect(recentToolScope(history, available, defaults)).toEqual(['reminder_read', 'task_create']);
    expect(history).toEqual(original);
  });
});

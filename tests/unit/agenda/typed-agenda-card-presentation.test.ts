import { describe, expect, it, vi } from 'vitest';
import { createAgendaPresentation } from '../../../src/shared/agenda-card-presentation.js';
import { createTaskPresentation } from '../../../src/shared/task-card-presentation.js';
function fixture() {
  const time = vi.fn(() => 'Humanized date');
  const task = createTaskPresentation({ formatHumanFriendlyDateTime: time });
  return { time, ...createAgendaPresentation({ ...task, formatHumanFriendlyDateTime: time, isAllPendingScope: value => value === 'all_pending', normalizeAgendaScope: (value, fallback) => typeof value === 'string' ? value : fallback, normalizeTaskScope: (value, fallback) => typeof value === 'string' ? value : fallback }) };
}
describe('typed agenda and task list cards', () => {
  it('distinguishes a complete empty connected source from unavailable sources', () => {
    const { formatCanonicalAgenda } = fixture();
    const connected = formatCanonicalAgenda({ calendar: { state: 'CONNECTED', events: [] } }, { language: 'en' });
    expect(connected).toContain('No events in this period'); expect(connected).toContain('No pending items found for this period');
    for (const state of ['ERROR', 'DISCONNECTED']) {
      const text = formatCanonicalAgenda({ calendar: { state, events: [] } }, { language: 'en' });
      expect(text).toContain('Your agenda could be incomplete'); expect(text).not.toContain('No pending items found for this period');
    }
    expect(formatCanonicalAgenda({ calendar: { state: 'CONNECTED' }, complete: false }, { language: 'en' })).toContain('Your agenda could be incomplete');
  });
  it('keeps available rows and source-specific failure notices in an incomplete agenda', () => {
    const { formatCanonicalAgenda } = fixture();
    const text = formatCanonicalAgenda({ complete: false, calendar: { state: 'ERROR' }, tasks: [{ title: 'Available task' }], reminders: [{ content: 'Available reminder' }], sources: { tasks: 'ERROR', reminders: 'ERROR' } }, { language: 'en' });
    expect(text).toContain('Available task'); expect(text).toContain('Available reminder'); expect(text).toContain('⚠️ Tasks: temporarily unavailable.'); expect(text).toContain('⚠️ Reminders: temporarily unavailable.');
  });
  it('preserves all-day and already formatted calendar times without recomputing them', () => {
    const { formatCanonicalAgenda, time } = fixture();
    const text = formatCanonicalAgenda({ calendar: { state: 'CONNECTED', events: [{ summary: 'All-day item', isAllDay: true, startDateTime: '2031-01-14T15:00:00Z' }, { summary: 'Formatted item', displayDate: 'Displayed time', startDateTime: '2031-01-14T15:00:00Z' }] } }, { language: 'en' });
    expect(text).toContain('All-day item — All day'); expect(text).toContain('Formatted item — Displayed time'); expect(time).not.toHaveBeenCalled();
  });
  it('reports only rendered completed status for completed-task cards', () => {
    const { formatCanonicalTaskList } = fixture(); const callback = vi.fn();
    const task = Object.freeze({ title: 'Done', status: 'completed', description: 'Hidden notes', due_date: '2031-01-14T15:00:00Z', localTime: '10:00', entities: { name: 'Work' } });
    const text = formatCanonicalTaskList({ tasks: [task], scope: 'today' }, { language: 'en', onTaskRendered: callback });
    expect(text).toContain('1. ~Done~ [Work] _(10:00)_'); expect(text).not.toContain('Hidden notes'); expect(callback).toHaveBeenCalledWith(task, ['status']);
  });
  it('uses raw row callbacks and exact description coverage for a scoped project list', () => {
    const { formatCanonicalTaskList } = fixture(); const callback = vi.fn();
    const task = Object.freeze({ title: 'Pending', description: 'Unchanged notes', due_date: '2031-01-14T15:00:00Z', status: 'pending' });
    const text = formatCanonicalTaskList({ entityName: 'Work', tasks: [task], scope: 'all_pending' }, { language: 'en', timezone: 'America/Bogota', onTaskRendered: callback });
    expect(text).toContain('📁 *Work* · 1 task'); expect(text).toContain('1. Pending — Humanized date'); expect(callback).toHaveBeenCalledWith(task, ['description']); expect(callback.mock.calls[0]?.[0]).toBe(task);
  });
  it('preserves global pending-task numbering and counts in a combined agenda', () => {
    const { formatCanonicalAgenda } = fixture();
    const text = formatCanonicalAgenda({ scope: 'all_pending', calendar: { state: 'DISCONNECTED' }, reminders: [{ content: 'Routine', recurrence_rule: 'daily', send_at: '2031-01-14T15:00:00Z' }], tasks: [{ title: 'First', entityName: 'Work' }, { title: 'Second', entityName: 'Home' }] }, { language: 'en' });
    expect(text).toContain('Current pending items'); expect(text).toContain('_1 reminder · 2 tasks_'); expect(text).toContain('1. Routine · recurring'); expect(text).toContain('1. First'); expect(text).toContain('2. Second');
  });
  it('keeps empty search/project/completed responses distinct', () => {
    const { formatCanonicalTaskList } = fixture();
    expect(formatCanonicalTaskList({ entityName: 'Work', query: 'Report', tasks: [] }, { language: 'en' })).toContain('No pending tasks found for "Report"');
    expect(formatCanonicalTaskList({ entityName: 'Work', tasks: [] }, { language: 'en' })).toContain('No pending tasks in this project');
    expect(formatCanonicalTaskList({ status: 'completed', scope: 'today', tasks: [] }, { language: 'en' })).toContain("You haven't completed any tasks today yet");
  });
  it('passes the supplied timezone to pending reminder and event date formatting', () => {
    const { formatCanonicalAgenda, time } = fixture();
    formatCanonicalAgenda({ calendar: { state: 'CONNECTED', events: [{ startDateTime: '2031-01-14T15:00:00Z' }] }, reminders: [{ content: 'Reminder', sendAt: '2031-01-14T16:00:00Z' }] }, { language: 'es', timezone: 'America/Bogota' });
    expect(time).toHaveBeenCalledWith('2031-01-14T15:00:00Z', 'America/Bogota', 'es'); expect(time).toHaveBeenCalledWith('2031-01-14T16:00:00Z', 'America/Bogota', 'es');
  });
});

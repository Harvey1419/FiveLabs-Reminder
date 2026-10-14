import { describe, expect, it, vi } from 'vitest';
import { createTaskPresentation } from '../../../src/shared/task-card-presentation.js';
const presenter = () => createTaskPresentation({ formatHumanFriendlyDateTime: () => 'Tomorrow 08:00' });
describe('typed canonical task cards', () => {
  it('groups by current project metadata in first-appearance order without changing raw row identity', () => {
    const a = Object.freeze({ title: 'A', entities: { name: 'Primary' }, entityName: 'Ignored' });
    const b = Object.freeze({ title: 'B', projectName: 'Second' });
    const c = Object.freeze({ title: 'C', entityName: 'Primary' });
    const rows = Object.freeze([a, b, c]); const { groupTasksByProject } = presenter();
    const groups = groupTasksByProject(rows, 'en');
    expect([...groups.keys()]).toEqual(['Primary', 'Second']); expect(groups.get('Primary')).toEqual([a, c]); expect(groups.get('Primary')?.[0]).toBe(a); expect(rows).toEqual([a, b, c]);
  });
  it('uses global numbering across grouped projects and keeps one header per project', () => {
    const { formatCanonicalTaskCreate } = presenter();
    const text = formatCanonicalTaskCreate([{ title: 'A', entityName: 'Work' }, { title: 'B', entityName: 'Home' }, { title: 'C', entityName: 'Work' }], { language: 'en' });
    expect(text).toContain('3 tasks created'); expect(text).toContain('1. A'); expect(text).toContain('2. C'); expect(text).toContain('3. B'); expect(text.match(/📁 \*Work\*/g)).toHaveLength(1);
  });
  it('can render a scoped project without repeating raw per-row project tags', () => {
    const { formatTaskProjectGroups } = presenter();
    const text = formatTaskProjectGroups([{ title: 'A', entityName: 'Original' }, { title: 'B', projectName: 'Other' }], { language: 'en', projectName: 'Selected' });
    expect(text).toBe('📁 *Selected*\n• A\n• B');
  });
  it('reports exact raw description and date coverage only for unchanged fully rendered values', () => {
    const { fullyRenderedTaskFields } = presenter();
    const iso = '2031-01-14T15:00:00Z';
    expect(fullyRenderedTaskFields({ description: 'Notes', due_date: iso }, 'Notes', iso)).toEqual(['description', 'due_date']);
    expect(fullyRenderedTaskFields({ description: ' Notes ', due_date: iso }, 'Notes', 'Tomorrow 08:00')).toEqual([]);
    expect(fullyRenderedTaskFields({ description: 'A\nB' }, 'A\nB', null)).toEqual([]);
    expect(fullyRenderedTaskFields({ description: 'x'.repeat(401) }, 'x'.repeat(401), null)).toEqual([]);
    expect(fullyRenderedTaskFields({ notes: 'Notes', dueDate: iso }, 'Notes', iso)).toEqual([]);
  });
  it('reports rendered coverage at the actual row with humanized time excluded', () => {
    const rendered = vi.fn(); const row = Object.freeze({ id: 'a', title: 'A', description: 'Original notes', due_date: '2031-01-14T15:00:00Z' });
    const { formatTaskProjectGroups } = presenter();
    expect(formatTaskProjectGroups([row], { language: 'en', isMultiDay: true, onTaskRendered: rendered })).toContain('Tomorrow 08:00');
    expect(rendered).toHaveBeenCalledWith(row, ['description']);
    expect(rendered.mock.calls[0]?.[0]).toBe(row);
  });
  it('passes user time context to date formatting and avoids it for single-day local times', () => {
    const format = vi.fn(() => 'Localized'); const { getTaskTime } = createTaskPresentation({ formatHumanFriendlyDateTime: format });
    const task = { due_date: '2031-01-14T15:00:00Z', localTime: '10:00' };
    expect(getTaskTime(task, { timezone: 'America/Bogota', language: 'es', isMultiDay: true })).toBe('Localized');
    expect(format).toHaveBeenCalledWith(task.due_date, 'America/Bogota', 'es');
    expect(getTaskTime(task, { isMultiDay: false })).toBe('10:00'); expect(format).toHaveBeenCalledTimes(1);
  });
  it('preserves explicit bulk completion counts and the project without inferring rows', () => {
    const { formatCanonicalTaskComplete } = presenter();
    expect(formatCanonicalTaskComplete({ completedCount: 0, entityName: 'Work', tasks: [{ title: 'Ignored' }] }, { language: 'en' })).toBe('✅ *0 tasks completed*\n\n📁 *Work*');
    expect(formatCanonicalTaskComplete({ completedCount: 1, entityName: 'Trabajo' }, { language: 'es' })).toBe('✅ *1 tarea completada*\n\n📁 *Trabajo*');
  });
  it('retains bilingual notes, empty fallbacks and update/delete semantics', () => {
    const { formatTaskNotesBadge, formatCanonicalTaskCreate, formatCanonicalTaskUpdate, formatCanonicalTaskDelete } = presenter();
    expect(formatTaskNotesBadge({ notes: 'A\n\nB' }, true)).toBe(' 📝 _(2 notes)_'); expect(formatTaskNotesBadge({ description: '   ' })).toBe('');
    expect(formatCanonicalTaskCreate([], { language: 'es' })).toBe('✅ *Tarea creada*');
    expect(formatCanonicalTaskUpdate({ title: 'A', priority: 'urgent' }, { language: 'es' })).toContain('⚡ Prioridad: urgente');
    expect(formatCanonicalTaskUpdate({ title: 'A', priority: 'medium' }, { language: 'en' })).not.toContain('Priority');
    expect(formatCanonicalTaskDelete({ title: 'A', id: 'internal-id' }, { language: 'en' })).toBe('🗑️ *Task deleted*\n\n• A');
  });
});

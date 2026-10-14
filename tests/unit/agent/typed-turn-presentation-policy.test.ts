import { createExecutionFact } from '../../../src/agent/core/execution-facts.js';
import { describe, expect, it, vi } from 'vitest';
import { createTurnPresentation, PRESENTATION_KINDS } from '../../../src/agent/core/turn-presentation-policy.js';
import type { TurnPresentationFact, TurnPresentationDependencies } from '../../../src/agent/core/turn-presentation-policy.js';
function fixture(overrides: Partial<TurnPresentationDependencies> = {}) {
  return createTurnPresentation({
    sanitizeResponseText: value => typeof value === 'string' ? value.replace(/PRIVATE/g, '').trim() : '',
    formatCanonicalTaskCreate: rows => `TASK BATCH ${rows.length}`,
    formatCanonicalReminderCreateBatch: data => `REMINDER BATCH ${data.length}`,
    formatCanonicalReminderCancelBatch: data => `CANCEL BATCH ${data.length}`,
    formatHumanFriendlyDateTime: () => 'Tomorrow 08:00',
    ...overrides,
  });
}
const fact = (overrides: Partial<TurnPresentationFact> = {}): TurnPresentationFact => ({ tool: 'manage_task', requestedAction: 'delete', success: true, complete: true, card: 'Full card', summary: 'Observed', presentationData: { title: 'First', entityName: 'Work' }, presentationContext: { language: 'en', timezone: 'UTC' }, ...overrides });
describe('typed central turn presentation policy', () => {
  it('suppresses empty reads only alongside mutations and retains useful retrieved cards', () => {
    const { composeTurnPresentation } = fixture();
    const empty = fact({ tool: 'manage_google_calendar', requestedAction: 'list_events', presentationData: { events: [] }, card: 'No events scheduled' });
    const read = fact({ requestedAction: 'list', presentationData: { tasks: [{ title: 'Retrieved' }] }, card: 'Retrieved card' });
    expect(composeTurnPresentation([empty, read], 'en')).toContain('No events scheduled');
    const text = composeTurnPresentation([empty, read, fact()], 'en');
    expect(text).not.toContain('No events scheduled'); expect(text).toContain('Retrieved card'); expect(text.indexOf('Retrieved card')).toBeLessThan(text.indexOf('First'));
  });
  it('orders confirmed, partial, clarification, failure and unknown sections separately', () => {
    const { composeTurnPresentation, classifyTurnPresentation } = fixture();
    const facts = [fact({ success: false, outcome: 'unknown', summary: 'Unknown outcome' }), fact({ success: false, summary: 'Hard failure' }), fact({ success: false, requiresClarification: true, card: 'Choose an item' }), fact({ complete: false, summary: 'Some saved' }), fact()];
    const text = composeTurnPresentation(facts, 'en');
    expect(classifyTurnPresentation(facts)).toBe(PRESENTATION_KINDS.PARTIAL_SUCCESS);
    const markers = ['First', 'partially completed', 'Choose an item', 'Hard failure', 'Outcome not confirmed'];
    for (let i = 1; i < markers.length; i++) expect(text.indexOf(markers[i-1]!)).toBeLessThan(text.indexOf(markers[i]!));
    expect(text).toContain('1 action could not be completed');
    expect(text).toContain('Unknown outcome');
  });
  it('preserves partial read content rather than replacing it with a success count', () => {
    const { composeTurnPresentation } = fixture();
    const text = composeTurnPresentation([fact({ requestedAction: 'list', outcome: 'partial_success', card: 'Tasks available\nCalendar unavailable', summary: 'Partial retrieval' })], 'en');
    expect(text).toBe('⚠️ *1 action partially completed*\nTasks available\nCalendar unavailable');
  });
  it('retains the first group appearance and counts affected records instead of detail lines', () => {
    const { composeTurnPresentation } = fixture();
    const text = composeTurnPresentation([fact({ presentationData: [{ title: 'First', entityName: 'Work' }, { title: 'Second', entityName: 'Home' }] }), fact({ tool: 'manage_entity', presentationData: { name: 'Entity' } }), fact({ presentationData: { title: 'Third' } })], 'en');
    expect(text.indexOf('First')).toBeLessThan(text.indexOf('Third'));
    expect(text.indexOf('Third')).toBeLessThan(text.indexOf('Entity'));
    expect(text.match(/Tasks · removed/g)).toHaveLength(1);
    const homogeneous = composeTurnPresentation([fact(), fact({ presentationData: { title: 'Second', entityName: 'Home' } })], 'en');
    expect(homogeneous).toContain('Tasks · 2 removed'); expect(homogeneous).not.toContain('4 removed');
  });
  it('does not count advance-notice rows as separate logical reminders in mixed turns', () => {
    const { composeTurnPresentation } = fixture();
    const text = composeTurnPresentation([fact({ tool: 'manage_reminder', requestedAction: 'create', presentationData: [{ content: 'Appointment', isAdvanceNotice: false }, { content: 'Advance notice', isAdvanceNotice: true }] }), fact()], 'en');
    expect(text).toContain('Appointment'); expect(text).not.toContain('Advance notice'); expect(text).toContain('2 actions completed');
  });
  it('delegates a homogeneous task creation batch once with the original rows and timezone', () => {
    const render = vi.fn(() => 'One canonical collection'); const { composeTurnPresentation } = fixture({ formatCanonicalTaskCreate: render });
    const first = { title: 'First' }, second = { title: 'Second' };
    expect(composeTurnPresentation([fact({ requestedAction: 'create', presentationData: { tasks: [first] } }), fact({ requestedAction: 'create', presentationData: [second] })], 'en')).toBe('One canonical collection');
    expect(render).toHaveBeenCalledTimes(1); expect(render).toHaveBeenCalledWith([first, second], { language: 'en', timezone: 'UTC' });
    expect(render.mock.calls[0]).toBeDefined();
  });
  it('keeps explicit confirmation requests intact without a generic clarification heading', () => {
    const { composeTurnPresentation } = fixture();
    const text = composeTurnPresentation([fact({ success: false, requiresClarification: true, errorCode: 'CONFIRMATION_REQUIRED', card: 'Confirm delete?' }), fact({ success: false, requiresClarification: true, card: 'Confirmation needed: cancel?' })], 'en');
    expect(text).toBe('Confirm delete?\n\nConfirmation needed: cancel?');
  });
  it('handles an empty turn and preserves a single card without re-aggregating or mutating it', () => {
    const { composeTurnPresentation, getFactDomain } = fixture();
    const single = Object.freeze(fact({ card: 'Original card' }));
    expect(composeTurnPresentation([null, false, undefined])).toBe('');
    expect(composeTurnPresentation([single], 'en')).toBe('Original card');
    expect(getFactDomain({ tool: 'unregistered-tool' })).toBe('other');
  });
  it('accepts typed observed collection payloads through the fact and policy boundary', () => {
    const { composeTurnPresentation } = fixture();
    const observed = createExecutionFact({ toolName: 'manage_reminder', params: { action: 'create' }, result: { success: true, data: [{ content: 'Appointment', sendAt: '2031-01-14T15:00:00Z' }] }, language: 'en' });
    const text = composeTurnPresentation([observed, fact()], 'en');
    expect(text).toContain('Appointment'); expect(text).toContain('First');
  });

});

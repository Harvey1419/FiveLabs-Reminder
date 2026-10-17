import { describe, expect, it } from 'vitest';
import type { AIMessage } from '@templelabs/contracts';
import { projectProductivityHistory } from '../../../packages/agent-core/src/productivity-model-context.js';

describe('model-only historical evidence boundary', () => {
  it('keeps names and IDs for follow-ups while distinguishing past reads from the active read', () => {
    const observation = JSON.stringify({ operation: 'read', complete: true, events: [
      { id: 'owned-event', kind: 'all_day', summary: 'Cumpleaños de Trena', startDate: '2027-01-02', endDateExclusive: '2027-01-03' },
    ] });
    const history: AIMessage[] = [
      { role: 'user', content: 'Muéstrame mis eventos.' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'past', name: 'calendar_read', arguments: {} }] },
      { role: 'tool', toolCallId: 'past', isError: false, content: { status: 'success', observation } },
      { role: 'assistant', content: 'Cumpleaños de Trena', toolCalls: [] },
      { role: 'user', content: 'Trina no trena' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'current', name: 'calendar_read', arguments: { scope: '2027-01-02' } }] },
      { role: 'tool', toolCallId: 'current', isError: false, content: { status: 'success', observation } },
    ];
    const before = structuredClone(history), projected = projectProductivityHistory(history, 4);
    expect(projected[2]).toMatchObject({ content: { freshness: 'historical', currentTurnEvidence: false,
      observation: { events: [{ id: 'owned-event', summary: 'Cumpleaños de Trena', time: '2027-01-02' }] } } });
    expect(projected[4]).toEqual(history[4]);
    expect(projected[6]).not.toMatchObject({ content: { freshness: 'historical' } });
    expect(history).toEqual(before);
  });
});

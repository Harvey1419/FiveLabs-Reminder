import { describe, expect, it } from 'vitest';
import { type AIMessage, type MemoryRecord } from '@templelabs/contracts';
import { projectForgottenMemoryHistory } from '../../../packages/agent-core/src/forgotten-memory-context.js';
const record: MemoryRecord = { id: '11111111-1111-4111-8111-111111111111', content: 'Prefiero "café"', category: 'preference', topicKey: 'food:coffee', status: 'forgotten' };
describe('forgotten facts are removed from model projections while audit remains durable', () => {
  it('redacts old statements and JSON-escaped observations but permits fresh authored restatements', () => {
    const history: AIMessage[] = [{ role: 'user', content: 'Recuerda: ' + record.content },
      { role: 'assistant', content: '', toolCalls: [{ id: 'save', name: 'memory_save', arguments: { content: record.content } }] },
      { role: 'tool', toolCallId: 'save', isError: false, content: {
        status: 'success', observation: JSON.stringify({ records: [{ ...record, status: 'active', content: record.content.slice(0, 4) }] }),
      } }, { role: 'user', content: 'Recuerda de nuevo: ' + record.content }];
    const original = structuredClone(history);
    const result = projectForgottenMemoryHistory(history, 3, [record]);
    expect(JSON.stringify(result.slice(0, 3))).not.toContain('Prefiero');
    expect(JSON.stringify(result.slice(0, 3))).toContain('[forgotten memory]');
    expect(result[3]).toEqual(history[3]); expect(history).toEqual(original);
  });
  it('leaves active memories and unrelated audit evidence unchanged', () => {
    const history: AIMessage[] = [{ role: 'user', content: 'Unrelated request' }];
    expect(projectForgottenMemoryHistory(history, 1, [{ ...record, status: 'active' }])).toEqual(history);
  });
});

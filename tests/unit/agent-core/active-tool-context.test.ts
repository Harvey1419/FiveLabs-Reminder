import { describe, expect, it } from 'vitest';
import { activeToolContextCandidates } from '../../../packages/agent-core/src/active-tool-context.js';
import type { AIMessage } from '@templelabs/contracts';
const history: AIMessage[] = [
  { role: 'user', content: 'Crea dos recordatorios y una tarea' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'reminder_create', arguments: { content: 'Salir', targetTimeIso: '2026-10-15T15:10:00Z' } }] },
  { role: 'tool', toolCallId: 'call-1', isError: false, content: { status: 'success', observation: { complete: true, records: [{ id: 'owned', content: 'Salir', time: '2026-10-15T15:10:00Z' }] } } },
];
describe('active-turn projection at verified tool batch boundaries', () => {
  it('retains authored request and owned resource facts while leaving durable evidence untouched', () => {
    const original = structuredClone(history); const projected = activeToolContextCandidates(history, 'owner');
    expect(projected).toHaveLength(1); expect(projected[0]!.history).toEqual([history[0]]);
    expect(JSON.parse(projected[0]!.summary).completedActiveTools).toMatchObject({ userId: 'owner', grantsAuthorization: false, operationCount: 1,
      operations: [{ toolName: 'reminder_create', resources: [{ id: 'owned', content: 'Salir' }] }] });
    expect(history).toEqual(original);
  });
  it.each(['partial','indeterminate','approval_required','clarification_required','failed'])('never folds %s effects', status => {
    const copy = structuredClone(history); copy[2] = { role: 'tool', toolCallId: 'call-1', isError: false, content: { status, observation: {} } };
    expect(activeToolContextCandidates(copy,'owner')).toEqual([]);
  });
  it('never folds an incomplete batch or orphaned tool response', () => {
    expect(activeToolContextCandidates(history.slice(0,2),'owner')).toEqual([]);
    const copy=structuredClone(history); copy[2]={role:'tool',toolCallId:'foreign-call',isError:false,content:{status:'success'}};
    expect(activeToolContextCandidates(copy,'owner')).toEqual([]);
  });
});

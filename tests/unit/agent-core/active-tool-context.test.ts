import { describe, expect, it } from 'vitest';
import { activeToolContextCandidates } from '../../../packages/agent-core/src/active-tool-context.js';
import { projectProductivityHistory } from '../../../packages/agent-core/src/productivity-model-context.js';
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
  it.each([false, true])('retains unresolved decision facts while folding verified domain work (shared batch=%s)', sharedBatch => {
    const plan = { id: 'plan', name: 'conversation_decide', arguments: { ready: [{ key: 'r', tool: 'reminder_create' }, { key: 't', tool: 'task_create' }],
      pending: { tool: 'reminder_create', missing: 'date', knownArguments: { content: 'Informe' } } } };
    const declaration: AIMessage = { role: 'assistant', content: '', toolCalls: [plan] };
    const recorded: AIMessage = { role: 'tool', toolCallId: 'plan', isError: false, content: { status: 'decision_recorded', execution: false } };
    const write = history[1]!; if (write.role !== 'assistant') throw new Error('Invalid fixture');
    const input: AIMessage[] = sharedBatch ? [history[0]!, { ...write, toolCalls: [plan, ...write.toolCalls] }, recorded, history[2]!]
      : [history[0]!, declaration, recorded, ...history.slice(1)];
    const original = structuredClone(input);
    const result = activeToolContextCandidates(input, 'owner').at(-1);
    expect(result).toBeDefined(); expect(result!.history).toEqual([history[0], declaration, recorded]);
    expect(JSON.parse(result!.summary).completedActiveTools).toMatchObject({ operationCount: 1, grantsAuthorization: false,
      operations: [{ toolName: 'reminder_create', resources: [{ id: 'owned', content: 'Salir' }] }] });
    expect(input).toEqual(original);
  });
  it('retains mixed agenda record domains through both model compaction layers', () => {
    const copy: AIMessage[] = [
      { role: 'user', content: 'Consulta mañana y completa la tarea Revisar contrato, no el recordatorio' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'agenda', name: 'agenda_read', arguments: { scope: 'tomorrow' } }] },
      { role: 'tool', toolCallId: 'agenda', isError: false, content: { status: 'success', observation: JSON.stringify({
        complete: true, records: [
          { id: 'reminder', domain: 'reminders', title: 'Revisar contrato', time: '2026-10-15T15:00:00Z' },
          { id: 'task', domain: 'tasks', title: 'Revisar contrato', time: '2026-10-15T15:00:00Z' },
        ],
      }) } },
    ];
    const original = structuredClone(copy);
    const candidates = activeToolContextCandidates(projectProductivityHistory(copy), 'owner');
    expect(candidates).toHaveLength(1);
    const summary = JSON.parse(candidates[0]!.summary).completedActiveTools;
    expect(summary.operations).toEqual([{ toolName: 'agenda_read', status: 'success', observedResourceCount: 2, resources: [
      { id: 'reminder', domain: 'reminders', title: 'Revisar contrato', time: '2026-10-15T15:00:00Z' },
      { id: 'task', domain: 'tasks', title: 'Revisar contrato', time: '2026-10-15T15:00:00Z' },
    ] }]);
    expect(summary.grantsAuthorization).toBe(false);
    expect(candidates[0]!.history).toEqual([copy[0]]);
    expect(copy).toEqual(original);
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
  it('folds a confirmed replay without counting or discarding the original receipt', () => {
    const copy: AIMessage[] = [...structuredClone(history),
      { role: 'assistant', content: '', toolCalls: [{ id: 'retry', name: 'reminder_create', arguments: {} }] },
      { role: 'tool', toolCallId: 'retry', isError: false, content: { status: 'success', code: 'WRITE_ALREADY_CONFIRMED', earlierCallId: 'call-1', observation: {} } },
    ];
    const result = activeToolContextCandidates(copy, 'owner').at(-1)!;
    expect(JSON.parse(result.summary).completedActiveTools).toMatchObject({ operationCount: 1 });
    expect(result.history).toEqual([copy[0]]);
  });
});

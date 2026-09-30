import { describe, expect, it } from 'vitest';
import { assertNoAmounts, assertReadFailureEvidence, assertTaskReadEvidence } from '../../helpers/state-authority.js';

const read = (records) => ({
  confirmation: 'Registro consultado.',
  executionFacts: [{ tool: 'manage_task', requestedAction: 'list', action: 'listed_tasks', success: true,
    presentationData: { tasks: records } }],
});

describe('live-state evidence assertions (not a mocked semantic evaluation)', () => {
  it('rejects ungrounded chat even when it contains the correct number', () => {
    expect(() => assertTaskReadEvidence({ confirmation: '720.000', executionFacts: [] })).toThrow();
  });
  it('accepts records from the current read', () => {
    expect(() => assertTaskReadEvidence(read([{ id: 'task-a' }]), { expectedIds: ['task-a'] })).not.toThrow();
  });
  it('rejects evidence for a different record', () => {
    expect(() => assertTaskReadEvidence(read([{ id: 'task-b' }]), { expectedIds: ['task-a'] })).toThrow();
  });
  it('rejects a memory lookup as evidence of current task state', () => {
    expect(() => assertTaskReadEvidence({ executionFacts: [{ tool: 'manage_memory', success: true }] })).toThrow();
  });
  it.each(['190.000', '190,000', '190\u202f000', '190000'])('detects stale amount %s', (value) => {
    expect(() => assertNoAmounts({ confirmation: `Saldo ${value} pesos.` }, [190000])).toThrow();
  });
  it('keeps a failed read distinct from an empty successful read', () => {
    expect(() => assertReadFailureEvidence(read([]))).toThrow();
    expect(() => assertReadFailureEvidence({ executionFacts: [{ tool: 'manage_task', success: false }] })).not.toThrow();
  });
  it('does not report an embedded digit sequence as a standalone amount', () => {
    expect(() => assertNoAmounts({ confirmation: '11900001' }, [190000])).not.toThrow();
  });
});

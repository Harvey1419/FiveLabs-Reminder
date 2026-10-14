import { describe, expect, it } from 'vitest';
import { formatActiveRunPrompt } from '../../../src/agent/core/agent-run.js';
import { CONTINUATION_DECISION_SCHEMA, validateContinuationDecision } from '../../../src/agent/contracts/agent-run-contracts.js';

describe('suspended provider response shape', () => {
  it('supplies a complete nullable delta template derived from the provider contract', () => {
    const fields = Object.fromEntries(CONTINUATION_DECISION_SCHEMA.properties!.actionInputs!.items!.properties!.fields!.required!.map(key => [key, null]));
    const prompt = formatActiveRunPrompt({ id: 'synthetic-run', kind: 'turn', status: 'waiting_for_input', preparedActions: [{ call_id: 'call-1', target_id: null, target_name: null, domain: 'reminder', action: 'create', payload: { content: 'Report' } }] });
    expect(prompt).toContain(JSON.stringify(fields));
    expect(prompt).toContain('No emitas TurnIntent/actions');
    expect(validateContinuationDecision({ responseLanguage: 'en', relation: 'resume', actionInputs: [{ callId: 'call-1', fields: { ...fields, content: 'Final report' } }] })).toMatchObject({ valid: true, decision: { actionInputs: [{ callId: 'call-1', fields: { content: 'Final report' } }] } });
  });
});

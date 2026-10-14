import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { LegacyActiveRun, LegacyPreparedAction } from '../../../src/agent/core/active-run-executor.js';
import { AGENT_RUN_TTL_MS, createLegacyRunLifecycle, type LegacyRunLifecycleStorage } from '../../../src/agent/core/active-run-lifecycle.js';

const promptFixture = z.object({ keys: z.array(z.string()), input: z.string(), approval: z.string() }).parse(
  JSON.parse(readFileSync(new URL('../../fixtures/agent-core/active-run-prompt-before-typescript.json', import.meta.url), 'utf8')),
);
const user = { id: 'owner', phone_number: 'thread', timezone: 'America/Bogota' };
const referenceTime = new Date('2026-10-12T12:00:00Z');
const candidate: LegacyActiveRun = { id: 'candidate', user_id: 'owner', thread_id: 'thread', kind: 'generic_operation',
  status: 'failed', context: {}, waiting_for: null, expires_at: '2026-10-13T00:00:00Z' };
const draft = { domain: 'reminder', action: 'create', content: 'Llamar',
  schedule: { kind: 'relative_day_time', dayOffset: 1 }, deliveryPolicy: { leadMinutes: 15 } };
const staged: LegacyPreparedAction = { run_id: candidate.id, call_id: 'call-1', domain: 'reminder', action: 'create',
  target_id: null, target_name: 'Llamar', payload: draft, status: 'prepared', execution_fact: null };
function fixture(existing: LegacyActiveRun | null = null) {
  const order: string[] = [];
  const storage: LegacyRunLifecycleStorage = {
    getActiveRun: vi.fn(async () => existing),
    getPreparedActions: vi.fn(async () => [staged]),
    createRun: vi.fn(async () => { order.push('create-inert'); return candidate; }),
    stagePreparedActions: vi.fn(async () => { order.push('stage'); return [staged]; }),
    updateRun: vi.fn(async () => { order.push('cleanup'); return {}; }),
    updateRunIfStatus: vi.fn(async change => { order.push(`${change.runId}:${change.expectedStatus}->${change.nextStatus}`); return true; }),
    cancelActiveInputRun: vi.fn(async () => { order.push('retire-exact'); return true; }),
    recordEvent: vi.fn(async () => { order.push('event'); return {}; }),
  };
  return { storage, order, lifecycle: createLegacyRunLifecycle(storage, promptFixture.keys) };
}
const inputOptions = { user, referenceTime, partialAction: draft, missingFields: ['schedule'], timezone: user.timezone };
const old = { ...candidate, id: 'old', status: 'waiting_for_input' };

describe('strict suspended-run lifecycle', () => {
  it('scopes lookup by trimmed user and thread identifiers and joins prepared actions', async () => {
    const f = fixture(candidate);
    expect(await f.lifecycle.getActiveAgentRun({ id: ' owner ', phone_number: ' thread ' }, referenceTime)).toEqual({ ...candidate, preparedActions: [staged] });
    expect(f.storage.getActiveRun).toHaveBeenCalledWith('thread', 'owner', referenceTime);
    await f.lifecycle.getActiveAgentRun(' phone ', referenceTime);
    expect(f.storage.getActiveRun).toHaveBeenLastCalledWith('phone', null, referenceTime);
  });

  it.each(['input', 'approval'] as const)('keeps a running request untouched when creating %s', async kind => {
    const f = fixture({ ...candidate, status: 'running' });
    const result = kind === 'input' ? await f.lifecycle.createInputRun(inputOptions)
      : await f.lifecycle.createApprovalRun({ user, referenceTime, preparedActions: [] });
    expect(result).toBeNull(); expect(f.storage.createRun).not.toHaveBeenCalled();
  });

  it('stages a replacement before retiring the original and preserves the temporal anchor', async () => {
    const f = fixture(old);
    const result = await f.lifecycle.createInputRun(inputOptions);
    expect(f.order).toEqual(['create-inert', 'stage', 'old:waiting_for_input->cancelled', 'candidate:failed->waiting_for_input', 'event']);
    expect(result).toMatchObject({ status: 'waiting_for_input', preparedActions: [staged] });
    expect(f.storage.createRun).toHaveBeenCalledWith(expect.objectContaining({ initialStatus: 'failed',
      context: { referenceTime: referenceTime.toISOString(), timezone: user.timezone },
      expiresAt: new Date(referenceTime.getTime() + AGENT_RUN_TTL_MS).toISOString(),
    }));
  });

  it('keeps an approval candidate inert until its actions are staged and its predecessor is retired', async () => {
    const f = fixture(old);
    const result = await f.lifecycle.createApprovalRun({ user, referenceTime, question: '  ¿Confirmas?  ',
      preparedActions: [{ callId: 'a', domain: 'task', action: 'delete', payload: { action: 'delete' } }] });
    expect(result?.status).toBe('waiting_for_approval');
    expect(f.order).toEqual(['create-inert', 'stage', 'old:waiting_for_input->cancelled', 'candidate:failed->waiting_for_approval', 'event']);
    expect(f.storage.createRun).toHaveBeenCalledWith(expect.objectContaining({ initialStatus: 'failed',
      waitingFor: { type: 'approval', question: '¿Confirmas?' } }));
  });

  it.each(['input', 'approval'] as const)('preserves the original when %s staging fails', async kind => {
    const f = fixture(old), primary = new Error('staging failed');
    vi.mocked(f.storage.stagePreparedActions).mockRejectedValue(primary);
    const pending = kind === 'input' ? f.lifecycle.createInputRun(inputOptions)
      : f.lifecycle.createApprovalRun({ user, referenceTime, preparedActions: [] });
    await expect(pending).rejects.toBe(primary);
    expect(f.order).toEqual(['create-inert', 'cleanup']);
    expect(f.storage.updateRun).toHaveBeenCalledWith('candidate', { status: 'failed' });
    expect(f.storage.updateRunIfStatus).not.toHaveBeenCalled();
  });

  it.each([new Error('primary'), Object.freeze(new Error('frozen primary')), 'primitive primary'])('preserves the primary error if cleanup also fails: %s', async primary => {
    const f = fixture(old);
    vi.mocked(f.storage.stagePreparedActions).mockRejectedValue(primary);
    vi.mocked(f.storage.updateRun).mockRejectedValue(new Error('cleanup unavailable'));
    await expect(f.lifecycle.createInputRun(inputOptions)).rejects.toBe(primary);
    expect(f.storage.cancelActiveInputRun).not.toHaveBeenCalled();
    expect(f.storage.updateRunIfStatus).not.toHaveBeenCalled();
    if (primary instanceof Error && !Object.isFrozen(primary)) expect(primary).toHaveProperty('cleanupError');
  });

  it('does not activate a replacement when exact retirement loses its compare-and-set', async () => {
    const f = fixture(old);
    vi.mocked(f.storage.cancelActiveInputRun).mockResolvedValue(false);
    expect(await f.lifecycle.createInputRun({ ...inputOptions, supersedesRunId: old.id })).toBeNull();
    expect(f.order).toEqual(['create-inert', 'stage']);
    expect(f.storage.updateRunIfStatus).not.toHaveBeenCalled();
    expect(f.storage.cancelActiveInputRun).toHaveBeenCalledWith(expect.objectContaining({ runId: old.id, expectedStatus: old.status, userId: user.id, threadId: user.phone_number }));
  });

  it('leaves retirement errors observable without a second cleanup or activation', async () => {
    const f = fixture(old), error = new Error('retirement outcome lost');
    vi.mocked(f.storage.cancelActiveInputRun).mockRejectedValue(error);
    await expect(f.lifecycle.createInputRun({ ...inputOptions, supersedesRunId: old.id })).rejects.toBe(error);
    expect(f.storage.updateRun).not.toHaveBeenCalled();
    expect(f.storage.updateRunIfStatus).not.toHaveBeenCalled();
  });

  it('marks uncertain activation and makes only the existing conditional demotion attempt', async () => {
    const f = fixture();
    vi.mocked(f.storage.updateRunIfStatus).mockRejectedValueOnce(new Error('activation reply lost')).mockRejectedValueOnce(new Error('demotion reply lost'));
    expect(await f.lifecycle.createInputRun(inputOptions)).toMatchObject({ status: 'failed', activationFailed: true, activationStatusUnknown: true, preparedActions: [staged] });
    expect(f.storage.updateRunIfStatus).toHaveBeenCalledTimes(2);
    expect(f.storage.updateRunIfStatus).toHaveBeenLastCalledWith(expect.objectContaining({ expectedStatus: 'waiting_for_input', nextStatus: 'failed' }));
    expect(f.storage.recordEvent).not.toHaveBeenCalled();
  });

  it('reports an activation refusal while retaining the staged payload', async () => {
    const f = fixture(); vi.mocked(f.storage.updateRunIfStatus).mockResolvedValue(false);
    expect(await f.lifecycle.createInputRun(inputOptions)).toMatchObject({ activationFailed: true, preparedActions: [staged] });
    expect(f.storage.updateRunIfStatus).toHaveBeenCalledTimes(1); expect(f.storage.recordEvent).not.toHaveBeenCalled();
  });

  it('respects explicit preservation of the previous active run', async () => {
    const f = fixture(old);
    await f.lifecycle.createInputRun({ ...inputOptions, preserveExistingActiveRun: true });
    expect(f.order).toEqual(['create-inert', 'stage', 'candidate:failed->waiting_for_input', 'event']);
  });

  it('cancels only the exact currently pending run', async () => {
    const f = fixture(old);
    expect(await f.lifecycle.cancelSupersededInputRun(user, 'foreign', referenceTime)).toBe(false);
    expect(f.storage.cancelActiveInputRun).not.toHaveBeenCalled();
    expect(await f.lifecycle.cancelSupersededInputRun(user, old.id, referenceTime)).toBe(true);
    expect(f.storage.cancelActiveInputRun).toHaveBeenCalledWith(expect.objectContaining({ runId: old.id, expectedStatus: old.status }));
  });

  it('rejects a foreign owner before attempting execution acquisition', async () => {
    const f = fixture();
    expect(await f.lifecycle.claimPendingRun(candidate, 'waiting_for_approval', { user: { id: 'foreign' } })).toBe(false);
    expect(f.storage.updateRunIfStatus).not.toHaveBeenCalled();
  });

  it('retains the complete pre-migration approval and continuation prompts byte for byte', () => {
    const f = fixture();
    const run = { ...candidate, context: { referenceTime: referenceTime.toISOString(), timezone: user.timezone },
      waiting_for: { fields: ['schedule'], question: '¿A qué hora?' }, preparedActions: [staged] };
    expect(f.lifecycle.formatActiveRunPrompt({ ...run, status: 'waiting_for_input' })).toBe(promptFixture.input);
    expect(f.lifecycle.formatActiveRunPrompt({ ...run, status: 'waiting_for_approval' })).toBe(promptFixture.approval);
    expect(f.lifecycle.formatActiveRunPrompt(null)).toBe('');
  });

  it('uses host methods replaced after construction, matching the legacy live binding', async () => {
    const f = fixture();
    const current = vi.fn(async () => old);
    f.storage.getActiveRun = current;
    expect(await f.lifecycle.getActiveAgentRun(user, referenceTime)).toMatchObject({ id: old.id });
    expect(current).toHaveBeenCalledOnce();
  });
});

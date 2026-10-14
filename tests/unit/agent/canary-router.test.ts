import { describe, it, expect, vi } from 'vitest';
import { readCanaryPolicy, selectCanaryEngine, type CanaryPolicy } from '../../../src/agent/orchestration/canary-selector.js';
import { createCanaryRouter } from '../../../src/agent/orchestration/canary-router.js';
import type { InboundTurnLease } from '../../../src/agent/core/turn-lease.js';
import type { InboundStoredTurn } from '../../../src/adapters/agent-core/inbound-checkpoint-reader.js';
import { setup, response } from '../agent-core/productivity-fixtures.js';

const user = { id: 'owner', timezone: 'America/Bogota', locale: 'es-CO' };
const manifest = JSON.stringify({ version: 1, targeting: { percentage: 0, userAllowlist: ['owner'] } });
const options = { inputModality: 'text', agentCoreDelivery: { send: vi.fn(async () => ({ messageId: 'accepted' })) } };
function fixture(policy: CanaryPolicy = { enabled: true, userAllowlist: ['owner'] }) {
  const baseline = vi.fn(async () => ({ engine: 'baseline' }));
  const v2 = vi.fn(async () => ({ engine: 'v2' }));
  const lease: InboundTurnLease = { inboundTurn: { id: 'current', messageId: 'current-message', threadId: 'thread', response: {} },
    signal: new AbortController().signal, assertActive: vi.fn(async () => {}), checkpoint: vi.fn(async () => {}) };
  const readPrior = vi.fn(async (): Promise<InboundStoredTurn | null> => null);
  const deps = { baseline, v2, lease: vi.fn((): InboundTurnLease | null => lease), readPrior, policy: () => policy };
  return { route: createCanaryRouter(deps), deps, lease, policy, baseline, v2, readPrior };
}
async function completedV2(): Promise<InboundStoredTurn> {
  const f = setup([response()]); await f.run();
  return { id: 'run', message_id: 'request', thread_id: 'thread', sequence_id: 1, status: 'completed', response: f.snapshot() };
}

describe('canary configuration and authenticated admission', () => {
  it.each([undefined, 'false', 'TRUE', '1', ' true '])('switch %s disables all traffic without reading config', value => {
    const read = vi.fn(() => manifest);
    expect(readCanaryPolicy(value === undefined ? {} : { AGENT_CORE_V2: value }, read)).toEqual({ enabled: false, userAllowlist: [] });
    expect(read).not.toHaveBeenCalled();
  });
  it('reads the manifest allowlist with exact owner matching', () => {
    const policy = readCanaryPolicy({ AGENT_CORE_V2: 'true' }, () => manifest);
    expect(selectCanaryEngine(policy, user)).toBe('v2');
    for (const other of [{ id: 'other' }, { id: 'OWNER' }, { id: ' owner' }, 'owner', null, {}]) expect(selectCanaryEngine(policy, other)).toBe('baseline');
  });
  it.each(['percentage', 'wildcard'] as const)('global %s targeting admits every authenticated owner only while enabled', mode => {
    const config = JSON.stringify({ version: 1, targeting: { percentage: mode === 'percentage' ? 100 : 0, userAllowlist: mode === 'wildcard' ? ['*'] : [] } });
    const enabled = readCanaryPolicy({ AGENT_CORE_V2: 'true' }, () => config);
    for (const id of ['owner', 'another-tester', 'third-tester']) expect(selectCanaryEngine(enabled, { id })).toBe('v2');
    for (const invalid of [null, {}, { id: '' }, 'owner']) expect(selectCanaryEngine(enabled, invalid)).toBe('baseline');
    expect(selectCanaryEngine(readCanaryPolicy({ AGENT_CORE_V2: 'false' }, () => config), user)).toBe('baseline');
  });
  it('an environment allowlist replaces percentage 100 and can explicitly clear global admission', () => {
    const config = JSON.stringify({ version: 1, targeting: { percentage: 100, userAllowlist: [] } });
    expect(selectCanaryEngine(readCanaryPolicy({ AGENT_CORE_V2: 'true', AGENT_CORE_V2_ALLOWLIST: '[]' }, () => config), user)).toBe('baseline');
    const selected = readCanaryPolicy({ AGENT_CORE_V2: 'true', AGENT_CORE_V2_ALLOWLIST: '["owner"]' }, () => config);
    expect(selectCanaryEngine(selected, user)).toBe('v2'); expect(selectCanaryEngine(selected, { id: 'other' })).toBe('baseline');
    expect(selectCanaryEngine(readCanaryPolicy({ AGENT_CORE_V2: 'true', AGENT_CORE_V2_ALLOWLIST: '["*"]' }, () => manifest), { id: 'other' })).toBe('v2');
  });
  it.each(['percentage', 'wildcard'] as const)('global %s policy routes leased tester turns to V2 and rolls back on the next turn', async mode => {
    const f = fixture(mode === 'percentage' ? { enabled: true, userAllowlist: [], percentage: 100 } : { enabled: true, userAllowlist: ['*'] });
    for (const id of ['first-tester', 'second-tester', 'third-tester']) {
      f.deps.lease.mockReturnValue({ ...f.lease, inboundTurn: { ...f.lease.inboundTurn, id, messageId: id } });
      expect(await f.route('Turn', { ...user, id }, [], options)).toEqual({ engine: 'v2' });
    }
    f.policy.enabled = false;
    f.deps.lease.mockReturnValue({ ...f.lease, inboundTurn: { ...f.lease.inboundTurn, id: 'rollback', messageId: 'rollback' } });
    expect(await f.route('Next', user, [], options)).toEqual({ engine: 'baseline' });
    expect(f.v2).toHaveBeenCalledTimes(3); expect(f.baseline).toHaveBeenCalledOnce(); expect(f.lease.checkpoint).not.toHaveBeenCalled();
  });
  it('environment JSON override replaces rather than expands the manifest allowlist', () => {
    expect(readCanaryPolicy({ AGENT_CORE_V2: 'true', AGENT_CORE_V2_ALLOWLIST: '[]' }, () => manifest).userAllowlist).toEqual([]);
    const policy = readCanaryPolicy({ AGENT_CORE_V2: 'true', AGENT_CORE_V2_ALLOWLIST: '["other"]' }, () => manifest);
    expect(selectCanaryEngine(policy, user)).toBe('baseline'); expect(selectCanaryEngine(policy, { id: 'other' })).toBe('v2');
  });
  it.each(['invalid', '{}', '{"version":1,"targeting":{"percentage":1,"userAllowlist":["owner"]}}'])('invalid manifest %s fails closed', invalid => {
    expect(readCanaryPolicy({ AGENT_CORE_V2: 'true' }, () => invalid).enabled).toBe(false);
  });
  it.each(['owner', '[1]', 'null'])('invalid override %s fails closed', invalid => {
    expect(readCanaryPolicy({ AGENT_CORE_V2: 'true', AGENT_CORE_V2_ALLOWLIST: invalid }, () => manifest).enabled).toBe(false);
  });
  it('missing config fails closed', () => {
    expect(readCanaryPolicy({ AGENT_CORE_V2: 'true' }, () => { throw new Error('ENOENT'); }).enabled).toBe(false);
  });
  it('disabled policy preserves baseline arguments and does not execute V2 or checkpoint', async () => {
    const f = fixture({ enabled: false, userAllowlist: ['owner'] }); const history = [{ role: 'user', content: 'Earlier' }];
    expect(await f.route('Turn', user, history, options)).toEqual({ engine: 'baseline' });
    expect(f.baseline).toHaveBeenCalledExactlyOnceWith('Turn', user, history, options);
    expect(f.v2).not.toHaveBeenCalled(); expect(f.lease.checkpoint).not.toHaveBeenCalled();
  });
  it('admits only the allowlisted owner into V2 on an authenticated new conversation', async () => {
    const f = fixture(); expect(await f.route('Turn', user, [], options)).toEqual({ engine: 'v2' });
    f.deps.lease.mockReturnValue({ ...f.lease, inboundTurn: { ...f.lease.inboundTurn, id: 'other-turn' } });
    expect(await f.route('Turn', { ...user, id: 'other' }, [], options)).toEqual({ engine: 'baseline' });
    expect(f.v2).toHaveBeenCalledTimes(1); expect(f.baseline).toHaveBeenCalledTimes(1);
  });
  it('reads policy per turn and rolls back immediately without V2 side effects or checkpoint resets', async () => {
    const f = fixture(); await f.route('First', user, [], options);
    f.deps.lease.mockReturnValue({ ...f.lease, inboundTurn: { ...f.lease.inboundTurn, id: 'next', messageId: 'next-message' } });
    f.policy.enabled = false; expect(await f.route('Next', user, [], options)).toEqual({ engine: 'baseline' });
    expect(f.v2).toHaveBeenCalledTimes(1); expect(f.lease.checkpoint).not.toHaveBeenCalled();
  });
  it('preserves baseline callers without a durable lease', async () => {
    const f = fixture(); f.deps.lease.mockReturnValue(null); await f.route('Turn', user, [], options);
    expect(f.baseline).toHaveBeenCalledOnce(); expect(f.v2).not.toHaveBeenCalled(); expect(f.readPrior).not.toHaveBeenCalled();
  });
  it('keeps an existing baseline conversation pinned instead of reconstructing a V2 handoff from chat prose', async () => {
    const f = fixture(); f.readPrior.mockResolvedValue({ id: 'prior', message_id: 'prior-message', thread_id: 'thread', sequence_id: 1, status: 'completed', response: { confirmation: 'Done' } });
    await f.route('Turn', user, [], options); expect(f.baseline).toHaveBeenCalledOnce(); expect(f.v2).not.toHaveBeenCalled();
  });
  it('hands off a completed baseline turn only through the verified host port and preserves references', async () => {
    const f = fixture(); const prior: InboundStoredTurn = { id: 'prior', message_id: 'prior-message', thread_id: 'thread', sequence_id: 1, status: 'completed', response: { confirmation: 'Done' } };
    f.readPrior.mockResolvedValue(prior);
    const handoff = vi.fn(async () => ({ userId: 'owner', history: [], tasks: [], reminders: [], events: [], handledRequestIds: ['prior-message'], referenceOrder: [] }));
    const route = createCanaryRouter({ ...f.deps, handoff });
    await route('Next', user, [], options);
    expect(f.baseline).not.toHaveBeenCalled(); expect(f.v2).toHaveBeenCalledOnce();
    expect(f.v2.mock.calls[0]).toBeDefined();
    expect(handoff).toHaveBeenCalledWith(prior, expect.objectContaining({ userId: 'owner' }), 'thread', []);
    f.policy.enabled = false;
    f.deps.lease.mockReturnValue({ ...f.lease, inboundTurn: { ...f.lease.inboundTurn, id: 'rollback', messageId: 'rollback' } });
    await route('Rollback', user, [], options);
    expect(handoff).toHaveBeenCalledOnce(); expect(f.baseline).toHaveBeenCalledOnce();
  });
  it('does not admit V2 or fall back after a failed handoff read', async () => {
    const f = fixture(); f.readPrior.mockResolvedValue({ id: 'prior', message_id: 'prior-message', thread_id: 'thread', sequence_id: 1, status: 'completed', response: {} });
    const route = createCanaryRouter({ ...f.deps, handoff: async () => { throw new Error('storage unavailable'); } });
    await expect(route('Next', user, [], options)).rejects.toThrow('storage unavailable');
    expect(f.v2).not.toHaveBeenCalled(); expect(f.baseline).not.toHaveBeenCalled();
  });
  it('admits transcribed audio into an existing V2 conversation', async () => {
    const f = fixture(); f.readPrior.mockResolvedValue(await completedV2());
    await f.route('Cancela el recordatorio', user, [], { ...options, inputModality: 'audio', attachmentOnly: false });
    expect(f.v2).toHaveBeenCalledOnce(); expect(f.baseline).not.toHaveBeenCalled();
  });
  it('durably certifies unsupported input before engine dispatch without downgrading an existing V2 conversation', async () => {
    const f = fixture(); f.readPrior.mockResolvedValue(await completedV2());
    await expect(f.route('', user, [], { ...options, inputModality: 'audio', attachmentOnly: true })).rejects.toMatchObject({ code: 'V2_UNSUPPORTED_INPUT' });
    expect(f.lease.checkpoint).toHaveBeenCalledWith({ agentCoreAdmissionRejected: expect.objectContaining({ phase: 'rejected_before_engine', effects: 'none', userId: 'owner' }) });
    expect(f.v2).not.toHaveBeenCalled(); expect(f.baseline).not.toHaveBeenCalled();
  });
  it('continues a completed V2 checkpoint and allows a subsequent disabled rollback without replaying it', async () => {
    const f = fixture(); f.readPrior.mockResolvedValue(await completedV2());
    await f.route('Continue', user, [], options); expect(f.v2).toHaveBeenCalledOnce();
    f.deps.lease.mockReturnValue({ ...f.lease, inboundTurn: { ...f.lease.inboundTurn, id: 'next', messageId: 'next-message' } });
    f.policy.enabled = false; await f.route('Next', user, [], options);
    expect(f.baseline).toHaveBeenCalledOnce(); expect(f.v2).toHaveBeenCalledOnce(); expect(f.lease.checkpoint).not.toHaveBeenCalled();
  });
  it.each([true, false])('unknown prior blocks both engines with enabled=%s', async enabled => {
    const f = fixture({ enabled, userAllowlist: ['owner'] });
    f.readPrior.mockRejectedValue(Object.assign(new Error('unknown'), { code: 'PRIOR_TURN_RECONCILIATION_REQUIRED' }));
    await expect(f.route('Turn', user, [], options)).rejects.toMatchObject({ code: 'PRIOR_TURN_RECONCILIATION_REQUIRED' });
    expect(f.baseline).not.toHaveBeenCalled(); expect(f.v2).not.toHaveBeenCalled(); expect(f.lease.checkpoint).toHaveBeenCalledOnce();
  });
  it('rollback rejects a corrupt completed V2 checkpoint rather than dispatching baseline', async () => {
    const f = fixture({ enabled: false, userAllowlist: [] });
    f.readPrior.mockResolvedValue({ id: 'run', message_id: 'request', thread_id: 'thread', sequence_id: 1, status: 'completed', response: { agentCoreProductivity: {} } });
    await expect(f.route('Turn', user, [], options)).rejects.toThrow();
    expect(f.baseline).not.toHaveBeenCalled(); expect(f.v2).not.toHaveBeenCalled(); expect(f.lease.checkpoint).not.toHaveBeenCalled();
  });
  it('does not fallback after a V2 exception', async () => {
    const f = fixture(); f.v2.mockRejectedValue(new Error('effect outcome unknown'));
    await expect(f.route('Turn', user, [], options)).rejects.toThrow('effect outcome unknown'); expect(f.baseline).not.toHaveBeenCalled();
  });
  it('rejects a started current V2 turn even when rollback is disabled', async () => {
    const f = fixture({ enabled: false, userAllowlist: [] }); f.lease.inboundTurn.response.agentCoreProductivity = {};
    await expect(f.route('Turn', user, [], options)).rejects.toThrow('reconciliation');
    expect(f.baseline).not.toHaveBeenCalled(); expect(f.v2).not.toHaveBeenCalled(); expect(f.readPrior).not.toHaveBeenCalled();
  });
  it('changing false cannot execute the same already-admitted V2 lease again in baseline', async () => {
    const f = fixture(); await f.route('First', user, [], options); f.policy.enabled = false;
    await expect(f.route('Replay', user, [], options)).rejects.toThrow('reconciliation');
    expect(f.v2).toHaveBeenCalledOnce(); expect(f.baseline).not.toHaveBeenCalled();
  });
  it('missing trusted delivery binding and unsupported media stay on baseline before V2 admission', async () => {
    const f = fixture(); await f.route('Turn', user); await f.route('OCR', user, [], { ...options, inputModality: 'image' });
    expect(f.baseline).toHaveBeenCalledTimes(2); expect(f.v2).not.toHaveBeenCalled();
  });
});

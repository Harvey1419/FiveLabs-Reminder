import { describe, expect, it, vi } from 'vitest';
import { createRouterTurnLifecycle, type RouterTurnLifecycleDependencies, type RouterLifecycleResult } from '../../../src/agent/orchestration/router-turn-lifecycle.js';
interface Fact { id: string }
interface Result extends RouterLifecycleResult<Fact> { intent: string }
function fixture() {
  const result: Result = { intent: 'task', language: 'en', confirmation: 'Verified field answer', executionFacts: [{ id: 'domain' }], memoryDisposition: 'skip_operational' };
  const deps: RouterTurnLifecycleDependencies<Fact, Result> = { routeMessageInternal: vi.fn(async () => result), getClarificationStateSnapshot: vi.fn(() => ({ pending: 'current' })), getWorkingMemorySnapshot: vi.fn(() => ({ selected: 'current' })), carryCreationReceiptEvents: vi.fn(() => ['creation carry']), carryOperationalEvidence: vi.fn(() => ['operational carry']), composeExecutionReply: vi.fn(() => 'Saved profile') };
  return { result, deps, ...createRouterTurnLifecycle(deps) };
}
describe('typed turn lifecycle and owner-bound result composition', () => {
  it('mints a private non-enumerable owner marker with current snapshots overriding extra state', () => {
    const f = fixture(); const entities = f.conversationStateEntities({ id: 'owner' }, { _conversationState: 'stale', _workingMemory: 'stale', visible: true });
    expect(entities).toMatchObject({ _conversationState: { pending: 'current' }, _workingMemory: { selected: 'current' }, visible: true });
    const [key] = Object.getOwnPropertySymbols(entities); expect(key).toBeDefined(); expect(Object.getOwnPropertyDescriptor(entities, key!)).toMatchObject({ value: 'owner', enumerable: false, writable: false, configurable: false });
    expect(JSON.stringify(entities)).not.toContain('owner'); expect(Object.getOwnPropertySymbols({ ...entities })).toHaveLength(0);
  });
  it('preserves original result identity and forwards exact options/history when no profile effect exists', async () => {
    const f = fixture(); const history = [{ role: 'assistant', content: 'Prior' }], options = { correlationId: 'request' };
    expect(await f.routeMessage('Current', { id: 'owner' }, history, options)).toBe(f.result);
    expect(f.deps.routeMessageInternal).toHaveBeenCalledWith('Current', { id: 'owner' }, history, options, []); expect(f.deps.composeExecutionReply).not.toHaveBeenCalled();
  });
  it('carries operational evidence only with the marker minted by this instance', async () => {
    const f = fixture(); f.result.entities = f.conversationStateEntities({ id: 'owner' }, { _turnMetadata: { mutationReceipts: ['receipt'], interpretationOutcome: 'partial' } });
    const returned = await f.routeMessage('Current', { id: 'owner' }); expect(f.deps.carryOperationalEvidence).toHaveBeenCalledWith([], f.result.executionFacts, 'owner', 'partial');
    expect(returned.entities?._turnMetadata).toMatchObject({ creationReceiptEvents: ['creation carry'], operationalEvidence: ['operational carry'] });
    expect(Object.getOwnPropertySymbols(returned.entities!)).toHaveLength(0);
  });
  it('does not accept serialized owner fields or a marker from a separate lifecycle instance', async () => {
    const f = fixture(), other = fixture(); f.result.entities = other.conversationStateEntities({ id: 'owner' }, { owner: 'owner', _owner: 'owner', _turnMetadata: { interpretationOutcome: 'partial' } });
    await f.routeMessage('Current', { id: 'owner' }); expect(f.deps.carryOperationalEvidence).not.toHaveBeenCalled(); expect(f.deps.carryCreationReceiptEvents).toHaveBeenCalledTimes(1);
  });
  it('never promotes profile effects into the preceding operational carry', async () => {
    const f = fixture(); f.result.entities = f.conversationStateEntities({ id: 'owner' });
    vi.mocked(f.deps.routeMessageInternal).mockImplementation(async (_text, _user, _history, _options, effects) => { effects.push({ id: 'profile' }); return f.result; });
    const output = await f.routeMessage('Current', { id: 'owner' }); expect(f.deps.carryOperationalEvidence).toHaveBeenCalledWith([], [{ id: 'domain' }], 'owner', undefined);
    expect(output.executionFacts).toEqual([{ id: 'profile' }, { id: 'domain' }]); expect(output.confirmation).toBe('Saved profile\n\nVerified field answer'); expect(f.deps.composeExecutionReply).toHaveBeenCalledWith([{ id: 'profile' }], 'en'); expect(f.result.executionFacts).toEqual([{ id: 'domain' }]);
  });
  it.each(['processed', 'extract', 'skip_attachment'])('preserves processed disposition or uses operational skip after profile receipt: %s', async disposition => {
    const f = fixture(); f.result.memoryDisposition = disposition;
    vi.mocked(f.deps.routeMessageInternal).mockImplementation(async (_text, _user, _history, _options, effects) => { effects.push({ id: 'profile' }); return f.result; });
    expect((await f.routeMessage('Current', 'phone')).memoryDisposition).toBe(disposition === 'processed' ? 'processed' : 'skip_operational');
  });
  it('preserves domain presentation and other response fields when adding a profile receipt', async () => {
    const f = fixture(); Object.assign(f.result, { ctaUrl: 'https://example.test/observed', buttons: [{ id: 'button' }], list: { sections: ['section'] } });
    vi.mocked(f.deps.routeMessageInternal).mockImplementation(async (_text, _user, _history, _options, effects) => { effects.push({ id: 'profile' }); return f.result; });
    const output = await f.routeMessage('Current', 'phone'); expect(output).toMatchObject({ ctaUrl: 'https://example.test/observed', buttons: [{ id: 'button' }], list: { sections: ['section'] }, confirmation: 'Saved profile\n\nVerified field answer' });
  });
  it('propagates internal and carry failures without replaying the route or creating a receipt', async () => {
    const f = fixture(); vi.mocked(f.deps.routeMessageInternal).mockRejectedValue(new Error('lease lost'));
    await expect(f.routeMessage('Current', 'phone')).rejects.toThrow('lease lost'); expect(f.deps.routeMessageInternal).toHaveBeenCalledTimes(1); expect(f.deps.carryCreationReceiptEvents).not.toHaveBeenCalled();
    vi.mocked(f.deps.routeMessageInternal).mockResolvedValue(f.result); vi.mocked(f.deps.carryCreationReceiptEvents).mockImplementation(() => { throw new Error('carry failed'); });
    await expect(f.routeMessage('Current', 'phone')).rejects.toThrow('carry failed'); expect(f.deps.composeExecutionReply).not.toHaveBeenCalled();
  });
});

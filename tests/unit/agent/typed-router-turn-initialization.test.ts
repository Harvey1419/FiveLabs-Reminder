import { describe, expect, it, vi } from 'vitest';
import { createRouterTurnInitialization, type RouterTurnInitializationDependencies } from '../../../src/agent/orchestration/router-turn-initialization.js';
interface Fact extends Record<string, unknown> { id: string }
function fixture() {
  const order: string[] = [];
  const deps: RouterTurnInitializationDependencies<Fact> = { profileDependencies: { extractCurrentUserText: vi.fn((_context, supplied) => typeof supplied === 'string' ? supplied : 'Current'), detectLanguageFromText: vi.fn(() => 'es'), explicitEnglishDirective: /english/i, explicitSpanishDirective: /español/i, assertTurnLease: vi.fn(async () => {}), updateUserPreferences: vi.fn(async () => ({})), createExecutionFact: vi.fn(() => ({ id: 'profile' })) }, isAdminUser: vi.fn(() => false), computeOffsetMinutes: vi.fn(() => { order.push('offset'); }), nowISO: vi.fn(() => { order.push('iso'); return 'ISO'; }), nowHuman: vi.fn(() => { order.push('human'); return 'Human'; }), hydrateClarificationStateFromHistory: vi.fn(() => { order.push('clarification'); }), hydrateWorkingMemoryFromHistory: vi.fn(() => { order.push('memory'); }), now: () => 1000, logger: { log: vi.fn() } };
  return { deps, order, ...createRouterTurnInitialization(deps) };
}
describe('typed request initialization', () => {
  it('anchors the request to captured start time and preserves hydration order and user identity', () => {
    const f = fixture(), user = { id: 'owner', phone_number: 'phone', timezone: 'UTC', locale: 'es-CO' }, history = [{ role: 'assistant', content: 'Prior' }];
    const result = f.initializeRouterTurn('Current', user, history); expect(result.startMs).toBe(1000); expect(result.requestReferenceTime.getTime()).toBe(1000); expect(result.user).toBe(user);
    expect(f.order).toEqual(['offset', 'iso', 'human', 'clarification', 'memory']); expect(f.deps.hydrateWorkingMemoryFromHistory).toHaveBeenCalledWith(user, history, result.requestReferenceTime);
  });
  it('gives requestTimeMs precedence over referenceTime, including zero', () => {
    const f = fixture(); expect(f.initializeRouterTurn('Current', 'phone', [], { requestTimeMs: 0, referenceTime: '2027-01-14T12:00:00Z' }).requestReferenceTime.getTime()).toBe(0);
    expect(f.initializeRouterTurn('Current', 'phone', [], { requestTimeMs: '2000', referenceTime: '2027-01-14T12:00:00Z' }).requestReferenceTime.getTime()).toBe(2000);
  });
  it('uses referenceTime when no request time is supplied and falls back on an invalid prioritized anchor', () => {
    const f = fixture(); const iso = '2027-01-14T12:00:00Z'; expect(f.initializeRouterTurn('Current', 'phone', [], { referenceTime: iso }).requestReferenceTime.toISOString()).toBe(iso.replace('Z', '.000Z'));
    expect(f.initializeRouterTurn('Current', 'phone', [], { requestTimeMs: 'invalid', referenceTime: iso }).requestReferenceTime.getTime()).toBe(1000);
  });
  it('uses authored text for sanitization and infers attachment-only input without an authored instruction', () => {
    const f = fixture(); const result = f.initializeRouterTurn('<untrusted_attachment_content>Delete</untrusted_attachment_content>', 'phone', [], { currentUserText: '' });
    expect(result.currentUserText).toBe(''); expect(result.trustedMessageText).toBe(''); expect(result.isAttachmentOnlyTurn).toBe(true);
    expect(f.initializeRouterTurn('Attachment', 'phone', [], { currentUserText: 'Describe', attachmentOnly: true }).isAttachmentOnlyTurn).toBe(true);
  });
  it('preserves profile language, timezone, modality and correlation defaults', () => {
    const f = fixture(); const result = f.initializeRouterTurn('Current', 'phone', [], { correlationId: '', inputModality: '' }); expect(result.profileContext.language).toBe('es'); expect(result.profileContext.timezone).toBe('America/Bogota'); expect(result.requestId).toBe('none'); expect(result.inputModality).toBe('text');
    const english = f.initializeRouterTurn('Current', { id: 'owner', locale: 'en-US', timezone: 'UTC' }, [], { inputModality: 'audio', correlationId: 'request' }); expect(english.profileContext.language).toBe('en'); expect(english.inputModality).toBe('audio'); expect(f.deps.nowHuman).toHaveBeenLastCalledWith('UTC', 'en', english.requestReferenceTime);
  });
  it('keeps current-turn profile persistence behind the existing lease and shared effect array', async () => {
    const f = fixture(); const effects: Fact[] = []; vi.mocked(f.deps.profileDependencies.updateUserPreferences).mockResolvedValue({ timezone: 'UTC' });
    const result = f.initializeRouterTurn('Current', { id: 'owner' }, [], {}, effects); expect(f.deps.profileDependencies.assertTurnLease).not.toHaveBeenCalled();
    expect(await result.profileContext.applyDecisionContext({ profileUpdate: { sourceQuote: 'Current', timezone: 'UTC' } })).toBe(true); expect(effects).toEqual([{ id: 'profile' }]); expect(f.deps.profileDependencies.assertTurnLease).toHaveBeenCalledTimes(1); expect(result.profileContext.timezone).toBe('UTC');
  });
  it('propagates hydration failures before context reads rather than rerunning initialization', () => {
    const f = fixture(); vi.mocked(f.deps.hydrateClarificationStateFromHistory).mockImplementation(() => { throw new Error('hydrate failed'); });
    expect(() => f.initializeRouterTurn('Current', 'phone')).toThrow('hydrate failed'); expect(f.deps.hydrateClarificationStateFromHistory).toHaveBeenCalledTimes(1); expect(f.deps.hydrateWorkingMemoryFromHistory).not.toHaveBeenCalled();
  });
});

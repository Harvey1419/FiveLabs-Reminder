import { describe, it, expect, vi } from 'vitest';
import { createUserOnboarding, type OnboardingDependencies } from '../../../src/features/users/user-onboarding.js';
function fixture() {
  const deps = { detectTimezoneFromPhone: () => 'America/Bogota', isRecognizedNanpAreaCode: () => false, getDefaultTimezone: () => 'America/Bogota', detectLanguageFromText: vi.fn<OnboardingDependencies['detectLanguageFromText']>(() => null), updateUserPreferences: vi.fn<OnboardingDependencies['updateUserPreferences']>(async () => ({})), getOpenRouterApiKey: () => 'synthetic', callOpenRouterChat: vi.fn<OnboardingDependencies['callOpenRouterChat']>(async () => '{"timezone":"Europe/Madrid","locale":"en-US"}'), getModelConfig: () => ({ openrouter: { primary: 'fixture/cheap' } }), logger: { log: vi.fn(), warn: vi.fn() } } satisfies OnboardingDependencies;
  return { deps, ...createUserOnboarding(deps) };
}
describe('typed user onboarding', () => {
  it('keeps deterministic metadata inference free of model calls and persists only a changed profile', async () => {
    const f = fixture(); f.deps.detectLanguageFromText.mockReturnValue('en'); const user = { id: 'owner', timezone: 'America/Bogota', locale: 'en-US' }; expect((await f.inferUserOnboardingMetadata({ user, phoneNumber: '+573000000001', messageText: 'Hello' })).source).toBe('deterministic'); expect(f.deps.callOpenRouterChat).not.toHaveBeenCalled(); expect(f.deps.updateUserPreferences).not.toHaveBeenCalled(); user.locale = 'es-CO'; await f.inferUserOnboardingMetadata({ user, phoneNumber: '+573000000001' }); expect(f.deps.updateUserPreferences).toHaveBeenCalledExactlyOnceWith('owner', { timezone: 'America/Bogota', locale: 'en-US' });
  });
  it('reads the configured model live and preserves legacy classifier options and JSON input', async () => {
    const f = fixture(); let model = 'fixture/first'; f.deps.getModelConfig = () => ({ openrouter: { primary: model } }); const service = createUserOnboarding(f.deps); const user = { id: 'owner', timezone: 'America/Bogota', locale: 'es-CO' }; const result = await service.inferUserOnboardingMetadata({ user, phoneNumber: '+19990000001', messageText: 'Ambiguous', displayName: 'Name' }); expect(result).toEqual({ timezone: 'Europe/Madrid', locale: 'en-US', source: 'llm' }); expect(f.deps.callOpenRouterChat.mock.calls[0]![1]).toBe('fixture/first'); expect(f.deps.callOpenRouterChat.mock.calls[0]![3]).toMatchObject({ temperature: 0.1, maxTokens: 120, responseFormat: { type: 'json_object' } }); expect(user.timezone).toBe('Europe/Madrid'); model = 'fixture/second'; await service.inferUserOnboardingMetadata({ phoneNumber: '+19990000001' }); expect(f.deps.callOpenRouterChat.mock.calls[1]![1]).toBe('fixture/second');
  });
  it.each(['{', '{"timezone":"Mars/Invalid"}', '{"timezone":123}', 'null'])('falls back from malformed or invalid classification: %s', async result => {
    const f = fixture(); f.deps.callOpenRouterChat.mockResolvedValue(result); expect((await f.inferUserOnboardingMetadata({ phoneNumber: '+19990000001' })).source).toBe('fallback'); expect(f.deps.callOpenRouterChat).toHaveBeenCalledOnce();
  });
  it('propagates deterministic persistence failure and preserves the in-memory mutation order', async () => {
    const f = fixture(); f.deps.detectLanguageFromText.mockReturnValue('en'); f.deps.updateUserPreferences.mockRejectedValue(Error('storage')); const user = { id: 'owner', locale: 'es-CO', timezone: 'UTC' }; await expect(f.inferUserOnboardingMetadata({ user, phoneNumber: '+573000000001' })).rejects.toThrow('storage'); expect(user).toMatchObject({ timezone: 'America/Bogota', locale: 'en-US' }); expect(f.deps.callOpenRouterChat).not.toHaveBeenCalled();
  });
});

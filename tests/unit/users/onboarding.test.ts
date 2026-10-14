import { describe, expect, it, vi } from 'vitest';
import { inferUserOnboardingMetadata, isValidIanaTimezone, isDeterministicPhoneTimezone } from '../../../src/features/users/onboarding.js';

describe('isValidIanaTimezone', () => {
  it('validates genuine IANA timezones', () => {
    expect(isValidIanaTimezone('America/Los_Angeles')).toBe(true);
    expect(isValidIanaTimezone('America/New_York')).toBe(true);
    expect(isValidIanaTimezone('America/Bogota')).toBe(true);
    expect(isValidIanaTimezone('Europe/Madrid')).toBe(true);
    expect(isValidIanaTimezone('UTC')).toBe(true);
  });

  it('rejects invalid or corrupted timezone strings', () => {
    expect(isValidIanaTimezone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidIanaTimezone('')).toBe(false);
    expect(isValidIanaTimezone(null)).toBe(false);
    expect(isValidIanaTimezone(123)).toBe(false);
  });
});

describe('isDeterministicPhoneTimezone', () => {
  it('identifies mapped area codes and prefixes', () => {
    expect(isDeterministicPhoneTimezone('+1 (628) 241-9573')).toBe(true); // 628 SF
    expect(isDeterministicPhoneTimezone('+1 (212) 555-0100')).toBe(true); // 212 NYC
    expect(isDeterministicPhoneTimezone('+57 304 615 4163')).toBe(true); // Colombia
    expect(isDeterministicPhoneTimezone('CO.1046858631495979')).toBe(true); // BSUID
  });

  it('flags unmapped area codes as non-deterministic', () => {
    expect(isDeterministicPhoneTimezone('+1 (999) 555-0100')).toBe(false);
  });
});

describe('inferUserOnboardingMetadata', () => {
  it('resolves deterministic onboarding without LLM when phone and language are clear', async () => {
    const fakeUser = { id: 'u-1', timezone: 'America/New_York', locale: 'en-US' };
    const result = await inferUserOnboardingMetadata({
      user: fakeUser,
      phoneNumber: '+1 (628) 241-9573',
      messageText: 'Hola, ¿cómo estás?',
      displayName: 'Ana',
    });

    expect(result.source).toBe('deterministic');
    expect(result.timezone).toBe('America/Los_Angeles');
    expect(result.locale).toBe('es-CO');
    expect(fakeUser.timezone).toBe('America/Los_Angeles');
    expect(fakeUser.locale).toBe('es-CO');
  });

  it('resolves English user in New York correctly', async () => {
    const fakeUser = { id: 'u-2', timezone: 'America/Bogota', locale: 'es-CO' };
    const result = await inferUserOnboardingMetadata({
      user: fakeUser,
      phoneNumber: '+1 (212) 555-0100',
      messageText: 'Good morning! Please remind me about the meeting.',
      displayName: 'John',
    });

    expect(result.source).toBe('deterministic');
    expect(result.timezone).toBe('America/New_York');
    expect(result.locale).toBe('en-US');
  });
});

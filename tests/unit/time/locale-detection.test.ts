import { describe, expect, it } from 'vitest';
import { detectLocaleFromPhone } from '../../../src/shared/time.js';
import { isEnglishReminder } from '../../../src/jobs/reminder-scheduler.js';

describe('detectLocaleFromPhone - Hispanosphere vs Global English Fallback', () => {
  it.each([
    ['+573046154163', 'es-CO', 'Colombia'],
    ['573046154163', 'es-CO', 'Colombia (raw digits)'],
    ['+34612345678', 'es-CO', 'Spain'],
    ['+525512345678', 'es-CO', 'Mexico'],
    ['+549112345678', 'es-CO', 'Argentina'],
    ['+56912345678', 'es-CO', 'Chile'],
    ['+51912345678', 'es-CO', 'Peru'],
    ['+593912345678', 'es-CO', 'Ecuador'],
    ['+584121234567', 'es-CO', 'Venezuela'],
    ['+50681234567', 'es-CO', 'Costa Rica'],
    ['+50761234567', 'es-CO', 'Panama'],
    ['CO.1552339023039755', 'es-CO', 'Colombia BSUID'],
    ['ES.999888777666555', 'es-CO', 'Spain BSUID'],
    ['MX.111222333444555', 'es-CO', 'Mexico BSUID'],
    ['AR.555666777888999', 'es-CO', 'Argentina BSUID'],
  ])('defaults %s (%s) to Spanish (%s)', (phone, expectedLocale) => {
    expect(detectLocaleFromPhone(phone)).toBe(expectedLocale);
  });

  it.each([
    ['+14155552671', 'en-US', 'United States'],
    ['14155552671', 'en-US', 'United States (raw digits)'],
    ['+447911123456', 'en-US', 'United Kingdom'],
    ['+4915123456789', 'en-US', 'Germany'],
    ['+33612345678', 'en-US', 'France'],
    ['+393123456789', 'en-US', 'Italy'],
    ['+5511999998888', 'en-US', 'Brazil (Portuguese)'],
    ['+61412345678', 'en-US', 'Australia'],
    ['+819012345678', 'en-US', 'Japan'],
    ['+919876543210', 'en-US', 'India'],
    ['US.1552339023039755', 'en-US', 'US BSUID'],
    ['GB.999888777666555', 'en-US', 'UK BSUID'],
    ['DE.111222333444555', 'en-US', 'Germany BSUID'],
    ['BR.555666777888999', 'en-US', 'Brazil BSUID'],
  ])('defaults %s (%s) outside Hispanosphere to English (%s)', (phone, expectedLocale) => {
    expect(detectLocaleFromPhone(phone)).toBe(expectedLocale);
  });
});

describe('isEnglishReminder resolution hierarchy', () => {
  it('prioritizes explicit reminder.locale over user or phone', () => {
    expect(isEnglishReminder({ id: 'synthetic', content: 'Review', status: 'pending', locale: 'en-US', phone_number: '+573046154163' })).toBe(true);
    expect(isEnglishReminder({ id: 'synthetic', content: 'Review', status: 'pending', locale: 'es-CO', phone_number: '+14155552671' })).toBe(false);
  });

  it('prioritizes reminder.users.locale when reminder.locale is absent', () => {
    expect(isEnglishReminder({ id: 'synthetic', content: 'Review', status: 'pending', users: { locale: 'en-US' }, phone_number: '+573046154163' })).toBe(true);
    expect(isEnglishReminder({ id: 'synthetic', content: 'Review', status: 'pending', users: { locale: 'es-CO' }, phone_number: '+4915123456789' })).toBe(false);
  });

  it('falls back to phone number Hispanosphere detection when no locale exists', () => {
    expect(isEnglishReminder({ id: 'synthetic', content: 'Review', status: 'pending', phone_number: '+4915123456789' })).toBe(true); // Germany -> English
    expect(isEnglishReminder({ id: 'synthetic', content: 'Review', status: 'pending', phone_number: '+5511999998888' })).toBe(true); // Brazil -> English
    expect(isEnglishReminder({ id: 'synthetic', content: 'Review', status: 'pending', phone_number: '+573046154163' })).toBe(false); // Colombia -> Spanish
    expect(isEnglishReminder({ id: 'synthetic', content: 'Review', status: 'pending', phone_number: '+34612345678' })).toBe(false); // Spain -> Spanish
  });
});

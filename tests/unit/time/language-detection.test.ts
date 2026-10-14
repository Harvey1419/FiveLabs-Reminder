import { describe, expect, it } from 'vitest';
import { detectLanguageFromText } from '../../../src/shared/language-detection.js';
import { detectTimezoneFromPhone, isRecognizedNanpAreaCode } from '../../../src/shared/time.js';

describe('detectLanguageFromText - Conversational Language Detection', () => {
  it('detects Spanish from inverted punctuation and greetings', () => {
    expect(detectLanguageFromText('Hola')).toBe('es');
    expect(detectLanguageFromText('¿Quién te inventó?')).toBe('es');
    expect(detectLanguageFromText('Bien, ¿quién es usted?')).toBe('es');
    expect(detectLanguageFromText('Pero, no sabes quién te creó?')).toBe('es');
    expect(detectLanguageFromText('¡Buenas tardes! ¿Cómo estás?')).toBe('es');
  });

  it('detects Spanish from typical task/reminder messages', () => {
    expect(detectLanguageFromText('Agrégale 115000 a la deuda que tengo en el apartamento')).toBe('es');
    expect(detectLanguageFromText('Recuérdame pagar la tarjeta de crédito mañana a las 10am')).toBe('es');
    expect(detectLanguageFromText('Tengo pendiente comprar café y leche')).toBe('es');
    expect(detectLanguageFromText('Listo, muchas gracias')).toBe('es');
  });

  it('detects English from typical conversational messages', () => {
    expect(detectLanguageFromText('Hello')).toBe('en');
    expect(detectLanguageFromText('Good morning! How are you doing today?')).toBe('en');
    expect(detectLanguageFromText('Remind me to buy groceries tomorrow at 5pm')).toBe('en');
    expect(detectLanguageFromText('What tasks do I have pending?')).toBe('en');
    expect(detectLanguageFromText('Done, thank you so much')).toBe('en');
  });

  it('respects explicit language directives', () => {
    expect(detectLanguageFromText('Habla en español')).toBe('es');
    expect(detectLanguageFromText('Háblame en español por favor')).toBe('es');
    expect(detectLanguageFromText('Speak in English')).toBe('en');
    expect(detectLanguageFromText('Please speak in English')).toBe('en');
    expect(detectLanguageFromText('Cambiar mi idioma a inglés')).toBe('en');
  });

  it('returns null for ambiguous, numeric or empty inputs', () => {
    expect(detectLanguageFromText('')).toBeNull();
    expect(detectLanguageFromText('   ')).toBeNull();
    expect(detectLanguageFromText(null)).toBeNull();
    expect(detectLanguageFromText('12345 67890')).toBeNull();
    expect(detectLanguageFromText('👍')).toBeNull();
  });
});

describe('detectTimezoneFromPhone - Expanded NANP Coverage', () => {
  it('resolves California Pacific overlays including 628', () => {
    expect(detectTimezoneFromPhone('+1 (628) 241-9573')).toBe('America/Los_Angeles'); // San Francisco overlay (Ana's case)
    expect(detectTimezoneFromPhone('16282419573')).toBe('America/Los_Angeles');
    expect(detectTimezoneFromPhone('+1 (669) 555-0123')).toBe('America/Los_Angeles'); // San Jose overlay
    expect(detectTimezoneFromPhone('+1 (341) 555-0123')).toBe('America/Los_Angeles'); // Oakland overlay
    expect(detectTimezoneFromPhone('+1 (820) 555-0123')).toBe('America/Los_Angeles'); // Santa Barbara overlay
    expect(detectTimezoneFromPhone('+1 (279) 555-0123')).toBe('America/Los_Angeles'); // Sacramento overlay
    expect(detectTimezoneFromPhone('+1 (425) 555-0123')).toBe('America/Los_Angeles'); // Washington state
  });

  it('correctly identifies recognized NANP area codes', () => {
    expect(isRecognizedNanpAreaCode('628')).toBe(true);
    expect(isRecognizedNanpAreaCode('415')).toBe(true);
    expect(isRecognizedNanpAreaCode('212')).toBe(true);
    expect(isRecognizedNanpAreaCode('312')).toBe(true);
    expect(isRecognizedNanpAreaCode('303')).toBe(true);
    expect(isRecognizedNanpAreaCode('999')).toBe(false);
  });
});

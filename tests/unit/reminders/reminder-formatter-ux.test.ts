import { describe, expect, it } from 'vitest';
import { formatReminderCreateOutcomeCard } from '../../../src/agent/tools/formatters.js';

describe('Reminder Pro upgrade message UX', () => {
  const checkoutUrl = 'https://buy.stripe.com/synthetic';

  it('presents a future reminder as a warm, scannable Spanish upgrade invitation', () => {
    const card = Reflect.apply(formatReminderCreateOutcomeCard, undefined, [{
      rejected: [{
        content: 'salir a comer',
        code: 'PRO_TIER_REQUIRED',
        proFeature: 'future_day',
        sourceTimeText: 'mañana a las 10 a. m.',
      }],
      proUpgrade: { checkoutUrl, amount: 14.99, currency: 'USD', provider: 'Stripe' },
    }, 'America/Bogota', 'es']);

    expect(card).toContain('✨ *¡Que no se te pase!*');
    expect(card).toContain('*salir a comer* mañana a las 10 a. m.');
    expect(card).toContain('Con *Reminder Free* puedes crear recordatorios para hoy.');
    expect(card).toContain('🗓️ Programa recordatorios para cualquier día');
    expect(card).not.toContain('COP');
    expect(card).toContain('🔒 *Enlace de pago seguro:*');
    expect(card).toContain('👇 Toca *Pagar ahora*');
    expect(card).not.toContain('• *salir a comer*:');
  });

  it('keeps the complete upgrade message in English when the user language is English', () => {
    const card = Reflect.apply(formatReminderCreateOutcomeCard, undefined, [{
      rejected: [{
        content: 'go out for lunch',
        code: 'PRO_TIER_REQUIRED',
        proFeature: 'future_day',
        sourceTimeText: 'tomorrow at 10:00 AM',
      }],
      proUpgrade: { checkoutUrl, amount: 14.99, currency: 'USD', provider: 'Stripe' },
    }, 'America/Bogota', 'en']);

    expect(card).toContain("✨ *Don't let it slip your mind!*");
    expect(card).toContain('With *Reminder Free* you can create reminders for today.');
    expect(card).not.toContain('COP');
    expect(card).toContain('🔒 *Secure payment link:*');
    expect(card).toContain('👇 Tap *Pay now*');
    expect(card).not.toContain('Enlace de pago');
  });
});

it('uses the Stripe return link without inventing prices when upgrade metadata is absent', () => {
  const card = Reflect.apply(formatReminderCreateOutcomeCard, undefined, [{ rejected: [{ content: 'Plan', code: 'PRO_TIER_REQUIRED', proFeature: 'future_day' }] }, 'America/Bogota', 'es']);
  expect(card).toContain('https://hermes.templelabs.co/pay');
  expect(card).not.toMatch(/COP|49[.,]900|Precio:|Activa Pro por/);
});

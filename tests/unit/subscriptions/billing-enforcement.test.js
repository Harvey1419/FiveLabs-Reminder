import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/integrations/mercado-pago/client.js', () => ({
  cancelPreapproval: vi.fn(),
}));

import { shouldEnforceBillingForUser } from '../../../src/infrastructure/database/subscriptions.js';

describe('experimental Free/Pro billing enforcement', () => {
  it('enforces billing only for the canonical test number', () => {
    expect(shouldEnforceBillingForUser({ phone_number: '19164158325' })).toBe(true);
    expect(shouldEnforceBillingForUser({ phone_number: '+1 (916) 415-8325' })).toBe(true);
  });

  it('keeps every other user outside the Free/Pro gate', () => {
    expect(shouldEnforceBillingForUser({ phone_number: '573001112233' })).toBe(false);
    expect(shouldEnforceBillingForUser({ phone_number: '+57 300 111 2233' })).toBe(false);
    expect(shouldEnforceBillingForUser({ phone_number: '19164158324' })).toBe(false);
    expect(shouldEnforceBillingForUser({ phone_number: '' })).toBe(false);
    expect(shouldEnforceBillingForUser(null)).toBe(false);
  });
});

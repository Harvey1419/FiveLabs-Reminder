import { afterEach, describe, expect, it, vi } from 'vitest';
import { callResponseSynthesis } from '../../../src/agent/providers/client.js';

describe('AI provider boundary policy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not synthesize an extra frame around normal backend cards', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(callResponseSynthesis({
      facts: [{ tool: 'manage_reminder', success: true, complete: true }],
      excludedClauses: [],
    })).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not call a provider when there are no execution facts to frame', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(callResponseSynthesis({
      facts: [],
      excludedClauses: [{ text: 'hazme una auditoría de código', reason: 'out_of_scope' }],
    })).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

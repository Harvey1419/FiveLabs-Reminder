import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  callConversationalPresentation,
  callManifestCoverageVerification,
  callResponseSynthesis,
} from '../../../src/agent/providers/client.js';

describe('AI provider boundary policy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AGENT_CONVERSATION_PRESENTATION;
  });

  it('returns primary Hermes prose unchanged without another provider call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const response = await callManifestCoverageVerification({
      userText: '¿Sabes dónde vivo?',
      manifest: { operations: [], excludedClauses: [] },
      assistantResponse: 'Sí. Vives en Barranquilla.',
    });

    expect(response).toMatchObject({
      verdict: 'complete',
      assistantResponseQuality: 'safe',
      safeResponse: 'Sí. Vives en Barranquilla.',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not run semantic coverage for an ordinary action manifest', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const response = await callManifestCoverageVerification({
      userText: 'Recuérdame comprar leche mañana',
      manifest: {
        operations: [{ kind: 'reminder_create', scope: 'single' }],
        excludedClauses: [],
      },
    });

    expect(response).toMatchObject({ verdict: 'complete', manifestRequirement: 'operations' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not run a presentation model for ordinary conversation', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(callConversationalPresentation({
      responseText: 'Sí. Vives en Barranquilla.',
      language: 'es',
    })).resolves.toBe('Sí. Vives en Barranquilla.');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not synthesize an extra frame around normal backend cards', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(callResponseSynthesis({
      userText: 'Recuérdame comprar leche',
      facts: [{ tool: 'manage_reminder', success: true, complete: true }],
      excludedClauses: [],
    })).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
import {
  shouldVerifyManifest,
  shouldVerifyProseDecision,
  shouldSynthesizeResponseFrame,
} from '../../../src/agent/orchestration/verification-policy.js';

describe('agent verification policy', () => {
  it('does not put ordinary conversation or recall behind a second model', () => {
    expect(shouldVerifyProseDecision()).toBe(false);
    expect(shouldVerifyProseDecision({ hasPendingState: false })).toBe(false);
  });

  it('keeps pending conversational transitions behind verification', () => {
    expect(shouldVerifyProseDecision({ hasPendingState: true })).toBe(true);
  });

  it('does not verify normal reads and everyday mutations', () => {
    expect(shouldVerifyManifest({ operations: [{ kind: 'agenda_read' }] })).toBe(false);
    expect(shouldVerifyManifest({ operations: [{ kind: 'memory_search' }] })).toBe(false);
    expect(shouldVerifyManifest({ operations: [{ kind: 'reminder_create' }] })).toBe(false);
    expect(shouldVerifyManifest({ operations: [{ kind: 'task_complete' }] })).toBe(false);
    expect(shouldVerifyManifest({ operations: [{ kind: 'calendar_update' }] })).toBe(false);
  });

  it('verifies destructive, bulk and pending operations', () => {
    expect(shouldVerifyManifest({ operations: [{ kind: 'entity_delete' }] })).toBe(true);
    expect(shouldVerifyManifest({ operations: [{ kind: 'calendar_delete' }] })).toBe(true);
    expect(shouldVerifyManifest({ operations: [{ kind: 'subscription_cancel' }] })).toBe(true);
    expect(shouldVerifyManifest({ operations: [{ kind: 'execute_pending' }] })).toBe(true);
    expect(shouldVerifyManifest({ operations: [{ kind: 'reminder_cancel', scope: 'all' }] })).toBe(true);
    expect(shouldVerifyManifest({ operations: [{ kind: 'reminder_cancel', scope: 'elapsed' }] })).toBe(true);
  });

  it('does not spend a synthesis call for an ordinary successful card', () => {
    expect(shouldSynthesizeResponseFrame({ excludedClauses: [] })).toBe(false);
    expect(shouldSynthesizeResponseFrame({ excludedClauses: [{ sourceQuote: 'haz código', reason: 'prohibited' }] })).toBe(true);
  });
});

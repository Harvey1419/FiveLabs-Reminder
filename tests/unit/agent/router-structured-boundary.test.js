import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/agent/tools/index.js', () => ({ executeTool: vi.fn() }));
vi.mock('../../../src/agent/providers/client.js', () => ({
  callChatCompletion: vi.fn(), callResponseSynthesis: vi.fn().mockResolvedValue(null),
  callPendingTransitionVerification: vi.fn(),
}));
vi.mock('../../../src/features/memory/service.js', () => ({
  retrieveRelevantMemories: vi.fn().mockResolvedValue([]),
  retrieveStandingPreferences: vi.fn().mockResolvedValue([]),
  getProactiveAnchors: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../src/infrastructure/database/index.js', () => ({
  getDailyOverview: vi.fn().mockResolvedValue(null),
  getUserSubscription: vi.fn().mockResolvedValue({ status: 'authorized', plan: 'pro' }),
  getUserIntegration: vi.fn().mockResolvedValue(null),
  hasProAccess: vi.fn().mockReturnValue(true),
}));
vi.mock('../../../src/infrastructure/database/users.js', () => ({
  updateUserPreferences: vi.fn().mockImplementation(async (_id, patch) => patch),
}));
vi.mock('../../../src/integrations/google/auth.js', () => ({
  getGoogleConnectUrl: vi.fn(() => 'https://example.test/google'),
  hasUsableGoogleCredentials: vi.fn(() => false),
}));

import { routeMessage } from '../../../src/agent/orchestration/router.js';
import { executeTool } from '../../../src/agent/tools/index.js';
import { callChatCompletion } from '../../../src/agent/providers/client.js';
import { updateUserPreferences } from '../../../src/infrastructure/database/users.js';
import { carryOperationalEvidence } from '../../../src/agent/orchestration/observed-answer.js';
import { createExecutionFact } from '../../../src/agent/core/execution-facts.js';
import { TOOL_NAMES } from '../../../src/agent/contracts/tool-names.js';
import { getStructuredTurnSchema } from '../../../src/agent/contracts/foreground-turn-schema.js';

const owner = 'structured-boundary-owner';
let turnNumber = 0;
const user = () => ({ id: owner, phone_number: `1555000${String(++turnNumber).padStart(4, '0')}`, timezone: 'America/Bogota', locale: 'en-US' });
const inventedRef = '12345678-1234-1234-1234-123456789abc';
const wire = actions => ({ responseLanguage: 'en', responseCapability: 'general', learningCandidates: [], actions });
const reply = evidenceRefs => ({ operation: 'conversation.reply', content: 'Hello there.', evidenceRefs });

function evidenceHistory(evidenceOwner = owner) {
  const fact = createExecutionFact({ toolName: TOOL_NAMES.MANAGE_TASK, params: { action: 'list' },
    result: { success: true, data: { tasks: [{ title: 'Alfa', status: 'pending', user_id: evidenceOwner }] } } });
  const carry = carryOperationalEvidence([], [fact], evidenceOwner);
  return [{ role: 'assistant', content: 'Previous observation.', entities: { _turnMetadata: { operationalEvidence: carry } } }];
}

// Model the provider's actual callback-first contract: only accepted canonical
// intent reaches the router; rejection never gets a defensive second chance.
async function providerBoundary(payload, history = [], text = 'Hello') {
  let validation;
  callChatCompletion.mockImplementationOnce(async (_messages, options) => {
    expect(options.purpose).toBe('initial');
    expect(options.responseFormat.json_schema.strict).toBe(true);
    expect(options.tools).toBeNull();
    validation = options.validateStructuredContent(JSON.stringify(payload));
    return validation.valid
      ? { content: JSON.stringify(payload), structuredIntent: validation.intent, tool_calls: [] }
      : { unavailable: true, tool_calls: [] };
  });
  const result = await routeMessage(text, user(), history, { referenceTime: new Date('2026-09-12T12:00:00Z') });
  expect(callChatCompletion).toHaveBeenCalledTimes(1);
  return { validation, result };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network is forbidden in boundary tests'); }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('initial provider structured validation boundary', () => {
  it.each([[inventedRef], ['unknown'], [false], 'invalid', [], [inventedRef, inventedRef]].map(refs => ({ refs })))(
    'preserves ordinary reply content without historical evidence: $refs', async ({ refs }) => {
      const { validation, result } = await providerBoundary(wire([reply(refs)]));
      expect(validation).toMatchObject({ valid: true, intent: { actions: [{ domain: 'conversation', action: 'reply', content: 'Hello there.' }] } });
      expect(validation.intent.actions[0]).not.toHaveProperty('evidenceRefs');
      expect(result.confirmation).toContain('Hello there.');
      expect(executeTool).not.toHaveBeenCalled();
    });

  it('uses owner-bound evidence availability, not history prose or user claims', async () => {
    const { validation } = await providerBoundary(wire([reply(['unknown'])]), evidenceHistory('other-owner'), 'Summarize our historical evidence');
    expect(validation).toMatchObject({ valid: true });
    expect(validation.intent.actions[0].content).toBe('Hello there.');
  });

  it('accepts normalized qualified wire spelling before removing unavailable selectors', async () => {
    const { validation } = await providerBoundary(wire([{ ...reply(['unknown']), operation: ' Conversation.Reply ' }]));
    expect(validation).toMatchObject({ valid: true });
    expect(validation.intent.actions[0].content).toBe('Hello there.');
  });

  it.each([['unknown'], [false], [inventedRef, inventedRef]].map(refs => ({ refs })))('rejects malformed selectors with real evidence and executes no mutations: $refs', async ({ refs }) => {
    const { validation } = await providerBoundary(wire([reply(refs), { operation: 'task.complete', target: 'Alfa' }]), evidenceHistory());
    expect(validation.valid).toBe(false);
    expect(validation).not.toHaveProperty('intent');
    expect(executeTool).not.toHaveBeenCalled();
    expect(updateUserPreferences).not.toHaveBeenCalled();
  });

  it.each([['unknown'], [false], [inventedRef, inventedRef]].map(refs => ({ refs })))('rejects malformed historical reply selectors even without mutations: $refs', async ({ refs }) => {
    const { validation } = await providerBoundary(wire([reply(refs)]), evidenceHistory());
    expect(validation.valid).toBe(false);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('preserves a complete strict wire reply after stripping inapplicable null fields', async () => {
    const schema = getStructuredTurnSchema();
    const action = Object.fromEntries(Object.keys(schema.properties.actions.items.properties).map(key => [key, null]));
    const payload = Object.fromEntries(Object.keys(schema.properties).map(key => [key, null]));
    Object.assign(payload, wire([{ ...action, operation: 'conversation.reply', content: 'Hello there.', evidenceRefs: [inventedRef] }]));
    const { validation, result } = await providerBoundary(payload);
    expect(validation).toMatchObject({ valid: true, intent: { learningCandidates: [], actions: [{ content: 'Hello there.' }] } });
    expect(result.confirmation).toContain('Hello there.');
  });

  it('retains actual historical selectors and discards generated prose', async () => {
    const history = evidenceHistory();
    const ref = history[0].entities._turnMetadata.operationalEvidence.events[0].ref;
    const { validation, result } = await providerBoundary(wire([reply([ref])]), history);
    expect(validation).toMatchObject({ valid: true });
    expect(validation.intent.actions[0].evidenceRefs).toEqual([ref]);
    expect(validation.intent.actions[0]).not.toHaveProperty('content');
    expect(result.confirmation).toContain('Alfa');
    expect(result.confirmation).not.toContain('Hello there.');
  });

  it('does not sanitize recap or contentless selectors without evidence', async () => {
    for (const action of [
      { operation: 'conversation.recap', recapMode: 'historical', evidenceRefs: ['unknown'] },
      { operation: 'conversation.reply', evidenceRefs: ['unknown'] },
    ]) {
      vi.clearAllMocks();
      const { validation } = await providerBoundary(wire([action]));
      expect(validation.valid).toBe(false);
      expect(executeTool).not.toHaveBeenCalled();
    }
  });

  it('keeps invalid complete creation non-executable', async () => {
    const { validation } = await providerBoundary(wire([{ operation: 'reminder.create', content: 'Alfa', schedule: { kind: 'unknown' } }]));
    expect(validation).toMatchObject({ valid: false, errorCode: 'MISSING_SCHEDULE' });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('retains a partial schedule as a pending draft, without executing it', async () => {
    const schedule = { kind: 'relative_day_time', dayOffset: 1, hour: null, minute: null };
    const { validation } = await providerBoundary(wire([{ operation: 'reminder.create', content: 'Alfa', schedule, missingFields: null }]));
    expect(validation).toMatchObject({ valid: true, intent: { actions: [{ schedule: { kind: 'relative_day_time', dayOffset: 1 }, missingFields: ['time'] }] } });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('does not relax operational authority when unavailable reply references are sanitized', async () => {
    const { validation } = await providerBoundary(wire([reply(['unknown']), { operation: 'reminder.search' }]));
    expect(validation).toMatchObject({ valid: false, errorCode: 'UNSUPPORTED_ACTION' });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('retains current-user profile evidence after unavailable reply selectors are removed', async () => {
    const payload = { ...wire([reply(['unknown'])]), profileUpdate: { sourceQuote: 'English always', language: 'en' } };
    const { validation } = await providerBoundary(payload, [], 'English always');
    expect(validation).toMatchObject({ valid: true, intent: { profileUpdate: payload.profileUpdate } });
    expect(updateUserPreferences).toHaveBeenCalledWith(owner, { locale: 'en-US' });
  });

  it('rejects stale profile authority for mutations rather than sanitizing it', async () => {
    const payload = { ...wire([{ operation: 'task.complete', target: 'Alfa' }]), profileUpdate: { sourceQuote: 'English always', language: 'en' } };
    const { validation } = await providerBoundary(payload);
    expect(validation).toMatchObject({ valid: false, errorCode: 'INVALID_TURN_CONTEXT' });
    expect(executeTool).not.toHaveBeenCalled();
    expect(updateUserPreferences).not.toHaveBeenCalled();
  });
});

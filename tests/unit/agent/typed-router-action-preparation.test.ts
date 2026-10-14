import { describe, expect, it, vi } from 'vitest';
import { createRouterActionPreparation, type RouterActionDependencies, type RouterActionInput } from '../../../src/agent/orchestration/router-action-preparation.js';
import { renderPersonalKnowledge, type PersonalKnowledgeFact } from '../../../src/agent/orchestration/personal-knowledge-core.js';
import type { ValidatedIntent } from '../../../src/agent/contracts/intent-validator.js';
type Lookup = ReadonlyMap<string, PersonalKnowledgeFact>;
const reply: ValidatedIntent = { actions: [{ domain: 'conversation', action: 'reply', content: 'Hello' }], excluded: [], responseCapability: 'general' };
function fixture(intent = reply) {
  let language = 'es', timezone = 'UTC';
  const input: RouterActionInput<Lookup> = { admittedIntent: intent, user: { id: 'owner', phone_number: 'phone' }, dailyOverview: { pendingConfirmationReminders: [] }, workingMemory: null, requestId: 'request', requestReferenceTime: new Date('2027-01-14T12:00:00Z'), rawPastTurns: [], hasHistoricalEvidence: false, personalKnowledge: { lookup: new Map() }, phoneNumber: 'phone', isAttachmentOnlyTurn: false, startMs: 0, contextElapsedMs: 20, modelElapsedMs: 30, get language() { return language; }, get timezone() { return timezone; }, applyDecisionContext: vi.fn(async () => true) };
  const deps: RouterActionDependencies<Lookup, Record<string, unknown>> = {
    normalizeTurnIntentForRuntime: vi.fn(intent => intent), renderOperationalEvidence: vi.fn(() => 'Selected observed history'), renderHistoricalEvidence: vi.fn(() => 'Historical observations'),
    renderPersonalKnowledge: vi.fn((refs, lookup, userId, lang) => {
      if (!Array.isArray(refs) || !refs.every(ref => typeof ref === 'string')) throw new Error('Invalid fixture references');
      return renderPersonalKnowledge(refs, lookup, userId || '', lang);
    }),
    conversationStateEntities: vi.fn((user, extra) => ({ owner: user.id, ...extra })), getGoogleConnectUrl: vi.fn(() => 'https://example.test/auth'), now: () => 100, logger: { log: vi.fn(), warn: vi.fn() },
  };
  return { input, deps, ...createRouterActionPreparation(deps), setContext: () => { language = 'en'; timezone = 'America/Bogota'; } };
}
describe('typed post-admission action preparation', () => {
  it('keeps learning proposal metadata and blocks actions when profile persistence is unconfirmed', async () => {
    const f = fixture({ ...reply, learningCandidates: [], learningCandidatesProvided: true }); vi.mocked(f.input.applyDecisionContext).mockResolvedValue(false);
    expect(await f.prepareRouterActions(f.input)).toEqual({ handled: true, response: { language: 'es', intent: 'clarification', executionFacts: [], learningCandidates: [], learningCandidatesProvided: true } });
    expect(f.deps.normalizeTurnIntentForRuntime).not.toHaveBeenCalled(); expect(f.deps.getGoogleConnectUrl).not.toHaveBeenCalled();
  });
  it('uses updated language and timezone after current-turn context application', async () => {
    const f = fixture({ ...reply, actions: [{ domain: 'task', action: 'complete', target: 'Task' }] });
    f.input.applyDecisionContext = vi.fn(async () => { f.setContext(); return true; });
    expect(await f.prepareRouterActions(f.input)).toMatchObject({ handled: false, operationalActions: [{ domain: 'task', action: 'complete', target: 'Task' }] });
    expect(f.deps.normalizeTurnIntentForRuntime).toHaveBeenCalledWith(f.input.admittedIntent, { user: f.input.user, referenceTime: f.input.requestReferenceTime, timezone: 'America/Bogota' });
  });
  it('propagates a lost lease before normalization or link generation', async () => {
    const f = fixture(); vi.mocked(f.input.applyDecisionContext).mockRejectedValue(new Error('lease lost'));
    await expect(f.prepareRouterActions(f.input)).rejects.toThrow('lease lost'); expect(f.deps.normalizeTurnIntentForRuntime).not.toHaveBeenCalled(); expect(f.deps.getGoogleConnectUrl).not.toHaveBeenCalled();
  });
  it('binds only the observed followup hint and delegates execution to the caller', async () => {
    const f = fixture({ actions: [{ domain: 'reminder', action: 'acknowledge', target: '1' }], excluded: [], responseCapability: 'general' });
    f.input.workingMemory = { notificationReminderId: 'reminder-hint', notificationContent: 'Reminder' };
    const result = await f.prepareRouterActions(f.input); expect(result).toMatchObject({ handled: false, operationalActions: [{ authoritativeReminderId: 'reminder-hint', target: '1' }] });
    expect(f.input.admittedIntent.actions[0]).not.toHaveProperty('authoritativeReminderId');
  });
  it('renders selected historical evidence through the owner-aware host with no domain actions', async () => {
    const f = fixture({ ...reply, actions: [{ domain: 'conversation', action: 'reply', evidenceRefs: ['ref'] }] }); f.input.hasHistoricalEvidence = true;
    expect(await f.prepareRouterActions(f.input)).toMatchObject({ handled: true, response: { confirmation: 'Selected observed history', memoryDisposition: 'skip_operational', executionFacts: [] } });
    expect(f.deps.renderOperationalEvidence).toHaveBeenCalledWith(f.input.rawPastTurns, ['ref'], 'owner', 'es');
  });
  it.each([true, false])('uses the existing empty-history or no-evidence notice when empty=%s', async empty => {
    const f = fixture({ ...reply, actions: [{ domain: 'conversation', action: 'reply', evidenceRefs: ['ref'] }] }); if (!empty) f.input.rawPastTurns = [{ role: 'assistant', content: 'Prior' }];
    const result = await f.prepareRouterActions(f.input); expect(result).toMatchObject({ handled: true, response: { confirmation: empty ? '¡Hola! ¿En qué puedo ayudarte hoy?' : 'No hay acciones ni evidencia operativa previa registrada en esta conversación.' } });
    expect(f.deps.renderOperationalEvidence).not.toHaveBeenCalled();
  });
  it('preserves historical recap response shape and current recap execution preparation', async () => {
    const f = fixture({ ...reply, actions: [{ domain: 'conversation', action: 'recap', recapMode: 'historical' }] });
    const historical = await f.prepareRouterActions(f.input); expect(historical).toMatchObject({ handled: true, response: { confirmation: 'Historical observations' } });
    if (historical.handled) { expect(historical.response).not.toHaveProperty('executionFacts'); expect(historical.response).not.toHaveProperty('memoryDisposition'); }
    f.input.admittedIntent = { ...reply, actions: [{ domain: 'conversation', action: 'recap', recapMode: 'current' }, { domain: 'task', action: 'list' }] };
    expect(await f.prepareRouterActions(f.input)).toMatchObject({ handled: false, recap: { recapMode: 'current' }, operationalActions: [{ domain: 'task', action: 'list' }] });
  });
  it.each(['[checkout_url]', 'https://stripe.com/pay', 'https://mercadopago.com/pay', 'https://lemonsqueezy.com/pay'])('converts conversation reference %s to subscription information', async content => {
    const f = fixture({ ...reply, actions: [{ domain: 'conversation', action: 'reply', content }] });
    expect(await f.prepareRouterActions(f.input)).toMatchObject({ handled: false, operationalActions: [{ domain: 'subscription', action: 'info' }] }); expect(f.deps.getGoogleConnectUrl).not.toHaveBeenCalled();
  });
  it('adds one canonical billing information action without duplicating an existing one', async () => {
    const f = fixture({ ...reply, responseCapability: 'billing_info' }); expect(await f.prepareRouterActions(f.input)).toMatchObject({ handled: false, operationalActions: [{ domain: 'subscription', action: 'info' }] });
    f.input.admittedIntent = { ...f.input.admittedIntent, actions: [{ domain: 'subscription', action: 'info' }] }; const result = await f.prepareRouterActions(f.input);
    expect(result).toMatchObject({ handled: false }); if (!result.handled) expect(result.operationalActions).toHaveLength(1);
  });
  it('uses generated OAuth URLs for CTA and template replacement, preserving both legacy calls', async () => {
    const f = fixture({ ...reply, actions: [{ domain: 'conversation', action: 'reply', content: 'Connect [auth_url]' }] });
    expect(await f.prepareRouterActions(f.input)).toMatchObject({ handled: true, response: { confirmation: 'Connect https://example.test/auth', ctaUrl: 'https://example.test/auth', ctaButtonText: 'Conectar' } });
    expect(f.deps.getGoogleConnectUrl).toHaveBeenCalledTimes(2); expect(f.deps.getGoogleConnectUrl).toHaveBeenCalledWith({ userId: 'owner', phoneNumber: 'phone' });
  });
  it('retains the existing OAuth failure fallback and strips checkout placeholders in final rendering', async () => {
    const f = fixture({ ...reply, actions: [{ domain: 'conversation', action: 'reply', content: 'Connect [auth_url]' }] }); vi.mocked(f.deps.getGoogleConnectUrl).mockImplementation(() => { throw new Error('unavailable'); });
    expect(await f.prepareRouterActions(f.input)).toMatchObject({ handled: true, response: { confirmation: 'Connect [auth_url]', ctaUrl: null } });
    expect(await f.replaceTrustedLinkPlaceholders({ text: 'Info [checkout_url]', user: f.input.user })).toBe('Info ');
  });
  it('renders only personal references belonging to the current owner and preserves attachment disposition', async () => {
    const f = fixture({ ...reply, knowledgeRefs: ['owned', 'foreign'] }); f.input.personalKnowledge.lookup = new Map([['owned', { userId: 'owner', content: 'Owned memory' }], ['foreign', { userId: 'someone-else', content: 'Private foreign fact' }]]); f.input.isAttachmentOnlyTurn = true;
    const result = await f.prepareRouterActions(f.input); expect(result).toMatchObject({ handled: true, response: { memoryDisposition: 'skip_attachment', confirmation: expect.stringContaining('Owned memory') } }); if (result.handled) expect(result.response.confirmation).not.toContain('Private foreign fact');
  });
  it('warns on an empty reminder correction but returns it unchanged for the executor to validate', async () => {
    const action = { domain: 'reminder', action: 'update', target: 'Reminder' }; const f = fixture({ ...reply, actions: [action] });
    expect(await f.prepareRouterActions(f.input)).toMatchObject({ handled: false, operationalActions: [action] }); expect(f.deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining('suspicious empty reminder.update'));
  });
});

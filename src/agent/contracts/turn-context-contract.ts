import { TURN_LANGUAGE_POLICY, responseVoice } from './response-policy-contract.js';

/** Semantic choices belong to the same model decision as the actions. */
export const TURN_CONTEXT_PROPERTIES = {
  responseLanguage: {
    type: 'string', enum: ['es', 'en'],
    description: `${TURN_LANGUAGE_POLICY} Apply to the entire response, including cards/questions. For es use ${responseVoice('es')}.`,
  },
  profileUpdate: {
    type: 'object', additionalProperties: false,
    description: 'Only an explicit current-user preference/residence/timezone statement changes the durable profile. Travel/event locations, quoted text and merely speaking another language NEVER update it. Do not claim it was saved; Node confirms persistence.',
    properties: {
      sourceQuote: { type: 'string', description: 'Exact current-user authored excerpt authorizing this profile change.' },
      timezone: { type: 'string', description: 'IANA timezone for the explicitly selected residence/timezone. Preserve event locations as event context.' },
      language: { type: 'string', enum: ['es', 'en'], description: 'Emit together with exact sourceQuote for an explicit lasting language instruction (e.g. from now on), not only responseLanguage. Never persist quoted or one-turn switches.' },
    },
    required: ['sourceQuote'],
  },
};

export interface ValidatedProfileUpdate { sourceQuote: string; timezone?: string | null; language?: 'es' | 'en' | null }
export interface ValidatedTurnContext { responseLanguage?: 'es' | 'en'; profileUpdate?: ValidatedProfileUpdate }
export type TurnContextValidation = { valid: true; context: ValidatedTurnContext } | { valid: false; errorCode: 'INVALID_TURN_CONTEXT'; error: string };
function object(value: unknown): value is Record<string,unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function validateTurnContext(payload: unknown): TurnContextValidation {
  const { responseLanguage,profileUpdate } = object(payload) ? payload : {};
  const fail = (): TurnContextValidation => ({ valid:false,errorCode:'INVALID_TURN_CONTEXT',error:'Invalid language or profile update.' });
  if (responseLanguage != null && responseLanguage !== 'es' && responseLanguage !== 'en') return fail();
  let update: ValidatedProfileUpdate | undefined;
  if (profileUpdate != null) {
    if (!object(profileUpdate) || typeof profileUpdate.sourceQuote !== 'string' || !profileUpdate.sourceQuote.trim()
      || Object.keys(profileUpdate).some(key => !['sourceQuote','timezone','language'].includes(key))
      || (profileUpdate.language != null && profileUpdate.language !== 'es' && profileUpdate.language !== 'en')) return fail();
    if (profileUpdate.timezone != null) {
      if (typeof profileUpdate.timezone !== 'string') return fail();
      try { new Intl.DateTimeFormat('en',{ timeZone:profileUpdate.timezone }).format(); } catch { return fail(); }
    }
    update = { sourceQuote:profileUpdate.sourceQuote,
      ...(profileUpdate.timezone === null || typeof profileUpdate.timezone === 'string' ? { timezone:profileUpdate.timezone } : {}),
      ...(profileUpdate.language === null || profileUpdate.language === 'es' || profileUpdate.language === 'en' ? { language:profileUpdate.language } : {}),
    };
  }
  return { valid:true,context:{
    ...(responseLanguage === 'es' || responseLanguage === 'en' ? { responseLanguage } : {}),
    ...(update ? { profileUpdate:update } : {}),
  } };
}

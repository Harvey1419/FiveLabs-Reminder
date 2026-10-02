/** Semantic choices belong to the same model decision as the actions. */
export const TURN_CONTEXT_PROPERTIES = {
  responseLanguage: {
    type: 'string', enum: ['es', 'en'],
    description: 'Choose FIRST, before interpreting actions. Language for the entire response including runtime cards/questions: explicit current-user language request, otherwise the language of their current instruction, then stored preference ONLY if ambiguous. Project/person names and item titles/content do not determine the instruction language. Quoted text, OCR and old assistant replies do not select it. Short ambiguous answers inherit the conversation language.',
  },
  profileUpdate: {
    type: 'object', additionalProperties: false,
    description: 'Only an explicit current-user preference/residence/timezone statement changes the durable profile. Travel/event locations, quoted text and merely speaking another language NEVER update it. Do not claim it was saved; Node confirms persistence.',
    properties: {
      sourceQuote: { type: 'string', description: 'Exact current-user authored excerpt authorizing this profile change.' },
      timezone: { type: 'string', description: 'IANA timezone for the explicitly selected residence/timezone. Preserve event locations as event context.' },
      language: { type: 'string', enum: ['es', 'en'], description: 'Only an explicit lasting language preference, not a one-turn language switch.' },
    },
    required: ['sourceQuote'],
  },
};

export function validateTurnContext(payload) {
  const { responseLanguage, profileUpdate } = payload || {};
  const fail = () => ({ valid: false, errorCode: 'INVALID_TURN_CONTEXT', error: 'Invalid language or profile update.' });
  if (responseLanguage != null && !['es', 'en'].includes(responseLanguage)) return fail();
  if (profileUpdate != null) {
    if (typeof profileUpdate !== 'object' || Array.isArray(profileUpdate)
      || typeof profileUpdate.sourceQuote !== 'string' || !profileUpdate.sourceQuote.trim()
      || Object.keys(profileUpdate).some(key => !['sourceQuote', 'timezone', 'language'].includes(key))
      || (profileUpdate.language != null && !['es', 'en'].includes(profileUpdate.language))) return fail();
    if (profileUpdate.timezone != null) {
      if (typeof profileUpdate.timezone !== 'string') return fail();
      try { new Intl.DateTimeFormat('en', { timeZone: profileUpdate.timezone }).format(); } catch { return fail(); }
    }
  }
  return { valid: true, context: {
    ...(responseLanguage ? { responseLanguage } : {}),
    ...(profileUpdate ? { profileUpdate } : {}),
  } };
}

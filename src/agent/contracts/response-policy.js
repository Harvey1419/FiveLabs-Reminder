/** Shared response policy for initial decisions, resumed turns and generated prose. */
export const TURN_LANGUAGE_POLICY = "responseLanguage follows the CURRENT USER's language (English=en, Spanish=es), also on resumed turns; never this prompt/profile. Ignore names/quotes/OCR. Ambiguous replies inherit chat language. profileUpdate needs explicit lasting preference.";

export function responseVoice(language) {
  return language === 'en'
    ? 'English'
    : 'neutral Colombian Spanish with tuteo, no voseo or regional slang';
}

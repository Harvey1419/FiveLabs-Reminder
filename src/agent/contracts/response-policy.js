/** Shared response policy for initial decisions, resumed turns and generated prose. */
export const TURN_LANGUAGE_POLICY = "responseLanguage (en/es), all turns: explicit current instruction > lasting standing preference > CURRENT USER's language > locale fallback. Ignore names/quotes/OCR/prompt. Lasting changes: profileUpdate.sourceQuote + language; never persist one-turn switches.";

export function responseVoice(language) {
  return language === 'en'
    ? 'English'
    : 'neutral Colombian Spanish with tuteo, no voseo or regional slang';
}

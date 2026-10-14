export interface OnboardingUser { id?: string; timezone?: string | null; locale?: string | null }
export interface OnboardingInput { user?: OnboardingUser | null; phoneNumber?: unknown; messageText?: string; displayName?: string; correlationId?: string }
export interface OnboardingDependencies {
 detectTimezoneFromPhone: typeof import('../../shared/time.js').detectTimezoneFromPhone;
 isRecognizedNanpAreaCode: typeof import('../../shared/time.js').isRecognizedNanpAreaCode;
 getDefaultTimezone(): string;
 detectLanguageFromText: typeof import('../../shared/language-detection.js').detectLanguageFromText;
 updateUserPreferences(userId: string, preferences: { timezone: string; locale: string }): Promise<unknown>;
 getOpenRouterApiKey(): string | null | undefined;
 callOpenRouterChat(messages: { role: string; content: string }[], model: string, apiKey: string, options: { temperature: number; maxTokens: number; responseFormat: { type: string }; logPrefix: string }): Promise<unknown>;
 getModelConfig(): { openrouter?: { primary?: string } } | null | undefined;
 logger: Pick<Console, 'log' | 'warn'>;
}

export function createUserOnboarding({ detectTimezoneFromPhone, isRecognizedNanpAreaCode, getDefaultTimezone, detectLanguageFromText, updateUserPreferences, getOpenRouterApiKey, callOpenRouterChat, getModelConfig, logger }: OnboardingDependencies) {

function isValidIanaTimezone(tz: unknown): tz is string {
  if (!tz || typeof tz !== 'string') return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Inspect whether a phone number has a deterministic, high-confidence timezone mapping.
 *
 * @param {string} rawPhone
 * @returns {boolean}
 */
function isDeterministicPhoneTimezone(rawPhone: unknown) {
  if (!rawPhone || typeof rawPhone !== 'string') return false;
  const digits = rawPhone.replace(/\D/g, '');
  if (!digits) return false;

  // BSUID with known country
  if (rawPhone.includes('.')) return true;

  // US/Canada: starts with 1 and has at least 4 digits
  if (digits.startsWith('1') && digits.length >= 4) {
    const areaCode = digits.slice(1, 4);
    return isRecognizedNanpAreaCode(areaCode);
  }

  // International calling codes outside +1
  return digits.length >= 2;
}

/**
 * Perform cognitive internal onboarding for a user upon initial contact or when profile metadata is ambiguous.
 *
 * @param {Object} params
 * @param {Object} [params.user] - User database record
 * @param {string} params.phoneNumber - Raw or normalized phone number
 * @param {string} [params.messageText] - Initial message text from the user
 * @param {string} [params.displayName] - Contact display name
 * @param {string} [params.correlationId]
 * @returns {Promise<{ timezone: string, locale: string, source: 'deterministic' | 'llm' | 'fallback' }>}
 */
async function inferUserOnboardingMetadata({
  user = null,
  phoneNumber = '',
  messageText = '',
  displayName = '',
  correlationId = '',
}: OnboardingInput = {}) {
  const logPrefix = correlationId ? `[onboarding req=${correlationId}]` : '[onboarding]';
  const cleanPhone = String(phoneNumber || '').trim();

  // 1. Fast Deterministic Evaluation
  const deterministicTz = detectTimezoneFromPhone(cleanPhone);
  const detectedLang = detectLanguageFromText(messageText);
  const hasConfidentTz = isDeterministicPhoneTimezone(cleanPhone);

  const resolvedLocale = detectedLang
    ? (detectedLang === 'en' ? 'en-US' : 'es-CO')
    : (user?.locale || 'es-CO');

  if (hasConfidentTz && detectedLang) {
    logger.log(`${logPrefix} Deterministic onboarding: phone=${cleanPhone} tz=${deterministicTz} locale=${resolvedLocale}`);
    if (user?.id && (user.timezone !== deterministicTz || user.locale !== resolvedLocale)) {
      user.timezone = deterministicTz;
      user.locale = resolvedLocale;
      await updateUserPreferences(user.id, { timezone: deterministicTz, locale: resolvedLocale });
    }
    return { timezone: deterministicTz, locale: resolvedLocale, source: 'deterministic' };
  }

  // 2. Cognitive LLM Fallback (when phone timezone is unmapped or language is ambiguous)
  const apiKey = getOpenRouterApiKey();
  if (apiKey) {
    try {
      logger.log(`${logPrefix} Running cognitive LLM onboarding for ambiguous contact phone=${cleanPhone}...`);
      const messages = [
        {
          role: 'system',
          content: 'You are an expert phone geolocation and language detection classifier. Given a phone number, user message, and display name, return ONLY a valid JSON object with {"timezone": "Valid/IANA_Timezone", "locale": "es-CO"|"en-US"}. The language used in the message is authoritative. If Spanish, use es-CO. If English, use en-US. For phone timezones, prefer accurate regional IANA zones (e.g. America/Los_Angeles, America/New_York, America/Chicago, America/Bogota, Europe/Madrid, etc.).',
        },
        {
          role: 'user',
          content: JSON.stringify({
            phoneNumber: cleanPhone,
            message: messageText || '',
            displayName: displayName || '',
          }),
        },
      ];

      const model = getModelConfig()?.openrouter?.primary || 'openai/gpt-oss-120b';
      const rawResponse = await callOpenRouterChat(messages, model, apiKey, {
        temperature: 0.1,
        maxTokens: 120,
        responseFormat: { type: 'json_object' },
        logPrefix,
      });

      if (rawResponse) {
        const parsed = JSON.parse(rawResponse as string) as { timezone?: string | null; locale?: string | null };
        const inferredTz = parsed.timezone?.trim();
        const inferredLocale = parsed.locale?.trim() === 'en-US' ? 'en-US' : 'es-CO';

        if (isValidIanaTimezone(inferredTz)) {
          logger.log(`${logPrefix} LLM onboarding resolved: tz=${inferredTz} locale=${inferredLocale}`);
          if (user?.id) {
            user.timezone = inferredTz;
            user.locale = inferredLocale;
            await updateUserPreferences(user.id, { timezone: inferredTz, locale: inferredLocale });
          }
          return { timezone: inferredTz, locale: inferredLocale, source: 'llm' };
        }
      }
    } catch (llmErr) {
      logger.warn(`${logPrefix} LLM onboarding classification error:`, (llmErr as { message?: string } | null | undefined)?.message || llmErr);
    }
  }

  // 3. Graceful Fallback
  const finalTz = deterministicTz || user?.timezone || getDefaultTimezone();
  const finalLocale = resolvedLocale || user?.locale || 'es-CO';

  if (user?.id && (user.timezone !== finalTz || user.locale !== finalLocale)) {
    user.timezone = finalTz;
    user.locale = finalLocale;
    await updateUserPreferences(user.id, { timezone: finalTz, locale: finalLocale });
  }

  return { timezone: finalTz, locale: finalLocale, source: 'fallback' };
}

return { isValidIanaTimezone, isDeterministicPhoneTimezone, inferUserOnboardingMetadata };
}

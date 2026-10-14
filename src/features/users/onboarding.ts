import { detectTimezoneFromPhone, isRecognizedNanpAreaCode, DEFAULT_TIMEZONE } from '../../shared/time.js';
import { detectLanguageFromText } from '../../shared/language-detection.js';
import { updateUserPreferences } from '../../infrastructure/database/users.js';
import { getOpenRouterApiKey, callOpenRouterChat, MODEL_CONFIG } from '../../agent/providers/client.js';
import { createUserOnboarding } from './user-onboarding.js';
const service = createUserOnboarding({
  detectTimezoneFromPhone: ((...args: Parameters<typeof detectTimezoneFromPhone>) => detectTimezoneFromPhone(...args)) as unknown as Parameters<typeof createUserOnboarding>[0]['detectTimezoneFromPhone'],
  isRecognizedNanpAreaCode: ((...args: Parameters<typeof isRecognizedNanpAreaCode>) => isRecognizedNanpAreaCode(...args)) as unknown as Parameters<typeof createUserOnboarding>[0]['isRecognizedNanpAreaCode'],
  getDefaultTimezone: () => DEFAULT_TIMEZONE,
  detectLanguageFromText: ((...args: Parameters<typeof detectLanguageFromText>) => detectLanguageFromText(...args)) as unknown as Parameters<typeof createUserOnboarding>[0]['detectLanguageFromText'],
  updateUserPreferences: ((...args: Parameters<typeof updateUserPreferences>) => updateUserPreferences(...args)) as unknown as Parameters<typeof createUserOnboarding>[0]['updateUserPreferences'],
  getOpenRouterApiKey: ((...args: Parameters<typeof getOpenRouterApiKey>) => getOpenRouterApiKey(...args)) as unknown as Parameters<typeof createUserOnboarding>[0]['getOpenRouterApiKey'],
  callOpenRouterChat: ((...args: Parameters<typeof callOpenRouterChat>) => callOpenRouterChat(...args)) as unknown as Parameters<typeof createUserOnboarding>[0]['callOpenRouterChat'],
  getModelConfig: () => MODEL_CONFIG,
  logger: console});
export function isValidIanaTimezone(...args: Parameters<typeof service.isValidIanaTimezone>) { return service.isValidIanaTimezone(...args); }
export function isDeterministicPhoneTimezone(...args: Parameters<typeof service.isDeterministicPhoneTimezone>) { return service.isDeterministicPhoneTimezone(...args); }
export function inferUserOnboardingMetadata(...args: Parameters<typeof service.inferUserOnboardingMetadata>) { return service.inferUserOnboardingMetadata(...args); }



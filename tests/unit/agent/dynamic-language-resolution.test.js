import { beforeEach, expect, it, vi, describe } from 'vitest';

vi.mock('../../../src/agent/tools/index.js', () => ({ executeTool: vi.fn() }));
vi.mock('../../../src/agent/providers/client.js', () => ({
  callChatCompletion: vi.fn(),
  callResponseSynthesis: vi.fn(),
}));
vi.mock('../../../src/features/memory/service.js', () => ({
  retrieveRelevantMemories: vi.fn().mockResolvedValue([]),
  retrieveStandingPreferences: vi.fn().mockResolvedValue([]),
  getProactiveAnchors: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../src/infrastructure/database/index.js', () => ({
  getDailyOverview: vi.fn().mockResolvedValue(null),
  getUserSubscription: vi.fn().mockResolvedValue(null),
  getUserIntegration: vi.fn().mockResolvedValue(null),
  hasProAccess: vi.fn(() => false),
}));
vi.mock('../../../src/infrastructure/database/users.js', () => ({ updateUserPreferences: vi.fn() }));
vi.mock('../../../src/integrations/google/auth.js', () => ({
  getGoogleConnectUrl: vi.fn(),
  hasUsableGoogleCredentials: vi.fn(() => false),
}));

import { routeMessage } from '../../../src/agent/orchestration/router.js';
import { callChatCompletion } from '../../../src/agent/providers/client.js';

describe('Dynamic Turn Language Resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves to English when user speaks English even if conversation history was in Spanish', async () => {
    const user = { id: 'u1', phone_number: '16282419573', timezone: 'America/Los_Angeles', locale: 'en-US' };
    const history = [
      { role: 'user', content: 'Hola' },
      { role: 'assistant', content: '¿En qué te ayudo?', entities: { _responseLanguage: 'es' } },
    ];

    callChatCompletion.mockImplementation(async (messages, options) => {
      // Expect that language passed to initial completion is 'en'
      expect(options.language).toBe('en');
      return {
        content: JSON.stringify({
          responseLanguage: 'en',
          responseCapability: 'general',
          actions: [{ operation: 'conversation.reply', content: 'What time should I remind you?' }],
        }),
      };
    });

    const result = await routeMessage("Remind me , wash cat's feeders", user, history);
    expect(result.language).toBe('en');
    expect(result.confirmation).toBe('What time should I remind you?');
  });

  it('resolves to Spanish when user speaks Spanish even if conversation history was in English', async () => {
    const user = { id: 'u1', phone_number: '16282419573', timezone: 'America/Los_Angeles', locale: 'es-CO' };
    const history = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'How can I help?', entities: { _responseLanguage: 'en' } },
    ];

    callChatCompletion.mockImplementation(async (messages, options) => {
      expect(options.language).toBe('es');
      return {
        content: JSON.stringify({
          responseLanguage: 'es',
          responseCapability: 'general',
          actions: [{ operation: 'conversation.reply', content: '¿A qué hora te recuerdo?' }],
        }),
      };
    });

    const result = await routeMessage('Recuérdame lavar los platos a las 5', user, history);
    expect(result.language).toBe('es');
    expect(result.confirmation).toBe('¿A qué hora te recuerdo?');
  });

  it('preserves conversationLanguage when user sends an indeterminate/neutral utterance', async () => {
    const user = { id: 'u1', phone_number: '16282419573', timezone: 'America/Los_Angeles', locale: 'es-CO' };
    const history = [
      { role: 'user', content: "Remind me , wash cat's feeders" },
      { role: 'assistant', content: 'At what time?', entities: { _responseLanguage: 'en' } },
    ];

    callChatCompletion.mockImplementation(async (messages, options) => {
      // Indeterminate utterance "4:45" should inherit 'en' from prior turn
      expect(options.language).toBe('en');
      return {
        content: JSON.stringify({
          responseLanguage: 'en',
          responseCapability: 'general',
          actions: [{ operation: 'conversation.reply', content: 'Reminder set for 4:45 PM.' }],
        }),
      };
    });

    const result = await routeMessage('4:45', user, history);
    expect(result.language).toBe('en');
  });

  it('falls back to user.locale when input is indeterminate and there is no conversation history', async () => {
    const user = { id: 'u1', phone_number: '16282419573', timezone: 'America/Los_Angeles', locale: 'en-US' };

    callChatCompletion.mockImplementation(async (messages, options) => {
      expect(options.language).toBe('en');
      return {
        content: JSON.stringify({
          responseLanguage: 'en',
          responseCapability: 'general',
          actions: [{ operation: 'conversation.reply', content: 'Understood.' }],
        }),
      };
    });

    const result = await routeMessage('4:45', user, []);
    expect(result.language).toBe('en');
  });
});

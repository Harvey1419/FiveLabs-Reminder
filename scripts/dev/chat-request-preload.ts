// Loaded with NODE_OPTIONS="--import=tsx --import=./scripts/dev/chat-request-preload.ts" before app imports.
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { phaseChildProof, reservePhaseRequest, guardPhaseDatabaseRequest } from './chat-validation-session.js';
const originalFetch = globalThis.fetch;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const phaseHandle = process.env.HERMES_CHAT_PHASE_HANDLE;
const phaseToken = process.env.HERMES_CHAT_PHASE_TOKEN;
const context = { root, database: process.env.SUPABASE_URL };
if (phaseHandle) {
  if (resolve(process.argv[1] || '') !== resolve(root, 'scripts/dev/interactive-chat.ts')) throw new Error('Phase preload requires owned CLI entrypoint');
  const state = phaseChildProof(phaseHandle, context, phaseToken, { register: true });
  if (state.phone !== process.env.HERMES_CHAT_TEST_PHONE || process.env.HERMES_CHAT_DISABLE_REMINDER_SCHEDULER !== '1') throw new Error('Phase preload owner mismatch');
}
const supabaseUrl = process.env.SUPABASE_URL;
const configuredLimit = process.env.HERMES_CHAT_OPENROUTER_REQUEST_LIMIT;
const limit = Number(configuredLimit);
if (!Number.isSafeInteger(limit) || limit < 0 || limit > 300) {
  throw new Error('HERMES_CHAT_OPENROUTER_REQUEST_LIMIT must be an integer from 0 to 300');
}
if (!supabaseUrl) throw new Error('SUPABASE_URL is required for chat request guard');
const database = new URL(supabaseUrl);
if (database.protocol !== 'https:') throw new Error('SUPABASE_URL must use HTTPS');
let providerRequests = 0;
process.on('exit', () => {
  console.log(`HERMES_CHAT_OPENROUTER_REQUEST_COUNT=${providerRequests}`);
});

globalThis.fetch = function guardedChatFetch(input, init) {
  const url = new URL(input instanceof Request ? input.url : input);
  const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const provider = url.origin === 'https://openrouter.ai' &&
    ['/api/v1/chat/completions', '/api/v1/embeddings'].includes(url.pathname) && method === 'POST';
  if (provider) {
    if (providerRequests >= limit) throw new Error('OpenRouter request cap reached');
    if (phaseHandle) reservePhaseRequest(phaseHandle, context, phaseToken,
      url.pathname.endsWith('/embeddings') ? 'embeddings' : 'chat');
    providerRequests++;
    return originalFetch.call(globalThis, input, init);
  }
  const rest = url.origin === database.origin &&
    url.pathname.startsWith(`${database.pathname.replace(/\/$/, '')}/rest/v1/`);
  if (rest) {
    if (phaseHandle) return guardPhaseDatabaseRequest(input, init,
      phaseChildProof(phaseHandle, context, phaseToken), originalFetch.bind(globalThis), supabaseUrl);
    const resource = url.pathname.slice(`${database.pathname.replace(/\/$/, '')}/rest/v1/`.length);
    const readable = /^[a-z_]+$/.test(resource);
    const writable = new Set(['users', 'messages', 'tasks', 'reminders', 'memories', 'entities', 'projects', 'agent_runs', 'agent_execution_events', 'prepared_actions']);
    const readRpc = resource === 'rpc/match_memories' && method === 'POST';
    if ((readable && ['GET', 'HEAD'].includes(method)) || readRpc ||
        (writable.has(resource) && ['POST', 'PATCH', 'DELETE'].includes(method))) {
      return originalFetch.call(globalThis, input, init);
    }
  }
  throw new Error(`Chat validation blocked outbound request: ${method} ${url.origin}${url.pathname}`);
};

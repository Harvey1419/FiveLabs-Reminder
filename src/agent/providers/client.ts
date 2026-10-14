import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createGatewayAttempt } from './gateway-attempt.js';
import { createGatewayChain } from './gateway-chain.js';
import { createGatewayRouting } from './gateway-routing.js';
import { createGatewayDispatch } from './gateway-dispatch.js';
import { createRunnerProviderTrace } from './runner-provider-trace.js';

const routing = createGatewayRouting({ getEnvironment: () => process.env });
export const { MODEL_CONFIG, getOpenRouterApiKey } = routing;
const { performOpenRouterAttempt } = createGatewayAttempt({
  fetch: (...args) => fetch(...args), now: () => Date.now(), monotonicNow: () => performance.now(), logger: console,
});
const trace = createRunnerProviderTrace({
  traceEntrypoint: fileURLToPath(new URL(import.meta.url.includes('/dist/runtime/') ? '../../../../scripts/dev/interactive-chat.ts' : '../../../scripts/dev/interactive-chat.ts', import.meta.url)),
  getEnvironment: () => process.env, getArgv: () => process.argv, getUid: () => process.getuid?.(),
  onceExit: callback => { process.once('exit', callback); },
  removeExit: callback => { process.removeListener('exit', callback); },
  logger: console, performOpenRouterAttempt: (...args) => performOpenRouterAttempt(...args),
});
export const { finalizeRunnerProviderTrace } = trace;
const { runOpenRouterChain } = createGatewayChain({ callOpenRouterAttempt: (...args) => trace.callOpenRouterAttempt(...args), logger: console });
export const { callChatCompletion, callResponseSynthesis, callOpenRouterChat, callMemoryExtraction } = createGatewayDispatch({
  getOpenRouterApiKey: (...args) => routing.getOpenRouterApiKey(...args),
  createForegroundProfiles: (...args) => routing.createForegroundProfiles(...args),
  createBackgroundProfiles: (...args) => routing.createBackgroundProfiles(...args),
  runOpenRouterChain: (...args) => runOpenRouterChain(...args),
  callOpenRouterAttempt: (...args) => trace.callOpenRouterAttempt(...args), logger: console,
});
export { buildResponseSynthesisMessages, normalizeResponseSynthesis } from './response-synthesis-presentation.js';

export type { ResponseSynthesisInput } from './response-synthesis-presentation.js';
export type LegacyBackgroundOpenRouterConfiguration = typeof MODEL_CONFIG.openrouter;
export type LegacyOpenRouterConfiguration = Pick<LegacyBackgroundOpenRouterConfiguration, 'primary' | 'primaryProviders' | 'secondary' | 'secondaryProviders' | 'lastResort' | 'lastResortProviders'>;
export type LegacyStrictOpenRouterConfiguration = LegacyOpenRouterConfiguration & Pick<LegacyBackgroundOpenRouterConfiguration, 'strictSecondary' | 'strictSecondaryProviders' | 'strictLastResort' | 'strictLastResortProviders'>;

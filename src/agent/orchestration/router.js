// Canonical agent entrypoint.
// The legacy manifest router was removed: Hermes now executes semantic TurnIntent
// actions directly through router-v2 -> intent-executor -> deterministic domain tools.
export { routeMessage } from './router-v2.js';

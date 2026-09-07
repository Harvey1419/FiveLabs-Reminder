// Canonical agent entrypoint.
// Hermes executes semantic TurnIntent actions directly through the deterministic
// intent executor. There is no legacy manifest/repair pipeline behind this API.
export { routeMessage } from './router-core.js';

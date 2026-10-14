import { createStripeClient } from './checkout-client.js';
export { STRIPE_DEFAULT_CHECKOUT_URL } from './checkout-client.js';

const client = createStripeClient({ getEnvironment: () => process.env, now: () => Date.now(), logger: console });
export function buildStripeCheckoutUrl(...args: Parameters<typeof client.buildStripeCheckoutUrl>) { return client.buildStripeCheckoutUrl(...args); }
export function getShortStripeCheckoutUrl(...args: Parameters<typeof client.getShortStripeCheckoutUrl>) { return client.getShortStripeCheckoutUrl(...args); }
export function verifyStripeSignature(...args: Parameters<typeof client.verifyStripeSignature>) { return client.verifyStripeSignature(...args); }

import { assertTurnLease, currentTurnSignal } from '../../agent/core/turn-lease.js';
import { createStripeSubscriptionClient } from './subscription-client.js';
const subscriptions = createStripeSubscriptionClient({ getEnvironment: () => process.env, fetch: (...args) => fetch(...args), assertTurnLease, currentTurnSignal });
export function cancelStripeSubscription(...args: Parameters<typeof subscriptions.cancelStripeSubscription>) { return subscriptions.cancelStripeSubscription(...args); }



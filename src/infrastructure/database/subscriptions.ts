import { supabase } from './index.js';
import { cancelStripeSubscription } from '../../integrations/stripe/client.js';
import { createSubscriptionPolicy } from './subscription-policy.js';
import { createSubscriptionPersistence } from './subscription-persistence.js';

const policy = createSubscriptionPolicy({
  now: () => Date.now(), getEnvironment: () => process.env,
});
const store = createSubscriptionPersistence({
  getClient: () => supabase as unknown as ReturnType<Parameters<typeof createSubscriptionPersistence>[0]['getClient']>, cancelSubscription: (...args) => cancelStripeSubscription(...args),
  now: () => new Date(), logger: console,
});

// Keep hoisted public declarations for the existing index/subscriptions cycle.
export function hasProAccess(...args: Parameters<typeof policy.hasProAccess>) { return policy.hasProAccess(...args); }
export function shouldEnforceBillingForUser(...args: Parameters<typeof policy.shouldEnforceBillingForUser>) { return policy.shouldEnforceBillingForUser(...args); }
export function getUserSubscription(...args: Parameters<typeof store.getUserSubscription>) { return store.getUserSubscription(...args); }
export function getSubscriptionByMpId(...args: Parameters<typeof store.getSubscriptionByMpId>) { return store.getSubscriptionByMpId(...args); }
export function createPendingSubscription(...args: Parameters<typeof store.createPendingSubscription>) { return store.createPendingSubscription(...args); }
export function updateSubscriptionFromWebhook(...args: Parameters<typeof store.updateSubscriptionFromWebhook>) { return store.updateSubscriptionFromWebhook(...args); }
export function cancelUserSubscription(...args: Parameters<typeof store.cancelUserSubscription>) { return store.cancelUserSubscription(...args); }



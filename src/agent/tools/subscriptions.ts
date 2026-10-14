import {
  cancelUserSubscription,
  getUserSubscription,
  hasProAccess,
} from '../../infrastructure/database/index.js';
import { resolveReminderProUpgradeContext, selectReminderProProvider } from './reminder-pro.js';
import { buildStripeCheckoutUrl } from '../../integrations/stripe/client.js';
import { createSubscriptionTool } from './subscription-tool.js';
const service = createSubscriptionTool({
  cancelUserSubscription: ((...args: Parameters<typeof cancelUserSubscription>) => cancelUserSubscription(...args)) as unknown as Parameters<typeof createSubscriptionTool>[0]['cancelUserSubscription'],
  getUserSubscription: ((...args: Parameters<typeof getUserSubscription>) => getUserSubscription(...args)) as unknown as Parameters<typeof createSubscriptionTool>[0]['getUserSubscription'],
  hasProAccess: ((...args: Parameters<typeof hasProAccess>) => hasProAccess(...args)) as unknown as Parameters<typeof createSubscriptionTool>[0]['hasProAccess'],
  resolveReminderProUpgradeContext: ((...args: Parameters<typeof resolveReminderProUpgradeContext>) => resolveReminderProUpgradeContext(...args)) as unknown as Parameters<typeof createSubscriptionTool>[0]['resolveReminderProUpgradeContext'],
  selectReminderProProvider: ((...args: Parameters<typeof selectReminderProProvider>) => selectReminderProProvider(...args)) as unknown as Parameters<typeof createSubscriptionTool>[0]['selectReminderProProvider'],
  buildStripeCheckoutUrl: ((...args: Parameters<typeof buildStripeCheckoutUrl>) => buildStripeCheckoutUrl(...args)) as unknown as Parameters<typeof createSubscriptionTool>[0]['buildStripeCheckoutUrl'],
  logger: console,
});
export function executeSubscriptionTool(...args: Parameters<typeof service.executeSubscriptionTool>) { return service.executeSubscriptionTool(...args); }



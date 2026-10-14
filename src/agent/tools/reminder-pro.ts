import { buildStripeCheckoutUrl, getShortStripeCheckoutUrl } from '../../integrations/stripe/client.js';
import { createReminderProContext } from './reminder-pro-context.js';
export { REMINDER_PRO_FALLBACK, selectReminderProProvider } from './reminder-pro-context.js';
export const { resolveReminderProUpgradeContext } = createReminderProContext({ buildStripeCheckoutUrl: ((...args: Parameters<typeof buildStripeCheckoutUrl>) => buildStripeCheckoutUrl(...args)) as unknown as Parameters<typeof createReminderProContext>[0]['buildStripeCheckoutUrl'], getShortStripeCheckoutUrl: ((...args: Parameters<typeof getShortStripeCheckoutUrl>) => getShortStripeCheckoutUrl(...args)) as unknown as Parameters<typeof createReminderProContext>[0]['getShortStripeCheckoutUrl']});



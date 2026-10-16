import {
  subscriptionInfoInputSchema, subscriptionCheckoutInputSchema, subscriptionCancelInputSchema,
  subscriptionResultSchema, type SubscriptionRequest, type SubscriptionResult, type TurnContext,
} from '@templelabs/contracts';
import type { ToolOutcome } from './index.js';
import { defineTool } from './define-tool.js';

export interface SubscriptionDomainPort {
  execute(request: SubscriptionRequest, context: TurnContext, operationId: string): Promise<ToolOutcome<SubscriptionResult>>;
}

export function createSubscriptionTools(port: SubscriptionDomainPort) {
  return [
    defineTool({
      name: 'subscription_info', effect: 'read', requiredCapability: 'subscriptions.read',
      description: 'Check subscription status, Pro features, benefits, and pricing details.',
      inputSchema: subscriptionInfoInputSchema, outputSchema: subscriptionResultSchema,
      handler: (input, context, operationId) => port.execute({ operation: 'info', input }, context, operationId),
    }),
    defineTool({
      name: 'subscription_checkout', effect: 'read', requiredCapability: 'subscriptions.checkout',
      description: 'Generate a secure Stripe Checkout URL for upgrading to Hermes Pro.',
      inputSchema: subscriptionCheckoutInputSchema, outputSchema: subscriptionResultSchema,
      handler: (input, context, operationId) => port.execute({ operation: 'checkout', input }, context, operationId),
    }),
    defineTool({
      name: 'subscription_cancel', effect: 'destructive', requiredCapability: 'subscriptions.cancel',
      description: 'Cancel the active Pro subscription after the user confirms cancellation.',
      inputSchema: subscriptionCancelInputSchema, outputSchema: subscriptionResultSchema,
      handler: (input, context, operationId) => port.execute({ operation: 'cancel', input }, context, operationId),
    }),
  ] as const;
}

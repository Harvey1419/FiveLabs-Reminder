import { z } from 'zod';
import { domainIssueSchema, domainPresentationSchema } from './domain-results.js';

export const subscriptionToolNameSchema = z.enum(['subscription_info', 'subscription_checkout', 'subscription_cancel']);

export const subscriptionInfoInputSchema = z.strictObject({});
export type SubscriptionInfoInput = z.infer<typeof subscriptionInfoInputSchema>;

export const subscriptionCheckoutInputSchema = z.strictObject({});
export type SubscriptionCheckoutInput = z.infer<typeof subscriptionCheckoutInputSchema>;

export const subscriptionCancelInputSchema = z.strictObject({
  confirmed: z.boolean().optional(),
});
export type SubscriptionCancelInput = z.infer<typeof subscriptionCancelInputSchema>;

export type SubscriptionRequest =
  | { operation: 'info'; input: SubscriptionInfoInput }
  | { operation: 'checkout'; input: SubscriptionCheckoutInput }
  | { operation: 'cancel'; input: SubscriptionCancelInput };

export const subscriptionResultSchema = z.strictObject({
  operation: z.enum(['info', 'checkout', 'cancel']),
  isPro: z.boolean(),
  plan: z.string().max(100),
  status: z.string().max(100),
  benefits: z.array(z.string().max(200)).max(10),
  price: z.number().nonnegative(),
  currency: z.string().max(10),
  checkoutUrl: z.string().max(2000).nullable().optional(),
  complete: z.boolean().default(true),
  issues: z.array(domainIssueSchema).max(10),
  presentation: domainPresentationSchema,
});
export type SubscriptionResult = z.infer<typeof subscriptionResultSchema>;

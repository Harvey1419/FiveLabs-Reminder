import { z } from 'zod';

export const domainPresentationSchema = z.strictObject({
  canonicalCard: z.string().max(20000).nullable(),
  questions: z.array(z.string().max(4000)).max(10),
  cta: z.strictObject({
    url: z.string().max(2000), header: z.string().max(2000).nullable(),
    buttonText: z.string().max(200).nullable(),
  }).nullable(),
});
export const domainIssueSchema = z.strictObject({ code: z.string().min(1).max(80), reason: z.string().max(4000) });
export const temporalScopeSchema = z.enum([
  'today', 'remaining_today', 'tomorrow', 'day_after_tomorrow',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'this_week', 'next_week', 'this_weekend', 'upcoming',
]);


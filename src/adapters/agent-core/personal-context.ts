import { z } from 'zod';

export interface PersonalContextReads {
  memories(query: { userId: string; queryText: string; limit: number }): Promise<unknown>;
  preferences(query: { userId: string; limit: number }): Promise<unknown>;
}
const row = z.object({ id: z.string().min(1), content: z.string(), user_id: z.string().min(1),
  category: z.enum(['fact', 'preference', 'decision', 'episode', 'observation']), is_active: z.literal(true),
  superseded_by: z.string().nullish(), valid_from: z.string().nullish(), valid_until: z.string().nullish() });

/** Owned, bounded data only. Failure of optional personalization never blocks an action. */
export async function readPersonalContext(userId: string, text: string, displayName: string | undefined, reads: PersonalContextReads) {
  const optional = async (work: () => Promise<unknown>): Promise<unknown> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([Promise.resolve().then(work), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Optional personal context timed out')), 1500);
    })]).finally(() => clearTimeout(timer));
  };
  const values = await Promise.allSettled([
    optional(() => reads.memories({ userId, queryText: text, limit: 2 })),
    optional(() => reads.preferences({ userId, limit: 6 })),
  ]);
  const ownedRows = (index: number): z.infer<typeof row>[] => {
    const result = values[index];
    if (result?.status !== 'fulfilled' || !Array.isArray(result.value)) return [];
    return result.value.slice(0, index === 1 ? 6 : 2).flatMap(value => {
      const parsed = row.safeParse(value);
      return parsed.success && parsed.data.user_id === userId && !parsed.data.superseded_by
        && (parsed.data.valid_until == null || Date.parse(parsed.data.valid_until) > Date.now())
        && (parsed.data.valid_from == null || Date.parse(parsed.data.valid_from) <= Date.now())
        ? [parsed.data] : [];
    });
  };
  // The standing reader also returns profile facts. A fact is data, never a behavioral preference.
  const records = [...ownedRows(1), ...ownedRows(0)];
  const bounded = (preference: boolean) => [...new Set(records.filter(record => (record.category === 'preference') === preference)
    .map(record => record.content.trim().slice(0, 160)).filter(Boolean))].slice(0, 2);
  return { ...(displayName?.trim() ? { displayName: displayName.trim().slice(0, 60) } : {}), memories: bounded(false), preferences: bounded(true) };
}

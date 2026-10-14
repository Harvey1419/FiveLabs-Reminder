import { z } from 'zod';

export interface PersonalContextReads {
  memories(query: { userId: string; queryText: string; limit: number }): Promise<unknown>;
  preferences(query: { userId: string; limit: number }): Promise<unknown>;
}
const row = z.object({ content: z.string(), user_id: z.string().optional() });

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
    optional(() => reads.preferences({ userId, limit: 2 })),
  ]);
  const bounded = (index: number): string[] => {
    const result = values[index];
    if (result?.status !== 'fulfilled' || !Array.isArray(result.value)) return [];
    return result.value.flatMap(value => {
      const parsed = row.safeParse(value);
      return parsed.success && (!parsed.data.user_id || parsed.data.user_id === userId)
        ? [parsed.data.content.trim().slice(0, 160)] : [];
    }).filter(Boolean).slice(0, 2);
  };
  return { ...(displayName?.trim() ? { displayName: displayName.trim().slice(0, 60) } : {}), memories: bounded(0), preferences: bounded(1) };
}

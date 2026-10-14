/** Serialize one user's notifications while allowing independent users to proceed. */
export function createUserWebhookQueue(queues = new Map<string, Promise<void>>()) {
  return async function runSerializedForUser<T>(userId: string | null | undefined, task: () => Promise<T>): Promise<T> {
    if (!userId) return task();
    const previous = queues.get(userId) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => current, () => current);
    queues.set(userId, tail);
    try {
      await previous;
      return await task();
    } finally {
      release();
      // The stored value is the chained tail, not current; retain newer queued work.
      if (queues.get(userId) === tail) queues.delete(userId);
    }
  };
}

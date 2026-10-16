import { createBudgetedTransport, type Rate } from './live-evaluation-budget.js';

/** Each HTTP dispatch owns a strict reservation. Unknown usage remains reserved
 * globally, while the product may perform its own schema correction. This layer
 * never retries a request or assumes that an error was free.
 */
export function createConservativeEvaluationTransport(options: {
  fetch: typeof globalThis.fetch; rates: Record<string, Rate>; maxCalls: number; maxUsd: number;
}) {
  if (!Number.isSafeInteger(options.maxCalls) || options.maxCalls < 1 || options.maxCalls > 60
    || !Number.isFinite(options.maxUsd) || options.maxUsd <= 0 || options.maxUsd > 0.25) throw new Error('Invalid evaluation budget');
  const { maxCalls, maxUsd, fetch: network } = options;
  const rates = structuredClone(options.rates);
  const transports: ReturnType<typeof createBudgetedTransport>[] = [];
  let blockedReason: string | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const report = () => {
    const reports = transports.map(t => t.report());
    return {
      calls: reports.reduce((sum, r) => sum + r.calls, 0),
      chargedUsd: reports.reduce((sum, r) => sum + r.chargedUsd, 0),
      reservedUsd: reports.reduce((sum, r) => sum + r.reservedUsd, 0),
      blockedReason,
      attempts: reports.flatMap(r => r.attempts),
      accountingComplete: reports.every(r => r.reservedUsd === 0 && !r.blockedReason),
    };
  };
  const fetch: typeof globalThis.fetch = (input, init) => {
    const result = queue.then(async () => {
      const used = report();
      if (used.calls >= maxCalls || used.chargedUsd + used.reservedUsd >= maxUsd) {
        blockedReason = used.calls >= maxCalls ? 'call limit' : 'USD limit';
        throw new Error('Evaluation budget exhausted');
      }
      const transport = createBudgetedTransport({ fetch: network, rates, maxCalls: maxCalls - used.calls,
        maxUsd: maxUsd - used.chargedUsd - used.reservedUsd });
      transports.push(transport);
      return transport.fetch(input, init);
    });
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  return { fetch, report };
}

import type { TurnContext } from '@templelabs/contracts';
import type { ActiveRunRpcClient } from './active-run-store.js';
import { createOwnedBaseline } from './owned-baseline.js';
import { createAtomicTaskEffectSource } from './atomic-task-executor.js';
import { createDeliveryManifest } from './delivery-manifest.js';
import { createActiveRunRecoveryReader } from './active-run-recovery.js';
import { createActiveRunResolutionStore, reconcileActiveRun } from './active-run-resolution.js';

/** Isolated backend composition. No model call, registry-supplied proof, legacy fallback or replay. */
export function createActiveRunRecoveryRuntime(client: ActiveRunRpcClient, owner: { readonly id: string; readonly token: string }) {
  const privateOwner = { ...owner };
  const baseline = createOwnedBaseline(client, privateOwner);
  const reader = createActiveRunRecoveryReader(client, privateOwner);
  const store = createActiveRunResolutionStore(client, privateOwner);
  const evidence = {
    effect: createAtomicTaskEffectSource(client, privateOwner),
    delivery: createDeliveryManifest(client, privateOwner).delivery,
    baseline: baseline.baseline,
  };
  return {
    captureBaseline: baseline.capture,
    async recover(context: TurnContext, threadId: string) {
      const loaded = await reader.load(context, threadId);
      if (!loaded) return null;
      return reconcileActiveRun(loaded.snapshot, context, evidence, store);
    },
  };
}

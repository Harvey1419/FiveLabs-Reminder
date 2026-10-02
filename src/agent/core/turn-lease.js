import { AsyncLocalStorage } from 'node:async_hooks';

const turnContext = new AsyncLocalStorage();

export function withTurnLease(context, work) {
  return turnContext.run(context, work);
}

export function withoutTurnLease(work) {
  return turnContext.exit(work);
}

/** No ambient turn exists in CLI/background jobs; webhook turns must retain ownership. */
export async function assertTurnLease() {
  await turnContext.getStore()?.assertActive();
}

export async function checkpointTurnResponse(response) {
  await turnContext.getStore()?.checkpoint(response);
}

export function currentTurnSignal() {
  return turnContext.getStore()?.signal;
}

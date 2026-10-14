import { ProductivityTurnRunner } from '@templelabs/agent-core';
import { DurableProductivityAssistant, type ProductivityDeliveryPort } from './durable-productivity-assistant.js';
import { WhatsAppProductivityPresenter } from '../../presentation/whatsapp-productivity-presenter.js';
import { createOwnedProductivityStateRecovery } from './owned-productivity-state-recovery.js';
import type { ActiveRunRpcClient } from './active-run-store.js';

/** New-runtime startup wiring. Recovery runs before the runner, checkpoint, tools or sender. */
export function createOwnedProductivityAssistant(runner: ProductivityTurnRunner, delivery: ProductivityDeliveryPort,
  client: ActiveRunRpcClient, owner: { readonly id: string; readonly token: string },
  presenter = new WhatsAppProductivityPresenter()): DurableProductivityAssistant {
  return new DurableProductivityAssistant(runner,delivery,presenter,createOwnedProductivityStateRecovery(client,owner));
}

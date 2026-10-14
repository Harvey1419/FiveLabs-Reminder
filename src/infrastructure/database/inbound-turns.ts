// Compatibility wiring. Queue persistence is compiled from strict TypeScript.
import { supabase } from './index.js';
import { createInboundTurnPersistence } from './inbound-turn-persistence.js';
export const { enqueueInboundTurn, inboundTurnStorage, assertInboundQueueReady } = createInboundTurnPersistence(() => supabase as unknown as ReturnType<Parameters<typeof createInboundTurnPersistence>[0]>);



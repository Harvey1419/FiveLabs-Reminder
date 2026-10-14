// Legacy entry wiring; history persistence is emitted from strict TypeScript.
import { supabase } from './index.js';
import { createMessagePersistence } from './message-persistence.js';
export const { saveMessage, isMessageAlreadyProcessed, getRecentMessages, getLatestInboundPhoneNumberId, getAssistantMessageById } = createMessagePersistence(() => supabase as unknown as ReturnType<Parameters<typeof createMessagePersistence>[0]>);



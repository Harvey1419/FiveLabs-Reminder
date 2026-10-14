// Legacy integration wiring; OAuth persistence is emitted from strict TypeScript.
import { supabase } from './index.js';
import { createIntegrationPersistence } from './integration-persistence.js';
export const { getUserIntegration, saveUserIntegration, deleteUserIntegration, updateUserIntegrationMetadata, getAllActiveIntegrations, getUserIntegrationByChannelId } = createIntegrationPersistence(() => supabase as unknown as ReturnType<Parameters<typeof createIntegrationPersistence>[0]>);



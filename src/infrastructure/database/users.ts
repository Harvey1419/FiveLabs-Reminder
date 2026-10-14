// Legacy profile wiring; cache and persistence are emitted from strict TypeScript.
import { supabase } from './index.js';
import { detectTimezoneFromPhone,detectLocaleFromPhone } from '../../shared/time.js';
import { createUserProfilePersistence } from './user-profile-persistence.js';
export const { userCache, normalizeUserPhone, getOrCreateUserByPhone, updateUserPreferences, updateUserTimezone, updateUserLocale, touchUserLastActive } = createUserProfilePersistence(() => supabase as unknown as ReturnType<Parameters<typeof createUserProfilePersistence>[0]>,{ detectTimezoneFromPhone,detectLocaleFromPhone });



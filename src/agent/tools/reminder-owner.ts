import { normalizePhoneNumber } from '../../integrations/whatsapp/kapso-client.js';
import { createReminderOwnerTools } from './reminder-owner-tools.js';
const service = createReminderOwnerTools({
  normalizePhoneNumber: ((...args: Parameters<typeof normalizePhoneNumber>) => normalizePhoneNumber(...args)) as unknown as Parameters<typeof createReminderOwnerTools>[0]['normalizePhoneNumber'],
  logger: console,
});
export function buildReminderOwnerContext(...args: Parameters<typeof service.buildReminderOwnerContext>) { return service.buildReminderOwnerContext(...args); }
export function isReminderOwned(...args: Parameters<typeof service.isReminderOwned>) { return service.isReminderOwned(...args); }
export function scopeReminderQueryToOwner(...args: Parameters<typeof service.scopeReminderQueryToOwner>) { return service.scopeReminderQueryToOwner(...args); }



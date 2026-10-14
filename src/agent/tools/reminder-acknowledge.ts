import { supabase, acknowledgeReminder } from '../../infrastructure/database/index.js';
import { stripReminderPrefix } from '../../integrations/whatsapp/kapso-client.js';
import { isIntradayRecurrence } from '../../shared/reminder-recurrence.js';
import { resolveContextReference } from '../core/context-reference.js';
import { formatReminderAcknowledgedCard } from './formatters.js';
import {
  buildReminderOwnerContext,
  isReminderOwned,
  scopeReminderQueryToOwner,
} from './reminder-owner.js';
import {
  findReminderByExactReference,
  buildReminderReferenceCandidates,
  resolveReminderByScore,
} from './reminder-reference.js';
import { createReminderAcknowledgementTool } from './reminder-acknowledgement-tool.js';
const service = createReminderAcknowledgementTool({
  supabase: { from: ((...args: Parameters<typeof supabase.from>) => supabase.from(...args)) as unknown as Parameters<typeof createReminderAcknowledgementTool>[0]['supabase']['from']},
  acknowledgeReminder: ((...args: Parameters<typeof acknowledgeReminder>) => acknowledgeReminder(...args)) as unknown as Parameters<typeof createReminderAcknowledgementTool>[0]['acknowledgeReminder'],
  stripReminderPrefix: ((...args: Parameters<typeof stripReminderPrefix>) => stripReminderPrefix(...args)) as unknown as Parameters<typeof createReminderAcknowledgementTool>[0]['stripReminderPrefix'],
  isIntradayRecurrence: ((...args: Parameters<typeof isIntradayRecurrence>) => isIntradayRecurrence(...args)) as unknown as Parameters<typeof createReminderAcknowledgementTool>[0]['isIntradayRecurrence'],
  resolveContextReference: ((...args: Parameters<typeof resolveContextReference>) => resolveContextReference(...args)) as unknown as Parameters<typeof createReminderAcknowledgementTool>[0]['resolveContextReference'],
  formatReminderAcknowledgedCard: ((...args: Parameters<typeof formatReminderAcknowledgedCard>) => formatReminderAcknowledgedCard(...args)) as unknown as Parameters<typeof createReminderAcknowledgementTool>[0]['formatReminderAcknowledgedCard'],
  buildReminderOwnerContext: ((...args: Parameters<typeof buildReminderOwnerContext>) => buildReminderOwnerContext(...args)) as unknown as Parameters<typeof createReminderAcknowledgementTool>[0]['buildReminderOwnerContext'],
  isReminderOwned: ((...args: Parameters<typeof isReminderOwned>) => isReminderOwned(...args)) as unknown as Parameters<typeof createReminderAcknowledgementTool>[0]['isReminderOwned'],
  scopeReminderQueryToOwner: ((...args: Parameters<typeof scopeReminderQueryToOwner>) => scopeReminderQueryToOwner(...args)) as unknown as Parameters<typeof createReminderAcknowledgementTool>[0]['scopeReminderQueryToOwner'],
  findReminderByExactReference: ((...args: Parameters<typeof findReminderByExactReference>) => findReminderByExactReference(...args)) as unknown as Parameters<typeof createReminderAcknowledgementTool>[0]['findReminderByExactReference'],
  buildReminderReferenceCandidates: ((...args: Parameters<typeof buildReminderReferenceCandidates>) => buildReminderReferenceCandidates(...args)) as unknown as Parameters<typeof createReminderAcknowledgementTool>[0]['buildReminderReferenceCandidates'],
  resolveReminderByScore: ((...args: Parameters<typeof resolveReminderByScore>) => resolveReminderByScore(...args)) as unknown as Parameters<typeof createReminderAcknowledgementTool>[0]['resolveReminderByScore'],
  logger: console,
});
export function executeReminderAcknowledgement(...args: Parameters<typeof service.executeReminderAcknowledgement>) { return service.executeReminderAcknowledgement(...args); }



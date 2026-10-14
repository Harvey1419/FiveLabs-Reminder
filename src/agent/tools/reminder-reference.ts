import {
  isStrictUUID,
  calculateMatchScore,
} from '../../shared/entity-resolution.js';
import { createReminderReferenceTools } from './reminder-reference-tools.js';
const service = createReminderReferenceTools({
  isStrictUUID: ((...args: Parameters<typeof isStrictUUID>) => isStrictUUID(...args)) as unknown as Parameters<typeof createReminderReferenceTools>[0]['isStrictUUID'],
  calculateMatchScore: ((...args: Parameters<typeof calculateMatchScore>) => calculateMatchScore(...args)) as unknown as Parameters<typeof createReminderReferenceTools>[0]['calculateMatchScore'],
  logger: console,
});
export function findReminderByExactReference(...args: Parameters<typeof service.findReminderByExactReference>) { return service.findReminderByExactReference(...args); }
export function buildReminderReferenceCandidates(...args: Parameters<typeof service.buildReminderReferenceCandidates>) { return service.buildReminderReferenceCandidates(...args); }
export function resolveReminderByScore(...args: Parameters<typeof service.resolveReminderByScore>) { return service.resolveReminderByScore(...args); }



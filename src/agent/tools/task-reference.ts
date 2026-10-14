import { supabase } from '../../infrastructure/database/index.js';
import { getWorkingMemory } from '../core/working-memory.js';
import { parseStructuredOrdinal, resolveContextReference } from '../core/context-reference.js';
import {
  isStrictUUID,
  normalizeTextForMatching,
  calculateMatchScore,
} from '../../shared/entity-resolution.js';
import { selectEntityCandidate } from '../../infrastructure/database/entities.js';
import { createTaskTargetResolution } from './task-target-resolution.js';
const tool = createTaskTargetResolution({
  supabase: { from: ((...args: Parameters<typeof supabase.from>) => supabase.from(...args)) as unknown as Parameters<typeof createTaskTargetResolution>[0]['supabase']['from']},
  getWorkingMemory: ((...args: Parameters<typeof getWorkingMemory>) => getWorkingMemory(...args)) as unknown as Parameters<typeof createTaskTargetResolution>[0]['getWorkingMemory'],
  parseStructuredOrdinal: ((...args: Parameters<typeof parseStructuredOrdinal>) => parseStructuredOrdinal(...args)) as unknown as Parameters<typeof createTaskTargetResolution>[0]['parseStructuredOrdinal'],
  resolveContextReference: ((...args: Parameters<typeof resolveContextReference>) => resolveContextReference(...args)) as unknown as Parameters<typeof createTaskTargetResolution>[0]['resolveContextReference'],
  isStrictUUID: ((...args: Parameters<typeof isStrictUUID>) => isStrictUUID(...args)) as unknown as Parameters<typeof createTaskTargetResolution>[0]['isStrictUUID'],
  normalizeTextForMatching: ((...args: Parameters<typeof normalizeTextForMatching>) => normalizeTextForMatching(...args)) as unknown as Parameters<typeof createTaskTargetResolution>[0]['normalizeTextForMatching'],
  calculateMatchScore: ((...args: Parameters<typeof calculateMatchScore>) => calculateMatchScore(...args)) as unknown as Parameters<typeof createTaskTargetResolution>[0]['calculateMatchScore'],
  selectEntityCandidate: ((...args: Parameters<typeof selectEntityCandidate>) => selectEntityCandidate(...args)) as unknown as Parameters<typeof createTaskTargetResolution>[0]['selectEntityCandidate'],
  logger: console, getNowMs: () => Date.now(),
});
export function resolveTaskTarget(...args: Parameters<typeof tool.resolveTaskTarget>) { return tool.resolveTaskTarget(...args); }



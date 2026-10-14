import type { LegacyToolUser } from '../../agent/tools/remaining-tool-ports.js';
import { legacyDomainInvoker, type LegacyExecutor } from './legacy-domain.js';
import { compatibilityParameters } from '../../features/productivity-domain.js';
import { taskParameters } from '../../features/tasks/productivity-service.js';
import { createTaskDomainPort } from './tasks-domain.js';

/** Compatibility injection only; production V2 uses the typed domain port. */
export function createLegacyTaskPort(user: LegacyToolUser, execute?: LegacyExecutor) {
  const invoke = legacyDomainInvoker(user, execute);
  return createTaskDomainPort(user, { execute: (request, context) =>
    invoke('manage_task', compatibilityParameters(taskParameters(request)), context) });
}

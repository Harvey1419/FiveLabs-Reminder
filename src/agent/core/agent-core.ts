import { createAgentPrompt, AGENT_CONFIG } from './agent-prompt.js';
import { hasUsableGoogleCredentials } from '../../integrations/google/auth.js';
import { entityMatchScore, normalizeEntityName } from '../../infrastructure/database/entities.js';
export { AGENT_CONFIG };
export const { formatCompactOverview, formatReferencedProjectTasks, formatActiveFollowups, buildAgentCorePrompt } = createAgentPrompt({ hasUsableGoogleCredentials: hasUsableGoogleCredentials as unknown as Parameters<typeof createAgentPrompt>[0]['hasUsableGoogleCredentials'], entityMatchScore: entityMatchScore as unknown as Parameters<typeof createAgentPrompt>[0]['entityMatchScore'], normalizeEntityName: normalizeEntityName as unknown as Parameters<typeof createAgentPrompt>[0]['normalizeEntityName'] });



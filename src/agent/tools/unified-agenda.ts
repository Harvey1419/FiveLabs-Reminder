import { getUnifiedAgenda } from '../../features/agenda/service.js';
import { getGoogleConnectUrl } from '../../integrations/google/auth.js';
import { createUnifiedAgendaTool } from './unified-agenda-tool.js';
const service = createUnifiedAgendaTool({
  getUnifiedAgenda: ((...args: Parameters<typeof getUnifiedAgenda>) => getUnifiedAgenda(...args)) as unknown as Parameters<typeof createUnifiedAgendaTool>[0]['getUnifiedAgenda'],
  getGoogleConnectUrl: ((...args: Parameters<typeof getGoogleConnectUrl>) => getGoogleConnectUrl(...args)) as unknown as Parameters<typeof createUnifiedAgendaTool>[0]['getGoogleConnectUrl'],
  logger: console});
export function executeUnifiedAgendaTool(...args: Parameters<typeof service.executeUnifiedAgendaTool>) { return service.executeUnifiedAgendaTool(...args); }



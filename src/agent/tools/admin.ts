import { supabase } from '../../infrastructure/database/index.js';
import { isAdminUser } from '../../shared/auth.js';
import { createAdminTool } from './admin-tool.js';
const service = createAdminTool({
  supabase: { from: ((...args: Parameters<typeof supabase.from>) => supabase.from(...args)) as unknown as Parameters<typeof createAdminTool>[0]['supabase']['from']},
  isAdminUser: ((...args: Parameters<typeof isAdminUser>) => isAdminUser(...args)) as unknown as Parameters<typeof createAdminTool>[0]['isAdminUser'],
  logger: console,
});
export function executeAdminTool(...args: Parameters<typeof service.executeAdminTool>) { return service.executeAdminTool(...args); }



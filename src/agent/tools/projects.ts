import {
  findOrCreateProjectFuzzy,
  renameProject,
  findProjects,
  deleteProjects,
  selectProjectCandidate,
} from '../../infrastructure/database/projects.js';
import { createProjectTool } from './project-tool.js';
const service = createProjectTool({
  findOrCreateProjectFuzzy: ((...args: Parameters<typeof findOrCreateProjectFuzzy>) => findOrCreateProjectFuzzy(...args)) as unknown as Parameters<typeof createProjectTool>[0]['findOrCreateProjectFuzzy'],
  renameProject: ((...args: Parameters<typeof renameProject>) => renameProject(...args)) as unknown as Parameters<typeof createProjectTool>[0]['renameProject'],
  findProjects: ((...args: Parameters<typeof findProjects>) => findProjects(...args)) as unknown as Parameters<typeof createProjectTool>[0]['findProjects'],
  deleteProjects: ((...args: Parameters<typeof deleteProjects>) => deleteProjects(...args)) as unknown as Parameters<typeof createProjectTool>[0]['deleteProjects'],
  selectProjectCandidate: ((...args: Parameters<typeof selectProjectCandidate>) => selectProjectCandidate(...args)) as unknown as Parameters<typeof createProjectTool>[0]['selectProjectCandidate'],
  logger: console,
});
export function executeProjectTool(...args: Parameters<typeof service.executeProjectTool>) { return service.executeProjectTool(...args); }



import { supabase } from './index.js';
import { createProjectPersistence } from './project-persistence.js';
const persistence = createProjectPersistence(() => supabase as unknown as ReturnType<Parameters<typeof createProjectPersistence>[0]>);
export const { normalizeProjectName, projectMatchScore, selectProjectCandidate, selectProjectsForDeletion, findOrCreateProjectFuzzy, findProjects, getProjectsByUser, getProjectById, renameProject } = persistence;
export const deleteProjects: ReturnType<typeof createProjectPersistence>['deleteProjects'] = persistence.deleteProjects;

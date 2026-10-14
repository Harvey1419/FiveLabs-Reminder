// Legacy entry wiring; domain persistence is emitted from strict TypeScript.
import { supabase } from './index.js';
import { assertTurnLease } from '../../agent/core/turn-lease.js';
import { selectEntityCandidate } from './entities.js';
import { isStrictUUID,normalizeTextForMatching } from '../../shared/entity-resolution.js';
import { createTaskPersistence } from './task-persistence.js';
export const { normalizeTaskPriority, createTask, createTasksBatch, getTasks, completeTasks, completeTask, updateTask, deleteTask, completeTasksByQuery, getTasksWithEntities } = createTaskPersistence(() => supabase as unknown as ReturnType<Parameters<typeof createTaskPersistence>[0]>,{ assertTurnLease,isStrictUUID,normalizeTextForMatching,selectEntityCandidate });



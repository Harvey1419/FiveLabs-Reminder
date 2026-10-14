import { beforeEach,describe,expect,it,vi } from 'vitest';
const { rename,merge,deduplicate } = vi.hoisted(() => ({ rename: vi.fn(),merge: vi.fn(),deduplicate: vi.fn() }));
vi.mock('../../../src/infrastructure/database/index.js',() => ({ renameEntityCascade: rename,mergeEntities: merge,deduplicateEntities: deduplicate,
  findOrCreateEntityFuzzy: vi.fn(),getEntitiesByUser: vi.fn(),deleteEntities: vi.fn(),inspectOwnedEntityReferences: vi.fn() }));
import { executeEntityTool } from '../../../src/agent/tools/entities.js';
beforeEach(() => vi.clearAllMocks());
describe('entity tool uncertainty survives the legacy result boundary',() => {
  it.each(['rename','merge','deduplicate'])('keeps %s unknown instead of claiming absence or success',async action => {
    const result = { success: false,complete: false,outcome: 'unknown',errorCode: 'ENTITY_MUTATION_RECONCILIATION_REQUIRED',tasksMovedCount: 1 };
    rename.mockResolvedValue(result);merge.mockResolvedValue(result);deduplicate.mockResolvedValue(result);
    const output = await executeEntityTool({ action,params: { oldName: 'Old',newName: 'New',sourceName: 'Old',targetName: 'New' },user: { id: 'owner' },language: 'es' });
    expect(output).toMatchObject({ success: false,complete: false,outcome: 'unknown',errorCode: 'ENTITY_MUTATION_RECONCILIATION_REQUIRED',partialSuccess: true,data: result });
    expect(output).toMatchObject({ error: expect.stringContaining('verificar') });
  });
});

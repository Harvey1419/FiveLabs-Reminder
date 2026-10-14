// Legacy host wiring; memory orchestration executes from emitted TypeScript.
import { searchMemories,getActiveMemories,forgetMemories } from '../../infrastructure/database/index.js';
import { extractAndSaveMemories } from '../../features/memory/service.js';
import { formatMemoryListCard } from './formatters.js';
import { selectMemoriesToForget } from '../orchestration/select-memory-forgetting.js';
import { createMemoryTool } from './memory-tool.js';
export const { executeMemoryTool } = createMemoryTool({
  searchMemories: ((...args: Parameters<typeof searchMemories>) => searchMemories(...args)) as unknown as Parameters<typeof createMemoryTool>[0]['searchMemories'],
  getActiveMemories: ((...args: Parameters<typeof getActiveMemories>) => getActiveMemories(...args)) as unknown as Parameters<typeof createMemoryTool>[0]['getActiveMemories'],
  forgetMemories: ((...args: Parameters<typeof forgetMemories>) => forgetMemories(...args)) as unknown as Parameters<typeof createMemoryTool>[0]['forgetMemories'],
  extractAndSaveMemories: ((...args: Parameters<typeof extractAndSaveMemories>) => extractAndSaveMemories(...args)) as unknown as Parameters<typeof createMemoryTool>[0]['extractAndSaveMemories'],
  formatMemoryListCard: ((...args: Parameters<typeof formatMemoryListCard>) => formatMemoryListCard(...args)) as unknown as Parameters<typeof createMemoryTool>[0]['formatMemoryListCard'],
  selectMemoriesToForget: ((...args: Parameters<typeof selectMemoriesToForget>) => selectMemoriesToForget(...args)) as unknown as Parameters<typeof createMemoryTool>[0]['selectMemoriesToForget'],
});



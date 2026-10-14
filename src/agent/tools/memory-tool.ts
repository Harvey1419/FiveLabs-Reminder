import type { MemoryRow, MemoryReadOptions, MemorySearchOptions, MemoryReadResult, ForgetMemoryOptions, ForgetMemoryResult } from '../../infrastructure/database/memory-persistence-client.js';
import type { ForgettingSelectionOptions } from '../orchestration/memory-forgetting-selection.js';
export interface MemoryTurn {
  userText?: string;
  processed?: boolean;
  result?: Promise<MemoryRow[]>;
  executionFacts?: unknown[];
  learningCandidates?: unknown[];
  learningCandidatesProvided?: boolean;
  memorySaveActions?: unknown[];
}
export interface MemoryToolInput {
  action?: string;
  params?: { query?: string; topicKey?: string; limit?: number };
  user?: { id?: string } | null;
  language?: string;
  correlationId?: string | null;
  memoryTurn?: MemoryTurn | null;
}
export interface MemoryToolDependencies {
  searchMemories(options: MemorySearchOptions & { withStatus: true }): Promise<MemoryReadResult>;
  getActiveMemories(options: MemoryReadOptions & { withStatus: true }): Promise<MemoryReadResult>;
  forgetMemories(options: ForgetMemoryOptions): Promise<ForgetMemoryResult>;
  extractAndSaveMemories(options: { userId: string; userText: string; executionFacts: unknown[]; throwOnError: true;
    learningCandidates?: unknown[] | undefined; learningCandidatesProvided: boolean; memorySaveActions: unknown[] }): Promise<MemoryRow[]>;
  formatMemoryListCard(memories: MemoryRow[],language: string): string;
  selectMemoriesToForget(options: ForgettingSelectionOptions): Promise<string[] | null>;
}
/** Typed orchestration; semantic admission and storage authority remain injected host services. */
export function createMemoryTool(dependencies: MemoryToolDependencies) {
  const { searchMemories,getActiveMemories,forgetMemories,extractAndSaveMemories,formatMemoryListCard,selectMemoriesToForget } = dependencies;
  /**
   * Domain tool for managing persistent semantic memories.
   */
  async function executeMemoryTool({ action, params = {}, user, language = 'es', correlationId = null, memoryTurn = null }: MemoryToolInput) {
    const userId = user?.id;
    const normalizedAction = String(action || 'save');

    switch (normalizedAction) {
      case 'save': {
        // Tool parameters are model output, never the factual source.
        if (!userId || !memoryTurn?.userText) {
          return {
            success: false,
            action: 'invalid_parameters',
            errorCode: 'INVALID_PARAMETERS',
            error: language === 'en' ? 'The original user message is required to validate a memory.' : 'Necesito el mensaje original del usuario para validar el recuerdo.',
            rawSummary: language === 'en' ? 'The original user message is required to validate a memory.' : 'Necesito el mensaje original del usuario para validar el recuerdo.',
          };
        }

        let memories;
        try {
          if (!memoryTurn.result) {
            memoryTurn.processed = true;
            memoryTurn.result = extractAndSaveMemories({
              userId, userText: memoryTurn.userText,
              executionFacts: memoryTurn.executionFacts || [], throwOnError: true,
              learningCandidates: memoryTurn.learningCandidates,
              learningCandidatesProvided: memoryTurn.learningCandidatesProvided === true,
              memorySaveActions: memoryTurn.memorySaveActions || [],
            });
          }
          memories = await memoryTurn.result;
        } catch {
          const message = language === 'en' ? 'I could not confirm the memory save. I will not retry automatically.' : 'No pude confirmar el guardado de la memoria. No lo repetiré automáticamente.';
          return { success: false, action: 'memory_save_failed', errorCode: 'MEMORY_SAVE_FAILED', error: message, rawSummary: message };
        }
        if (!memories.length) {
          const message = language === 'en' ? 'No supported durable memories were saved.' : 'No guardé recuerdos duraderos respaldados por tu mensaje.';
          return { success: false, action: 'memory_not_admitted', errorCode: 'MEMORY_NOT_ADMITTED', error: message, rawSummary: message, data: { memories: [] } };
        }
        const content = memories.map(memory => `• ${memory.content}`).join('\n');
        const formattedCard = language === 'en'
          ? `🧠 *Saved to Memory:*\n${content}`
          : `🧠 *Guardado en mi memoria:*\n${content}`;

        return {
          success: true,
          action: 'saved_memory',
          data: {
            memory: memories[0],
            memories,
            formattedCard,
          },
          rawSummary: formattedCard,
          formattedCard,
        };
      }

      case 'search':
      case 'list': {
        const unavailable = () => {
          const message = language === 'en' ? 'I could not read your memories right now.' : 'No pude consultar tus recuerdos en este momento.';
          return { success: false, action: 'memory_read_failed', errorCode: 'MEMORY_UNAVAILABLE', error: message, rawSummary: message };
        };
        if (!userId) return unavailable();
        let result;
        try {
          const options = { userId, limit: params.limit || (normalizedAction === 'search' ? 5 : 15), withStatus: true as const, throwOnError: true };
          result = normalizedAction === 'search'
            ? await searchMemories({ ...options, query: params.query || '' })
            : await getActiveMemories(options);
        } catch {
          return unavailable();
        }
        if (!['available', 'partial'].includes(result?.status) || !Array.isArray(result.memories)
          || result.memories.some(row => !row || typeof row.id !== 'string' || !row.id || typeof row.content !== 'string' || !row.content.trim())
          || (result.status === 'partial' && !result.memories.length)) return unavailable();
        const memories = result.memories;
        const notice = result.status === 'partial'
          ? (language === 'en' ? '\n\nPartial results: some memories could not be retrieved.' : '\n\nResultados parciales: no pude recuperar algunos recuerdos.') : '';
        const formattedCard = formatMemoryListCard(memories, language) + notice;

        return {
          success: true,
          action: normalizedAction === 'search' ? 'searched_memories' : 'listed_memories',
          data: {
            memories,
            formattedCard,
          },
          rawSummary: formattedCard,
          formattedCard,
        };
      }

      case 'forget': {
        const topicKey = params.topicKey || null;
        const query = params.query || null;
        const effectiveTerm = query || topicKey || '';

        const res = await forgetMemories({
          userId: userId ?? '',
          topicKey,
          query,
          correlationId,
          selectCandidates: candidates => selectMemoriesToForget({ query: effectiveTerm, candidates: candidates.map(row => ({ id: row.id,content: row.content,...(row.topic_key != null ? { topic_key: row.topic_key } : {}) })), language, ...(correlationId != null ? { correlationId } : {}) }),
        });

        const count = res?.deletedCount || 0;
        if (res?.success === false || !count) {
          const failed = res?.success === false;
          const message = failed
            ? (language === 'en' ? 'I could not confirm the memory deletion.' : 'No pude confirmar la eliminación de la memoria.')
            : (language === 'en' ? 'I did not delete any memories matching that request.' : 'No eliminé ninguna memoria que coincidiera con esa solicitud.');
          return { success: false, action: failed ? 'memory_forget_failed' : 'memory_not_found',
            errorCode: res?.errorCode || 'NOT_FOUND', ...(res?.outcome ? { outcome: res.outcome } : {}),
            error: message, rawSummary: message, data: { deletedCount: 0, deletedMemories: [] } };
        }
        const deletedMemories = res.deletedMemories || [];
        const details = deletedMemories.map(memory => `• ${memory.content}`).join('\n');
        const formattedCard = language === 'en'
          ? `🗑️ *${count} ${count === 1 ? 'memory deleted' : 'memories deleted'}*${details ? `\n\n${details}` : ''}`
          : `🗑️ *${count} ${count === 1 ? 'memoria eliminada' : 'memorias eliminadas'}*${details ? `\n\n${details}` : ''}`;

        return {
          success: true,
          action: 'forgotten_memory',
          data: {
            forgottenCount: count,
            deletedCount: count,
            deletedMemories,
            topicKey: effectiveTerm,
            formattedCard,
          },
          rawSummary: formattedCard,
          formattedCard,
        };
      }

      default:
        return {
          success: false,
          action: 'unsupported_action',
          errorCode: 'UNSUPPORTED_ACTION',
          error: `Acción '${action}' no soportada para manage_memory.`,
          rawSummary: `Acción '${action}' no soportada para manage_memory.`,
        };
    }
  }

  return { executeMemoryTool };
}

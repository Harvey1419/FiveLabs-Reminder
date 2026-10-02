import {
  saveMemory,
  searchMemories,
  getActiveMemories,
  forgetMemories,
} from '../../infrastructure/database/index.js';
import { formatMemoryListCard } from './formatters.js';
import { selectMemoriesToForget } from '../orchestration/select-memory-forgetting.js';

/**
 * Domain tool for managing persistent semantic memories.
 */
export async function executeMemoryTool({ action, params = {}, user, language = 'es', correlationId = null }) {
  const userId = user?.id;
  const normalizedAction = String(action || 'save');

  switch (normalizedAction) {
    case 'save': {
      const content = params.content || '';
      const category = params.category || 'fact';
      const topicKey = params.topicKey || null;

      if (!content) {
        return {
          success: false,
          action: 'invalid_parameters',
          errorCode: 'INVALID_PARAMETERS',
          error: 'Falta el contenido del recuerdo.',
          rawSummary: 'Falta el contenido del recuerdo.',
        };
      }

      const mem = await saveMemory({
        userId,
        content,
        category,
        topicKey,
      });

      if (!mem) {
        return {
          success: false,
          action: 'database_error',
          errorCode: 'DATABASE_ERROR',
          error: 'No se pudo guardar la memoria.',
          rawSummary: 'No se pudo guardar la memoria.',
        };
      }

      const formattedCard = language === 'en'
        ? `🧠 *Saved to Memory:*\n"${content}"`
        : `🧠 *Guardado en mi memoria:*\n"${content}"`;

      return {
        success: true,
        action: 'saved_memory',
        data: {
          memory: mem,
          formattedCard,
        },
        rawSummary: formattedCard,
        formattedCard,
      };
    }

    case 'search': {
      const query = params.query || '';
      const limit = params.limit || 5;

      const results = await searchMemories({
        userId,
        query,
        limit,
      });

      const formattedCard = formatMemoryListCard(results, language);

      return {
        success: true,
        action: 'searched_memories',
        data: {
          memories: results,
          formattedCard,
        },
        rawSummary: formattedCard,
        formattedCard,
      };
    }

    case 'list': {
      const limit = params.limit || 15;
      const memories = await getActiveMemories({ userId, limit });
      const formattedCard = formatMemoryListCard(memories, language);

      return {
        success: true,
        action: 'listed_memories',
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
        userId,
        topicKey,
        query,
        correlationId,
        selectCandidates: candidates => selectMemoriesToForget({ query: effectiveTerm, candidates, language, correlationId }),
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

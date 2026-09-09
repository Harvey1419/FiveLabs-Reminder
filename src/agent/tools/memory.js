import {
  saveMemory,
  searchMemories,
  getActiveMemories,
  forgetMemories,
} from '../../infrastructure/database/index.js';
import { formatMemoryListCard } from './formatters.js';

/**
 * Domain tool for managing persistent semantic memories.
 */
export async function executeMemoryTool({ action, params = {}, user, language = 'es' }) {
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
      const effectiveTerm = topicKey || query || '';

      const res = await forgetMemories({
        userId,
        topicKey: topicKey || effectiveTerm,
        query: query || effectiveTerm,
      });

      const count = res?.deletedCount || 0;
      const formattedCard = language === 'en'
        ? `🗑️ *Memory Forgotten:* Removed stored context for "${effectiveTerm}".`
        : `🗑️ *Memoria borrada:* Eliminé el contexto guardado sobre "${effectiveTerm}".`;

      return {
        success: true,
        action: 'forgotten_memory',
        data: {
          forgottenCount: count,
          deletedCount: count,
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

import { callChatCompletion } from '../providers/client.js';
import { formatLocalDateTime } from '../../shared/time.js';
import { createNextBestAction } from './next-best-action-core.js';

export const { resolveNextBestAction } = createNextBestAction({
  complete: (...args) => callChatCompletion(...args), formatLocalDateTime,
});



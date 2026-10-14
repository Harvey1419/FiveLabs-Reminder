// Legacy provider wiring; bounded target resolution is emitted from TypeScript.
import { callChatCompletion } from '../providers/client.js';
import { createObservedTargetResolver } from './observed-target-resolution.js';
export const resolveObservedTarget = createObservedTargetResolver(() => callChatCompletion as import('./observed-target-resolution.js').ObservedTargetCompletion);



// Legacy provider wiring; candidate selection is emitted from TypeScript.
import { callChatCompletion } from '../providers/client.js';
import { createMemoryForgettingSelector } from './memory-forgetting-selection.js';
export const selectMemoriesToForget = createMemoryForgettingSelector(() => callChatCompletion as import('./observed-target-resolution.js').ObservedTargetCompletion);



// The selector requests returnMessage=true and validates the returned content itself.

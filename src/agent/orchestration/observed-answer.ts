export { freezeTaskReferenceSnapshot, answerFromTaskReturnFields } from './observed-task-fields.js';
import { randomUUID } from 'node:crypto';
import { callChatCompletion } from '../providers/client.js';
import { formatCanonicalTaskCreate, formatCanonicalTaskUpdate, formatCanonicalTaskComplete } from '../../shared/task-presentation.js';
import { formatCanonicalTaskList } from '../../shared/agenda-presentation.js';
import { formatCanonicalReminderList } from '../../shared/reminder-presentation.js';
import { formatCanonicalReminderCreate } from '../../shared/reminder-presentation.js';

import { createHistoricalEvidence } from './historical-evidence.js';
export const { mutationReceiptsFromFacts, carryCreationReceiptEvents, historicalMutationReceipts, receiptBlock,
  historicalRecap, operationalEvidenceFromHistory, carryOperationalEvidence, renderOperationalEvidence, renderHistoricalEvidence } = createHistoricalEvidence({
  randomUUID, formatCanonicalTaskCreate, formatCanonicalTaskUpdate, formatCanonicalTaskComplete,
  formatCanonicalTaskList, formatCanonicalReminderCreate, formatCanonicalReminderList,
});

import { createObservedAnswer } from './observed-answer-core.js';
export const { answerFromObservedReads } = createObservedAnswer({
  complete: (...args) => callChatCompletion(...args), historicalMutationReceipts, historicalRecap, receiptBlock,
});



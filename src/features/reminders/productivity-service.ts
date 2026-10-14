import type { ReminderRequest, TurnContext } from '@templelabs/contracts';
import { definedFields, domainInput, domainResult, type ProductivityService, type ProductivityUser } from '../productivity-domain.js';
import { parseTargetTime } from '../../shared/time.js';
import { executeReminderCreate } from './operations/reminder-create.js';
import { executeReminderReadTool } from './operations/reminder-read.js';
import { executeReminderUpdate } from './operations/reminder-update.js';
import { executeSingleReminderCancellation } from './operations/reminder-cancel.js';
import { executeReminderAcknowledgement } from './operations/reminder-acknowledge.js';

const handlers = { create: executeReminderCreate, read: executeReminderReadTool, update: executeReminderUpdate,
  cancel: executeSingleReminderCancellation, acknowledge: executeReminderAcknowledgement };
export type ReminderServiceHandlers = { [K in keyof typeof handlers]: (...args: Parameters<typeof handlers[K]>) => Promise<unknown> };
function canonicalTime(value: string, context: TurnContext) {
  const date = parseTargetTime(value, context.timezone, new Date(context.referenceTimeIso));
  if (!date || !Number.isFinite(date.getTime())) throw new Error('Invalid temporal result');
  return date.toISOString();
}
export function reminderParameters(request: ReminderRequest, context: TurnContext) {
  switch (request.operation) {
    case 'create': {
      const { targetTimeIso, ...policy } = request.input;
      return { action: 'create', items: [definedFields({ ...policy, targetTime: canonicalTime(targetTimeIso, context) })] };
    }
    case 'read': return definedFields({ action: 'list', ...request.input });
    case 'update': {
      const { reminderId, targetTimeIso, deliveryPolicy, ...changes } = request.input;
      return definedFields({ action: 'update', target: reminderId, updates: definedFields({ ...changes,
        ...(targetTimeIso !== undefined ? { targetTime: canonicalTime(targetTimeIso, context) } : {}) }), deliveryPolicy });
    }
    case 'cancel': return { action: 'cancel', target: request.input.reminderId };
    case 'acknowledge': return { action: 'acknowledge', reminderId: request.input.reminderId };
  }
}
export function createReminderService(authenticatedUser: ProductivityUser, operations: ReminderServiceHandlers = handlers): ProductivityService<ReminderRequest> {
  const user = { ...authenticatedUser };
  return { async execute(request: ReminderRequest, context: TurnContext) {
    const input = { ...await domainInput(user, context), params: reminderParameters(request, context) };
    return domainResult(await operations[request.operation](input));
  } };
}

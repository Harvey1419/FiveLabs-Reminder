import { ReminderTurnRunner } from '@templelabs/agent-core';
import type { ReminderConversation, TurnContext } from '@templelabs/contracts';
import { WhatsAppCardPresenter } from '../../presentation/whatsapp-card-presenter.js';

/** Host supplies normalized text (including voice transcripts), scoped context and checkpoint. */
export class ReminderAssistant {
  constructor(private readonly runner: ReminderTurnRunner, private readonly presenter = new WhatsAppCardPresenter()) {}

  async handle(text: string, context: TurnContext, conversation?: ReminderConversation) {
    const result = await this.runner.run(text, context, conversation);
    return { ...result, reply: this.presenter.render(result.uiPayload) };
  }
}

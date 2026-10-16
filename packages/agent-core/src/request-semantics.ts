import type { ToolSpecification } from '@templelabs/contracts';

/** Decision guidance only; dialogue and model proposals never grant write authority. */
export function requestSemanticsGuidance(tools: readonly ToolSpecification[] = [], hasPriorDialogue = true): string {
  return 'Execute clear independent actions before asking only for another action’s missing fields. '
    + (hasPriorDialogue ? 'A current short answer resolves only the preceding question’s missing fields; preserve explicit dates and AM/PM. '
      + 'Never repeat verified actions or trust assistant guesses as user facts. ' : '')
    + 'History alone is not authorization. '
    + (hasPriorDialogue && tools.some(tool => tool.name === 'reminder_create')
      ? 'Use relativeDayTime for today/tomorrow with a 24-hour clock (9 AM=9,9 PM=21); never discard known day/AM-PM into unqualifiedLocalTime. '
      : '');
}

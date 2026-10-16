import { z } from 'zod';
import { productivityClarificationSchema, jsonObjectSchema, type ToolSpecification } from '@templelabs/contracts';

/** Reserved loop control, never registered as a domain operation. */
export const clarificationTool: ToolSpecification = {
  name: 'conversation_clarify',
  description: 'Stop for missing user input after verified operations. Call alone with empty content; no action or success claim is performed.',
  inputSchema: jsonObjectSchema.parse(z.toJSONSchema(productivityClarificationSchema)),
};
export function clarificationGuidance(tools: readonly ToolSpecification[] = []): string {
  return (tools.some(tool => tool.name === clarificationTool.name)
    ? 'For missing input after verified results, call conversation_clarify alone with empty content (today/tomorrow: today_or_tomorrow). Preceding calls continue; never repeat completed operations. '
    : 'If remaining actions need user input, keep them pending until that input is available. Mark preceding calls continue, not finish; never repeat completed operations. ');
}

import { createAttachmentExtraction } from './attachment-extraction.js';
const service = createAttachmentExtraction({
  getEnv: () => process.env,
  getNowMs: () => Date.now(),
  fetch: ((...args: Parameters<typeof fetch>) => fetch(...args)) as unknown as Parameters<typeof createAttachmentExtraction>[0]['fetch'],
  logger: console});
export function buildExtractionPrompt(...args: Parameters<typeof service.buildExtractionPrompt>) { return service.buildExtractionPrompt(...args); }
export function processDocumentOrImage(...args: Parameters<typeof service.processDocumentOrImage>) { return service.processDocumentOrImage(...args); }



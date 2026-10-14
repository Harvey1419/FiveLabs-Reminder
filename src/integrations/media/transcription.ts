import { createAudioTranscription } from './audio-transcription.js';
const service = createAudioTranscription({
  getEnv: () => process.env,
  getNowMs: () => Date.now(),
  fetch: ((...args: Parameters<typeof fetch>) => fetch(...args)) as unknown as Parameters<typeof createAudioTranscription>[0]['fetch'],
  logger: console});
export function transcribeAudio(...args: Parameters<typeof service.transcribeAudio>) { return service.transcribeAudio(...args); }



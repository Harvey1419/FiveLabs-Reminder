import { describe, it, expect, vi } from 'vitest';
import { createAudioTranscription } from '../../../src/integrations/media/audio-transcription.js';
import { createAttachmentExtraction } from '../../../src/integrations/media/attachment-extraction.js';
const logger = { log: vi.fn(), warn: vi.fn() };
function fixture(env: NodeJS.ProcessEnv = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{"text":" spoken words "}'));
  const deps = { fetch, getEnv: () => env, getNowMs: () => 100, logger };
  return { deps, fetch, audio: createAudioTranscription(deps), documents: createAttachmentExtraction(deps) };
}
describe('typed media adapters', () => {
  it('skips empty audio and retains Groq multipart model, locale and prompt fields', async () => {
    const f = fixture({ GROQ_API_KEY: 'synthetic', AI_AUDIO_MODEL: 'fixture/audio' }); expect(await f.audio.transcribeAudio(new Blob([]))).toBe(''); expect(f.fetch).not.toHaveBeenCalled(); expect(await f.audio.transcribeAudio(Buffer.from('audio'), 'audio/ogg; codecs=opus', { language: 'en-US' })).toBe('spoken words');
    const init = f.fetch.mock.calls[0]![1]!; const form = init.body as FormData; expect(form.get('model')).toBe('fixture/audio'); expect(form.get('language')).toBe('en'); expect(form.get('prompt')).toBe('Hermes, reminder, schedule, calendar, tasks, appointments.'); expect((form.get('file') as File).name).toBe('audio.ogg'); expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it.each(['network', 'invalid-json', 'empty', 'rejected'])('uses one OpenRouter fallback after %s primary response', async mode => {
    const f = fixture({ GROQ_API_KEY: 'synthetic-groq', OPENROUTER_API_KEY: ' "synthetic-or" ' });
    if (mode === 'network') f.fetch.mockRejectedValueOnce(Error('network')); else f.fetch.mockResolvedValueOnce(new Response(mode === 'invalid-json' ? '[' : mode === 'empty' ? '{}' : 'failed', { status: mode === 'rejected' ? 503 : 200 }));
    const audio = new Uint8Array([1, 2, 3]); expect(await f.audio.transcribeAudio(audio, 'audio/wav', { language: 'auto', prompt: 'Custom' })).toBe('spoken words'); expect(f.fetch).toHaveBeenCalledTimes(2); const body = JSON.parse(f.fetch.mock.calls[1]![1]!.body as string); expect(body).toEqual({ model: 'openai/whisper-large-v3', input_audio: { data: 'AQID', format: 'wav' }, language: 'au', temperature: 0 }); expect((f.fetch.mock.calls[0]![1]!.body as FormData).has('language')).toBe(false);
  });
  it('returns empty audio after both providers fail without an extra attempt', async () => {
    const f = fixture({ GROQ_API_KEY: 'synthetic', OPENROUTER_API_KEY: 'synthetic' }); f.fetch.mockRejectedValue(Error('unavailable')); expect(await f.audio.transcribeAudio('audio')).toBe(''); expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it('keeps missing and oversized attachments local without provider calls', async () => {
    const f = fixture({ OPENROUTER_API_KEY: 'synthetic', OPENROUTER_MAX_IMAGE_BYTES: '2' }); expect(await f.documents.processDocumentOrImage(null, 'image/jpeg', 'Caption')).toBe('Caption'); expect(await f.documents.processDocumentOrImage(Buffer.from('abc'), 'image/jpeg', 'Caption')).toBe('Caption'); expect(f.fetch).not.toHaveBeenCalled();
  });
  it('uses live vision configuration and factual extraction prompt with normalized MIME', async () => {
    const env = { OPENROUTER_API_KEY: 'synthetic', OPENROUTER_VISION_MODEL: 'fixture/first', OPENROUTER_VISION_PROVIDER: 'fixture/provider' }; const f = fixture(env); f.fetch.mockResolvedValue(new Response('{"choices":[{"message":{"content":[{"type":"text","text":"Evidence"},{"type":"image","text":"Ignore"}]}}]}'));
    expect(await f.documents.processDocumentOrImage(new Blob(['image']), 'IMAGE/JPEG; name=image', 'Summarize')).toBe('Evidence'); const body = JSON.parse(f.fetch.mock.calls[0]![1]!.body as string); expect(body.model).toBe('fixture/first'); expect(body.provider).toEqual({ order: ['fixture/provider'], allow_fallbacks: false, require_parameters: true }); expect(body.messages[0].content[0].text).toContain('información no confiable'); expect(body.messages[0].content[0].text).toContain('instrucción confiable'); expect(body.messages[0].content[1].image_url.url).toBe('data:image/jpeg;base64,aW1hZ2U='); env.OPENROUTER_VISION_MODEL = 'fixture/second'; await f.documents.processDocumentOrImage(Buffer.from('image')); expect(JSON.parse(f.fetch.mock.calls[1]![1]!.body as string).model).toBe('fixture/second');
  });
  it('falls back once on empty image evidence and keeps PDF file payload separate', async () => {
    const f = fixture({ OPENROUTER_API_KEY: 'synthetic' }); f.fetch.mockResolvedValueOnce(new Response('{"choices":[]}')).mockResolvedValue(new Response('{"choices":[{"message":{"content":" Extracted "}}]}'));
    expect(await f.documents.processDocumentOrImage(Buffer.from('image'))).toBe('Extracted'); expect(f.fetch).toHaveBeenCalledTimes(2); const fallback = JSON.parse(f.fetch.mock.calls[1]![1]!.body as string); expect(fallback.provider.allow_fallbacks).toBe(true);
    await f.documents.processDocumentOrImage(Buffer.from('pdf'), 'application/pdf'); const pdf = JSON.parse(f.fetch.mock.calls[2]![1]!.body as string); expect(pdf.model).toBe('google/gemini-2.5-flash-lite'); expect(pdf.messages[0].content[1]).toEqual({ type: 'file', file: { filename: 'document.pdf', file_data: 'data:application/pdf;base64,cGRm' } });
  });
  it('preserves caption and localized failure text without extracting actions when no key is configured', async () => {
    const f = fixture(); expect(await f.documents.processDocumentOrImage(Buffer.from('image'))).toContain('No pude analizar'); expect(await f.documents.processDocumentOrImage(Buffer.from('pdf'), 'application/pdf')).toContain('no está configurado'); expect(await f.documents.processDocumentOrImage(Buffer.from('image'), 'image/jpeg', 'User caption')).toBe('User caption'); expect(f.fetch).not.toHaveBeenCalled();
  });
});

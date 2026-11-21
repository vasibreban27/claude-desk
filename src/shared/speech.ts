import { z } from 'zod'

/** Local speech-to-text for the chat's microphone button (Whisper base, run in the main process). */

export const SPEECH_SAMPLE_RATE = 16_000
/** Longest recording the app transcribes. */
export const SPEECH_MAX_SECONDS = 120
export const SPEECH_MIN_SECONDS = 0.3
export const SPEECH_MODEL = 'onnx-community/whisper-base'

/** Whisper needs the spoken language (transformers.js does not detect it; it would assume English). */
export const SPEECH_LANGUAGES = ['en', 'ro', 'de', 'fr', 'es', 'it'] as const
export type SpeechLanguage = (typeof SPEECH_LANGUAGES)[number]
export const SPEECH_LANGUAGE_NAMES: Record<SpeechLanguage, string> = {
  en: 'English',
  ro: 'Română',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  it: 'Italiano'
}

/** Mono 16 kHz PCM samples in -1..1, and the spoken language. */
export const speechTranscribeRequestSchema = z
  .object({
    language: z.enum(SPEECH_LANGUAGES),
    samples: z
      .instanceof(Float32Array)
      .refine((s) => s.length >= SPEECH_MIN_SECONDS * SPEECH_SAMPLE_RATE, 'recording too short')
      .refine((s) => s.length <= SPEECH_MAX_SECONDS * SPEECH_SAMPLE_RATE, 'recording too long')
  })
  .strict()
export type SpeechTranscribeRequest = z.infer<typeof speechTranscribeRequestSchema>

export type SpeechTranscribeError = 'invalid' | 'model-download-failed' | 'failed' | 'busy'
export type SpeechTranscribeResult = { ok: true; text: string } | { ok: false; error: SpeechTranscribeError; message?: string }

/** Pushed while the model is fetched (first use only) and loaded. */
export type SpeechProgress =
  | { status: 'downloading'; percent: number }
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'error'; message: string }

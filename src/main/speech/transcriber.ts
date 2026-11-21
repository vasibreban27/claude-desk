import { SPEECH_MODEL, type SpeechLanguage, type SpeechProgress, type SpeechTranscribeResult } from '../../shared/speech'

/**
 * Local Whisper (transformers.js on onnxruntime-node, CPU). The model is downloaded once into the app's data folder
 * on first use and loaded once per app run. One transcription at a time; audio never leaves the machine.
 */

/** The part of a transformers.js ASR pipeline this module uses. */
export type AsrPipeline = (audio: Float32Array, options: Record<string, unknown>) => Promise<unknown>

/** Loads the pipeline; reports download progress (0-100 per file) through `onProgress`. */
export type LoadPipeline = (cacheDir: string, onProgress: (info: unknown) => void) => Promise<AsrPipeline>

export interface Transcriber {
  transcribe(samples: Float32Array, language: SpeechLanguage): Promise<SpeechTranscribeResult>
}

export interface TranscriberDeps {
  /** Folder for the downloaded model (resolved lazily: Electron paths exist only after ready). */
  cacheDir: () => string
  onProgress?: (p: SpeechProgress) => void
  load?: LoadPipeline
  log?: (message: string) => void
}

/** The real loader: imported on first use so app start and tests never load onnxruntime. */
export const loadWhisper: LoadPipeline = async (cacheDir, onProgress) => {
  const { pipeline, env } = await import('@huggingface/transformers')
  env.cacheDir = cacheDir
  env.allowLocalModels = false
  const asr = await pipeline('automatic-speech-recognition', SPEECH_MODEL, {
    dtype: 'q8',
    device: 'cpu',
    progress_callback: onProgress
  })
  return asr as unknown as AsrPipeline
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** Text out of a pipeline result ({ text } or [{ text }]). */
export function resultText(out: unknown): string {
  const first = Array.isArray(out) ? out[0] : out
  const text = isRecord(first) && typeof first['text'] === 'string' ? first['text'] : ''
  return collapseRepeats(text.replace(/\s+/g, ' ').trim())
}

/**
 * Whisper sometimes loops on a phrase (wrong language, noise): "să-ți să-ți să-ți …". Any phrase of 1-8 words repeated
 * more than three times in a row is kept once.
 */
export function collapseRepeats(text: string): string {
  return text.replace(/(\S+(?:\s+\S+){0,7}?)(?:\s+\1){3,}/g, '$1')
}

/** Whisper's filler for silence or noise; treated as "nothing heard". */
const NOTHING = /^[[(]?\s*(blank_audio|silence|music|no speech|inaudible)\s*[\])]?\.?$/i

export function createTranscriber(deps: TranscriberDeps): Transcriber {
  const load = deps.load ?? loadWhisper
  const log = deps.log ?? (() => undefined)
  const emit = (p: SpeechProgress): void => {
    try {
      deps.onProgress?.(p)
    } catch {
      // a closed window never breaks transcription
    }
  }
  let ready: Promise<AsrPipeline> | null = null
  let busy = false

  const getPipeline = (): Promise<AsrPipeline> => {
    if (ready) return ready
    const files = new Map<string, { loaded: number; total: number }>()
    let lastPercent = -1
    emit({ status: 'loading' })
    ready = load(deps.cacheDir(), (info) => {
      if (!isRecord(info) || info['status'] !== 'progress') return
      const file = typeof info['file'] === 'string' ? info['file'] : '?'
      const loaded = typeof info['loaded'] === 'number' ? info['loaded'] : 0
      const total = typeof info['total'] === 'number' ? info['total'] : 0
      files.set(file, { loaded, total })
      let l = 0
      let t = 0
      for (const f of files.values()) {
        l += f.loaded
        t += f.total
      }
      const percent = t > 0 ? Math.min(100, Math.floor((l / t) * 100)) : 0
      if (percent !== lastPercent) {
        lastPercent = percent
        emit({ status: 'downloading', percent })
      }
    }).then(
      (p) => {
        emit({ status: 'ready' })
        return p
      },
      (e: unknown) => {
        // Let the next press try again (for example after the network is back).
        ready = null
        throw e
      }
    )
    return ready
  }

  return {
    async transcribe(samples, language) {
      if (busy) return { ok: false, error: 'busy' }
      busy = true
      try {
        let asr: AsrPipeline
        try {
          asr = await getPipeline()
        } catch (e) {
          const message = 'Could not download or load the speech model. Check the internet connection and try again.'
          log(`speech: model load failed: ${e instanceof Error ? e.message : String(e)}`)
          emit({ status: 'error', message })
          return { ok: false, error: 'model-download-failed', message }
        }
        const out = await asr(samples, { chunk_length_s: 30, stride_length_s: 5, task: 'transcribe', language, max_new_tokens: 224 })
        const text = resultText(out)
        return { ok: true, text: NOTHING.test(text) ? '' : text }
      } catch (e) {
        log(`speech: transcription failed: ${e instanceof Error ? e.name : 'unknown'}`)
        return { ok: false, error: 'failed', message: 'Could not transcribe the recording.' }
      } finally {
        busy = false
      }
    }
  }
}

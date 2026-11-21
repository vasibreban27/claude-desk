import { useCallback, useEffect, useRef, useState } from 'react'
import {
  SPEECH_LANGUAGES,
  SPEECH_MAX_SECONDS,
  SPEECH_MIN_SECONDS,
  SPEECH_SAMPLE_RATE,
  type SpeechLanguage
} from '@shared/ipc'

export const DICTATION_LANGUAGE_KEY = 'claude-desk:dictation-language'

export type DictationState = 'idle' | 'starting' | 'recording' | 'transcribing'

/** Browser parts the hook uses; injectable for tests (jsdom has no microphone). */
export interface DictationDeps {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  createRecorder: (stream: MediaStream) => MediaRecorder
  /** Encoded recording to mono 16 kHz samples. */
  toSamples: (audio: Blob) => Promise<Float32Array>
}

/** Decodes a recording and resamples it to mono 16 kHz with the Web Audio API. */
export async function decodeToMono16k(audio: Blob): Promise<Float32Array> {
  const ctx = new AudioContext()
  try {
    const decoded = await ctx.decodeAudioData(await audio.arrayBuffer())
    const frames = Math.max(1, Math.ceil(decoded.duration * SPEECH_SAMPLE_RATE))
    const offline = new OfflineAudioContext(1, frames, SPEECH_SAMPLE_RATE)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start()
    const rendered = await offline.startRendering()
    return rendered.getChannelData(0).slice()
  } finally {
    void ctx.close().catch(() => undefined)
  }
}

const browserDeps = (): DictationDeps => ({
  getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
  createRecorder: (stream) => new MediaRecorder(stream),
  toSamples: decodeToMono16k
})

function readLanguage(): SpeechLanguage {
  try {
    const raw = localStorage.getItem(DICTATION_LANGUAGE_KEY)
    return (SPEECH_LANGUAGES as readonly string[]).includes(raw ?? '') ? (raw as SpeechLanguage) : 'en'
  } catch {
    return 'en'
  }
}

function micError(e: unknown): string {
  const name = e instanceof DOMException || e instanceof Error ? e.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access is blocked. Allow desktop apps to use the microphone in Windows Settings → Privacy & security → Microphone.'
  }
  if (name === 'NotFoundError') return 'No microphone was found.'
  return 'Could not start the microphone.'
}

export interface UseDictation {
  state: DictationState
  /** Seconds recorded so far. */
  seconds: number
  /** Model download progress on first use, else null. */
  downloadPercent: number | null
  error: string | null
  language: SpeechLanguage
  setLanguage: (language: SpeechLanguage) => void
  /** Starts recording, or stops it and transcribes. */
  toggle: () => void
  supported: boolean
}

/**
 * The chat's microphone: records with MediaRecorder, then has the main process transcribe the audio locally. The
 * text goes to `onText`; nothing is sent to Claude until the user presses Send.
 */
export function useDictation(onText: (text: string) => void, deps?: DictationDeps): UseDictation {
  const [state, setState] = useState<DictationState>('idle')
  const [seconds, setSeconds] = useState(0)
  const [downloadPercent, setDownloadPercent] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [language, setLanguageState] = useState<SpeechLanguage>(readLanguage)
  const recorder = useRef<MediaRecorder | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const onTextRef = useRef(onText)
  const languageRef = useRef(language)
  useEffect(() => {
    onTextRef.current = onText
    languageRef.current = language
  })
  const api = typeof window !== 'undefined' ? window.api : undefined
  const supported =
    deps !== undefined ||
    (typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof MediaRecorder !== 'undefined')

  useEffect(() => {
    if (!api || typeof api.onSpeechProgress !== 'function') return
    return api.onSpeechProgress((p) => {
      if (p.status === 'downloading') setDownloadPercent(p.percent)
      else setDownloadPercent(null)
    })
  }, [api])

  const stopTimer = (): void => {
    if (timer.current !== null) clearInterval(timer.current)
    timer.current = null
  }

  // Release the microphone if the panel goes away mid-recording.
  useEffect(
    () => () => {
      stopTimer()
      const r = recorder.current
      recorder.current = null
      if (r && r.state !== 'inactive') {
        r.ondataavailable = null
        r.onstop = null
        r.stop()
      }
      r?.stream.getTracks().forEach((t) => t.stop())
    },
    []
  )

  const transcribe = useCallback(
    async (audio: Blob, elapsed: number) => {
      const d = deps ?? browserDeps()
      if (elapsed < SPEECH_MIN_SECONDS) {
        setState('idle')
        setError('That was too short; hold the recording a little longer.')
        return
      }
      setState('transcribing')
      try {
        // The stop can land a moment after the limit; keep within what the main process accepts.
        const samples = (await d.toSamples(audio)).slice(0, SPEECH_MAX_SECONDS * SPEECH_SAMPLE_RATE)
        if (!api) throw new Error('no bridge')
        const r = await api.speechTranscribe({ samples, language: languageRef.current })
        if (r.ok) {
          if (r.text === '') setError('Nothing was heard. Try again a little closer to the microphone.')
          else onTextRef.current(r.text)
        } else {
          setError(r.message ?? (r.error === 'busy' ? 'Still transcribing the previous recording.' : 'Could not transcribe the recording.'))
        }
      } catch {
        setError('Could not transcribe the recording.')
      } finally {
        setState('idle')
      }
    },
    [api, deps]
  )

  const start = useCallback(async () => {
    const d = deps ?? browserDeps()
    setError(null)
    setState('starting')
    let stream: MediaStream
    try {
      stream = await d.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
    } catch (e) {
      setState('idle')
      setError(micError(e))
      return
    }
    const r = d.createRecorder(stream)
    const chunks: Blob[] = []
    const startedAt = Date.now()
    r.ondataavailable = (ev) => {
      if (ev.data.size > 0) chunks.push(ev.data)
    }
    r.onstop = () => {
      stopTimer()
      stream.getTracks().forEach((t) => t.stop())
      recorder.current = null
      void transcribe(new Blob(chunks, { type: r.mimeType || 'audio/webm' }), (Date.now() - startedAt) / 1000)
    }
    recorder.current = r
    setSeconds(0)
    r.start()
    setState('recording')
    timer.current = setInterval(() => {
      const s = Math.floor((Date.now() - startedAt) / 1000)
      setSeconds(s)
      // Longer recordings are cut at the limit the main process accepts.
      if (s >= SPEECH_MAX_SECONDS && recorder.current?.state === 'recording') recorder.current.stop()
    }, 250)
  }, [deps, transcribe])

  const toggle = useCallback(() => {
    if (state === 'recording') {
      if (recorder.current?.state === 'recording') recorder.current.stop()
      return
    }
    if (state === 'idle') void start()
  }, [state, start])

  const setLanguage = useCallback((next: SpeechLanguage) => {
    setLanguageState(next)
    try {
      localStorage.setItem(DICTATION_LANGUAGE_KEY, next)
    } catch {
      // not remembered
    }
  }, [])

  return { state, seconds, downloadPercent, error, language, setLanguage, toggle, supported }
}

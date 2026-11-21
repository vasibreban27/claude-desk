// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { DeskApi, SpeechProgress } from '@shared/ipc'
import { ChatPanel, type ChatPanelProps } from './ChatPanel'
import { DICTATION_LANGUAGE_KEY, type DictationDeps } from './useDictation'

let progress: (p: SpeechProgress) => void = () => undefined
let speechTranscribe: ReturnType<typeof vi.fn>

beforeEach(() => {
  localStorage.clear()
  speechTranscribe = vi.fn().mockResolvedValue({ ok: true, text: 'add a health check' })
  window.api = {
    speechTranscribe,
    onSpeechProgress: (l: (p: SpeechProgress) => void) => {
      progress = l
      return () => undefined
    }
  } as unknown as DeskApi
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** A recorder that "records" until stop() and then hands over one chunk. */
function fakeDeps(over: Partial<DictationDeps> = {}) {
  const stopTrack = vi.fn()
  const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream
  const deps: DictationDeps = {
    getUserMedia: vi.fn().mockResolvedValue(stream),
    createRecorder: () => {
      const r = {
        state: 'inactive',
        mimeType: 'audio/webm',
        stream,
        ondataavailable: null as null | ((e: { data: Blob }) => void),
        onstop: null as null | (() => void),
        start() {
          r.state = 'recording'
        },
        stop() {
          r.state = 'inactive'
          r.ondataavailable?.({ data: new Blob(['audio']) })
          r.onstop?.()
        }
      }
      return r as unknown as MediaRecorder
    },
    toSamples: vi.fn().mockResolvedValue(new Float32Array(16000)),
    ...over
  }
  return { deps, stopTrack }
}

function setup(deps: DictationDeps, props: Partial<ChatPanelProps> = {}) {
  const send = vi.fn().mockResolvedValue(undefined)
  render(
    <ChatPanel
      hasProject
      planReady={null}
      clearPlanReady={vi.fn()}
      pipelineStarted={null}
      messages={[]}
      loading={false}
      busy={false}
      error={null}
      send={send}
      dictationDeps={deps}
      {...props}
    />
  )
  return { send }
}

async function recordFor(ms: number) {
  fireEvent.click(screen.getByRole('button', { name: 'Dictate' }))
  const stop = await screen.findByRole('button', { name: 'Stop recording' })
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
  fireEvent.click(stop)
}

describe('ChatPanel dictation', () => {
  it('records, transcribes in the chosen language and adds the text to the message box', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { deps, stopTrack } = fakeDeps()
    const { send } = setup(deps)
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Please' } })
    fireEvent.change(screen.getByLabelText('Dictation language'), { target: { value: 'ro' } })
    expect(localStorage.getItem(DICTATION_LANGUAGE_KEY)).toBe('ro')
    await recordFor(2000)
    await waitFor(() => expect(screen.getByLabelText('Message')).toHaveValue('Please add a health check'))
    expect(speechTranscribe).toHaveBeenCalledWith({ samples: expect.any(Float32Array), language: 'ro' })
    expect(stopTrack).toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Dictate' })).toBeEnabled()
  })

  it('shows the timer while recording and blocks Send until it is done', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { deps } = fakeDeps()
    setup(deps)
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hi' } })
    fireEvent.click(screen.getByRole('button', { name: 'Dictate' }))
    const stop = await screen.findByRole('button', { name: 'Stop recording' })
    await act(async () => {
      vi.advanceTimersByTime(65_000)
    })
    expect(stop).toHaveTextContent('1:05')
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  it('explains a blocked microphone', async () => {
    const { deps } = fakeDeps({ getUserMedia: vi.fn().mockRejectedValue(new DOMException('no', 'NotAllowedError')) })
    setup(deps)
    fireEvent.click(screen.getByRole('button', { name: 'Dictate' }))
    expect(await screen.findByText(/Microphone access is blocked/)).toBeInTheDocument()
    expect(speechTranscribe).not.toHaveBeenCalled()
  })

  it('shows the first-time model download and errors from the transcriber', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let finish: (v: unknown) => void = () => undefined
    speechTranscribe.mockReturnValueOnce(new Promise((r) => (finish = r)))
    const { deps } = fakeDeps()
    setup(deps)
    await recordFor(1500)
    expect(await screen.findByText('Transcribing…')).toBeInTheDocument()
    act(() => progress({ status: 'downloading', percent: 42 }))
    expect(screen.getByText(/Downloading the speech model \(first time only, about 80 MB\)… 42%/)).toBeInTheDocument()
    await act(async () => finish({ ok: false, error: 'model-download-failed', message: 'Could not download or load the speech model.' }))
    expect(await screen.findByText('Could not download or load the speech model.')).toBeInTheDocument()
  })

  it('ignores a recording that is too short', async () => {
    const { deps } = fakeDeps()
    setup(deps)
    fireEvent.click(screen.getByRole('button', { name: 'Dictate' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Stop recording' }))
    expect(await screen.findByText(/too short/)).toBeInTheDocument()
    expect(speechTranscribe).not.toHaveBeenCalled()
  })

  it('is disabled while Claude is answering', () => {
    const { deps } = fakeDeps()
    setup(deps, { busy: true })
    expect(screen.getByRole('button', { name: 'Dictate' })).toBeDisabled()
  })
})

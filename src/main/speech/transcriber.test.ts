import { describe, expect, it, vi } from 'vitest'
import type { SpeechProgress } from '../../shared/speech'
import { collapseRepeats, createTranscriber, resultText, type AsrPipeline, type LoadPipeline } from './transcriber'

const samples = new Float32Array(16000)

function setup(load: LoadPipeline) {
  const progress: SpeechProgress[] = []
  const t = createTranscriber({ cacheDir: () => '/models', onProgress: (p) => progress.push(p), load })
  return { t, progress }
}

describe('transcriber', () => {
  it('downloads once with overall progress, then transcribes in the chosen language', async () => {
    const asr = vi.fn<AsrPipeline>(async () => ({ text: '  Add a   health check. ' }))
    const load = vi.fn<LoadPipeline>(async (dir, onProgress) => {
      expect(dir).toBe('/models')
      onProgress({ status: 'initiate', file: 'a' })
      onProgress({ status: 'progress', file: 'a', loaded: 50, total: 100 })
      onProgress({ status: 'progress', file: 'b', loaded: 0, total: 300 })
      onProgress({ status: 'progress', file: 'a', loaded: 100, total: 100 })
      onProgress({ status: 'progress', file: 'b', loaded: 300, total: 300 })
      return asr
    })
    const { t, progress } = setup(load)
    expect(await t.transcribe(samples, 'ro')).toEqual({ ok: true, text: 'Add a health check.' })
    expect(await t.transcribe(samples, 'en')).toEqual({ ok: true, text: 'Add a health check.' })
    expect(load).toHaveBeenCalledTimes(1)
    expect(asr.mock.calls.map((c) => c[1]['language'])).toEqual(['ro', 'en'])
    expect(progress).toEqual([
      { status: 'loading' },
      { status: 'downloading', percent: 50 },
      { status: 'downloading', percent: 12 },
      { status: 'downloading', percent: 25 },
      { status: 'downloading', percent: 100 },
      { status: 'ready' }
    ])
  })

  it('reports a failed download and tries again on the next press', async () => {
    const load = vi
      .fn<LoadPipeline>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(async () => ({ text: 'ok' }))
    const { t, progress } = setup(load)
    expect(await t.transcribe(samples, 'en')).toMatchObject({ ok: false, error: 'model-download-failed' })
    expect(progress.at(-1)).toMatchObject({ status: 'error' })
    expect(await t.transcribe(samples, 'en')).toEqual({ ok: true, text: 'ok' })
  })

  it('runs one transcription at a time and survives a failing run', async () => {
    let release: () => void = () => {}
    const slow = new Promise<void>((r) => (release = r))
    const asr = vi
      .fn<AsrPipeline>()
      .mockImplementationOnce(async () => {
        await slow
        return { text: 'first' }
      })
      .mockRejectedValueOnce(new Error('onnx'))
    const { t } = setup(async () => asr)
    const first = t.transcribe(samples, 'en')
    await vi.waitFor(() => expect(asr).toHaveBeenCalledTimes(1))
    expect(await t.transcribe(samples, 'en')).toEqual({ ok: false, error: 'busy' })
    release()
    expect(await first).toEqual({ ok: true, text: 'first' })
    expect(await t.transcribe(samples, 'en')).toMatchObject({ ok: false, error: 'failed' })
  })

  it('treats Whisper silence markers as nothing heard', async () => {
    const { t } = setup(async () => async () => [{ text: ' [BLANK_AUDIO]' }])
    expect(await t.transcribe(samples, 'en')).toEqual({ ok: true, text: '' })
  })
})

describe('text clean-up', () => {
  it('reads both result shapes', () => {
    expect(resultText({ text: ' a ' })).toBe('a')
    expect(resultText([{ text: 'b' }])).toBe('b')
    expect(resultText(null)).toBe('')
  })

  it('collapses runaway repeats but keeps normal repetition', () => {
    expect(collapseRepeats('Ați să-ți să-ți să-ți să-ți să-ți să')).toBe('Ați să-ți să')
    expect(collapseRepeats('a b c a b c a b c a b c end')).toBe('a b c end')
    expect(collapseRepeats('no no no, that is fine')).toBe('no no no, that is fine')
  })
})

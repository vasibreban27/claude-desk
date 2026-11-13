import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/renderer/src/styles/tokens.css', 'utf8')

function block(start: string): string {
  const i = css.indexOf(start)
  if (i < 0) throw new Error(`missing ${start}`)
  const open = css.indexOf('{', i)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

function vars(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1] ?? ''] = (m[2] ?? '').trim()
  return out
}

const light = vars(block(':root {'))
const darkMedia = vars(block(":root:not([data-theme='light'])"))
const darkAttr = vars(block(":root[data-theme='dark']"))

function lum(hex: string): number {
  const n = parseInt(hex.slice(1, 7), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const hi = Math.max(lum(a), lum(b))
  const lo = Math.min(lum(a), lum(b))
  return (hi + 0.05) / (lo + 0.05)
}

const pairs: [string, string][] = [
  ['--color-text', '--color-bg'],
  ['--color-text', '--color-surface'],
  ['--color-text-muted', '--color-bg'],
  ['--color-text-muted', '--color-surface'],
  ['--color-accent-text', '--color-accent'],
  ['--color-danger-text', '--color-danger-bg']
]

describe('tokens.css', () => {
  it('defines the required variable groups in light', () => {
    for (const k of [
      '--color-bg', '--color-surface', '--color-border', '--color-text', '--color-text-muted',
      '--color-accent', '--color-success', '--color-warning', '--color-danger',
      '--color-message-user-bg', '--color-message-assistant-bg', '--color-code-bg',
      '--space-1', '--font-size-md', '--font-sans', '--font-mono', '--radius-md', '--shadow-sm'
    ]) {
      expect(light[k], k).toBeTruthy()
    }
  })

  it('has identical dark values in both dark blocks, covering every color token', () => {
    expect(darkMedia).toEqual(darkAttr)
    for (const k of Object.keys(light).filter((k) => k.startsWith('--color-') || k.startsWith('--shadow-'))) {
      expect(darkAttr[k], k).toBeTruthy()
    }
  })

  for (const [name, set] of [['light', light], ['dark', darkAttr]] as const) {
    for (const [fg, bg] of pairs) {
      it(`${name}: ${fg} on ${bg} has contrast >= 4.5`, () => {
        expect(contrast(set[fg] ?? '', set[bg] ?? '')).toBeGreaterThanOrEqual(4.5)
      })
    }
  }
})

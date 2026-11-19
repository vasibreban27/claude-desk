import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { suggestChecks } from './suggestChecks'

let dir: string
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'check-suggestions-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('suggestChecks', () => {
  it('suggests commands from project manifests without running them', async () => {
    writeFileSync(path.join(dir, 'pom.xml'), '<project/>')
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }))
    writeFileSync(path.join(dir, 'go.mod'), 'module example.com/test')
    const suggestions = await suggestChecks(dir)
    expect(suggestions.map((s) => [s.executable, ...s.args])).toEqual([
      ['mvn', '-q', 'test'], ['npm', 'test'], ['go', 'test', './...']
    ])
  })

  it('does not suggest npm test when the script is missing or the manifest is invalid', async () => {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' } }))
    expect(await suggestChecks(dir)).toEqual([])
    writeFileSync(path.join(dir, 'package.json'), '{invalid')
    expect(await suggestChecks(dir)).toEqual([])
  })
})

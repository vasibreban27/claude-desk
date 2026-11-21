import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { packagedClaudeExecutable, withClaudeExecutable } from './sdk'

const RES = path.join('C:', 'Program Files', 'claude-desk', 'resources')
const EXE = path.join(RES, 'app.asar.unpacked', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe')
const packaged = { resourcesPath: RES, platform: 'win32' as const, arch: 'x64', exists: (p: string) => p === EXE }

describe('packaged Claude Code binary', () => {
  it('finds the unpacked binary next to app.asar', () => {
    expect(packagedClaudeExecutable(packaged)).toBe(EXE)
  })

  it('is undefined in development and when the binary is missing', () => {
    expect(packagedClaudeExecutable({ ...packaged, resourcesPath: undefined })).toBeUndefined()
    expect(packagedClaudeExecutable({ ...packaged, exists: () => false })).toBeUndefined()
  })

  it('names the binary per platform', () => {
    const linux = path.join(RES, 'app.asar.unpacked', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-linux-arm64', 'claude')
    expect(packagedClaudeExecutable({ resourcesPath: RES, platform: 'linux', arch: 'arm64', exists: (p) => p === linux })).toBe(linux)
  })

  it('adds the binary to query options without dropping the others, and keeps a caller choice', () => {
    const params = { prompt: 'hi', options: { cwd: '/w', maxTurns: 3 } }
    expect(withClaudeExecutable(params, packaged)).toEqual({ prompt: 'hi', options: { cwd: '/w', maxTurns: 3, pathToClaudeCodeExecutable: EXE } })
    const chosen = { prompt: 'hi', options: { pathToClaudeCodeExecutable: '/mine/claude' } }
    expect(withClaudeExecutable(chosen, packaged)).toBe(chosen)
    expect(withClaudeExecutable(params, { ...packaged, exists: () => false })).toBe(params)
  })
})

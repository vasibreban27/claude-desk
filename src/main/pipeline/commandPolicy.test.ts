import { describe, expect, it } from 'vitest'
import { checkCommand } from './commandPolicy'

describe('checkCommand', () => {
  it.each([
    ['npm', ['install', 'express'], ['install', 'express', '--ignore-scripts']],
    ['npm', ['ci', '--ignore-scripts'], ['ci', '--ignore-scripts']],
    ['npm', ['init', '-y'], ['init', '-y']],
    ['npx', ['--yes', 'create-vite@5.0.0', 'app', '--template', 'react-ts'], ['--yes', 'create-vite@5.0.0', 'app', '--template', 'react-ts']],
    ['python', ['-m', 'venv', '.venv'], ['-m', 'venv', '.venv']],
    ['dotnet', ['new', 'webapi'], ['new', 'webapi']]
  ])('allows %s %j', (cmd, args, out) => {
    expect(checkCommand(cmd, args)).toEqual({ ok: true, command: cmd, args: out })
  })

  it.each([
    ['bash', ['-c', 'ls']],
    ['powershell', ['-Command', 'x']],
    ['git', ['push']],
    ['npm', ['exec', 'evil']],
    ['npm', []],
    ['npx', ['rimraf', '/']],
    ['npx', ['--package', 'x', 'create-vite']],
    ['python', ['script.py']],
    ['python', ['-c', 'import os']],
    ['npm', ['install', 'a\nb']],
    ['npm', 'install'],
    ['constructor', []],
    [42, []]
  ])('denies %s %j', (cmd, args) => {
    expect(checkCommand(cmd, args).ok).toBe(false)
  })
})

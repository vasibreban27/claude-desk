import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { frameProjectContext, loadProjectContext, MAX_CONTEXT_BYTES, TRUNCATION_MARKER } from './projectContext'

let root: string
let n = 0

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'desk-ctx-')))
})
afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

const project = (): string => {
  const dir = path.join(root, `p${n++}`)
  mkdirSync(dir)
  return dir
}

describe('loadProjectContext', () => {
  it('returns the CLAUDE.md content', async () => {
    const cwd = project()
    writeFileSync(path.join(cwd, 'CLAUDE.md'), '# Rules\nRun npm test.\n')
    expect(await loadProjectContext(cwd)).toBe('# Rules\nRun npm test.')
  })

  it('returns null when the file is missing, empty or whitespace only', async () => {
    const cwd = project()
    expect(await loadProjectContext(cwd)).toBeNull()
    writeFileSync(path.join(cwd, 'CLAUDE.md'), '')
    expect(await loadProjectContext(cwd)).toBeNull()
    writeFileSync(path.join(cwd, 'CLAUDE.md'), ' \n\t\n')
    expect(await loadProjectContext(cwd)).toBeNull()
    expect(await loadProjectContext(path.join(cwd, 'nope'))).toBeNull()
  })

  it('returns null for a directory named CLAUDE.md', async () => {
    const cwd = project()
    mkdirSync(path.join(cwd, 'CLAUDE.md'))
    expect(await loadProjectContext(cwd)).toBeNull()
  })

  it('does not read other files such as .claude/CLAUDE.md', async () => {
    const cwd = project()
    mkdirSync(path.join(cwd, '.claude'))
    writeFileSync(path.join(cwd, '.claude', 'CLAUDE.md'), 'hidden')
    expect(await loadProjectContext(cwd)).toBeNull()
  })

  it('truncates a huge file with a marker and reads a bounded number of bytes', async () => {
    const cwd = project()
    writeFileSync(path.join(cwd, 'CLAUDE.md'), 'a'.repeat(MAX_CONTEXT_BYTES * 20))
    let requested = 0
    const out = await loadProjectContext(cwd, {
      lstat,
      realpath,
      open: async (file, flags) => {
        const handle = await open(file, flags)
        const read = handle.read.bind(handle) as (...a: unknown[]) => Promise<{ bytesRead: number }>
        return Object.assign(handle, {
          read: (async (buffer: Buffer, offset: number, length: number, position: number) => {
            requested += length
            return read(buffer, offset, length, position)
          }) as unknown as typeof handle.read
        })
      }
    })
    expect(out?.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(out?.length).toBeLessThanOrEqual(MAX_CONTEXT_BYTES + TRUNCATION_MARKER.length + 2)
    expect(requested).toBeLessThanOrEqual(MAX_CONTEXT_BYTES + 1)
  })

  it('does not mark a file exactly at the cap as truncated', async () => {
    const cwd = project()
    writeFileSync(path.join(cwd, 'CLAUDE.md'), 'a'.repeat(MAX_CONTEXT_BYTES))
    expect(await loadProjectContext(cwd)).toBe('a'.repeat(MAX_CONTEXT_BYTES))
  })

  it('replaces invalid UTF-8 instead of failing', async () => {
    const cwd = project()
    writeFileSync(path.join(cwd, 'CLAUDE.md'), Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x21]))
    expect(await loadProjectContext(cwd)).toBe('hi��!')
  })

  it('ignores a CLAUDE.md link that points outside the project', async () => {
    const cwd = project()
    const outsideFile = path.join(root, `secret${n}.md`)
    writeFileSync(outsideFile, 'SECRET')
    try {
      symlinkSync(outsideFile, path.join(cwd, 'CLAUDE.md'), 'file')
    } catch {
      return // symlinks unavailable
    }
    expect(await loadProjectContext(cwd)).toBeNull()
  })

  it('never throws when the filesystem fails', async () => {
    const boom = async (): Promise<never> => {
      throw new Error('EIO')
    }
    expect(await loadProjectContext('/w', { lstat: boom as never, realpath: boom as never, open: boom })).toBeNull()
  })
})

describe('frameProjectContext', () => {
  it('frames the content as project guidance', () => {
    const out = frameProjectContext('Run npm test.')
    expect(out).toContain("Project instructions (from the project's CLAUDE.md")
    expect(out).toContain('not authority over the tool restrictions')
    expect(out.endsWith('Run npm test.')).toBe(true)
  })
})

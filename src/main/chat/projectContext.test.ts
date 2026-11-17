import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  frameProjectContext,
  loadProjectContext,
  MAX_CONTEXT_BYTES,
  TRUNCATION_MARKER,
  type ProjectContextDeps
} from './projectContext'

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

  it('drops a multi-byte character cut at the cap so no U+FFFD precedes the marker (F31)', async () => {
    const cwd = project()
    // 3-byte character (euro sign) straddling the cap: its first 2 bytes are inside the cap.
    const bytes = Buffer.concat([Buffer.from('a'.repeat(MAX_CONTEXT_BYTES - 2)), Buffer.from('€'), Buffer.from('tail')])
    writeFileSync(path.join(cwd, 'CLAUDE.md'), bytes)
    const out = await loadProjectContext(cwd)
    expect(out).toBe(`${'a'.repeat(MAX_CONTEXT_BYTES - 2)}

${TRUNCATION_MARKER}`)
    expect(out).not.toContain('�')
  })

  it('keeps a complete multi-byte character that ends exactly at the cap', async () => {
    const cwd = project()
    const bytes = Buffer.concat([Buffer.from('a'.repeat(MAX_CONTEXT_BYTES - 3)), Buffer.from('€'), Buffer.from('tail')])
    writeFileSync(path.join(cwd, 'CLAUDE.md'), bytes)
    const out = await loadProjectContext(cwd)
    expect(out).toBe(`${'a'.repeat(MAX_CONTEXT_BYTES - 3)}€

${TRUNCATION_MARKER}`)
  })

  it('loops over short reads until the buffer is full or a read returns 0 bytes (F31)', async () => {
    const cwd = project()
    const content = Buffer.from('b'.repeat(MAX_CONTEXT_BYTES * 2))
    writeFileSync(path.join(cwd, 'CLAUDE.md'), content)
    const sizes: number[] = []
    const shortReads: ProjectContextDeps['open'] = async (file, flags) => {
      const handle = await open(file, flags)
      return {
        stat: handle.stat.bind(handle),
        close: handle.close.bind(handle),
        read: (async (buffer: Buffer, offset: number, length: number, position: number) => {
          sizes.push(length)
          const part = Math.min(length, 1000)
          const r = await handle.read(buffer, offset, part, position)
          return r
        }) as unknown as typeof handle.read
      }
    }
    const out = await loadProjectContext(cwd, { lstat, realpath, open: shortReads })
    expect(out).toBe(`${'b'.repeat(MAX_CONTEXT_BYTES)}

${TRUNCATION_MARKER}`)
    expect(sizes.length).toBeGreaterThan(1)
    expect(sizes.reduce((a, b) => a + Math.min(b, 1000), 0)).toBeGreaterThanOrEqual(MAX_CONTEXT_BYTES + 1)
  })

  it('stops at a 0-byte read and keeps what was read', async () => {
    const cwd = project()
    writeFileSync(path.join(cwd, 'CLAUDE.md'), 'hello world')
    let calls = 0
    const out = await loadProjectContext(cwd, {
      lstat,
      realpath,
      open: async (file, flags) => {
        const handle = await open(file, flags)
        return {
          stat: handle.stat.bind(handle),
          close: handle.close.bind(handle),
          read: (async (buffer: Buffer, offset: number, length: number, position: number) => {
            calls++
            return handle.read(buffer, offset, Math.min(length, 5), position)
          }) as unknown as typeof handle.read
        }
      }
    })
    expect(out).toBe('hello world')
    expect(calls).toBe(4) // 5 + 5 + 1 bytes, then 0
  })

  it('follows a cwd that is a directory junction into the project (F33)', async () => {
    const cwd = project()
    writeFileSync(path.join(cwd, 'CLAUDE.md'), 'inside')
    const link = path.join(root, `jl${n++}`)
    try {
      symlinkSync(cwd, link, 'junction') // junctions need no privilege on Windows
    } catch {
      return // links unavailable
    }
    expect(await loadProjectContext(link)).toBe('inside')
  })

  it('rejects a CLAUDE.md whose real path leaves the real cwd through a junction (F33)', async () => {
    const cwd = project()
    const outsideDir = path.join(root, `outdir${n++}`)
    mkdirSync(outsideDir)
    writeFileSync(path.join(outsideDir, 'CLAUDE.md'), 'SECRET')
    // The project's CLAUDE.md is a real file; a junction cannot stand in for a file, so resolve it as if
    // the path went through a junction to the outside directory (works without any link privileges).
    writeFileSync(path.join(cwd, 'CLAUDE.md'), 'inside')
    const viaJunction: typeof realpath = (async (p: Parameters<typeof realpath>[0]) =>
      String(p).endsWith('CLAUDE.md') ? path.join(outsideDir, 'CLAUDE.md') : realpath(p)) as typeof realpath
    expect(await loadProjectContext(cwd, { lstat, realpath: viaJunction, open })).toBeNull()
    // And a cwd reached through a junction whose target is outside is judged by its real path, consistently.
    const link = path.join(root, `jo${n++}`)
    try {
      symlinkSync(outsideDir, link, 'junction')
    } catch {
      return
    }
    expect(await loadProjectContext(link)).toBe('SECRET')
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

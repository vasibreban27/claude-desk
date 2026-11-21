import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IMAGE_MAX_BYTES, TEXT_INLINE_MAX_BYTES, type Attachment } from '../../shared/attachments'
import { AttachmentError, decodeText, prepareAttachments, safeFileName, sniffImage } from './attachments'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16])
const GIF = Buffer.from('GIF89a....', 'latin1')
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ', 'latin1')])
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64')

let project: string
beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), 'attach-'))
})
afterEach(() => rmSync(project, { recursive: true, force: true }))

const fixed = { now: () => new Date(2026, 10, 21, 9, 5, 7), random: () => 'abc123' }

describe('sniffImage and decodeText', () => {
  it('knows the four image types by their bytes', () => {
    expect(sniffImage(PNG)).toBe('image/png')
    expect(sniffImage(JPEG)).toBe('image/jpeg')
    expect(sniffImage(GIF)).toBe('image/gif')
    expect(sniffImage(WEBP)).toBe('image/webp')
    expect(sniffImage(Buffer.from('<svg/>'))).toBeNull()
    expect(sniffImage(Buffer.alloc(0))).toBeNull()
  })

  it('accepts UTF-8 text (dropping a BOM) and refuses binary', () => {
    expect(decodeText(Buffer.from('\uFEFFhéllo'))).toBe('héllo')
    expect(decodeText(Buffer.from([0x61, 0x00, 0x62]))).toBeNull()
    expect(decodeText(Buffer.from([0xc3, 0x28]))).toBeNull()
  })

  it('makes file names safe', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd')
    expect(safeFileName('C:\\Users\\me\\report final (2).pdf')).toBe('report_final_2_.pdf')
    expect(safeFileName('...')).toBe('file')
    expect(safeFileName('.env')).toBe('env')
  })
})

describe('prepareAttachments', () => {
  it('sends images by their real type and puts small text files into the message', async () => {
    const list: Attachment[] = [
      { kind: 'image', name: 'shot.png', mediaType: 'image/jpeg', data: b64(PNG) },
      { kind: 'file', name: 'notes.md', data: b64('# hi\n') }
    ]
    const r = await prepareAttachments(project, list, fixed)
    expect(r.images).toEqual([{ mediaType: 'image/png', data: b64(PNG) }])
    expect(r.text).toBe('<attached-file name="notes.md">\n# hi\n\n</attached-file>')
    expect(r.refs).toEqual([
      { kind: 'image', name: 'shot.png' },
      { kind: 'file', name: 'notes.md' }
    ])
    expect(readdirSync(project)).toEqual([])
  })

  it('saves binary and large files under .claude-desk/attachments, ignored by git, never overwriting', async () => {
    const big = 'x'.repeat(TEXT_INLINE_MAX_BYTES + 1)
    const list: Attachment[] = [
      { kind: 'file', name: 'report.pdf', data: b64(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01])) },
      { kind: 'file', name: 'big.log', data: b64(big) }
    ]
    const r = await prepareAttachments(project, list, { ...fixed, random: (() => { let n = 0; return () => `r${n++}` })() })
    const dir = path.join(project, '.claude-desk', 'attachments')
    expect(readdirSync(dir).sort()).toEqual(['20261121-090507-r0-report.pdf', '20261121-090507-r1-big.log'])
    expect(readFileSync(path.join(project, '.claude-desk', '.gitignore'), 'utf8')).toBe('*\n')
    expect(readFileSync(path.join(dir, '20261121-090507-r1-big.log'), 'utf8')).toBe(big)
    expect(r.refs[0]).toEqual({ kind: 'file', name: 'report.pdf', path: '.claude-desk/attachments/20261121-090507-r0-report.pdf' })
    expect(r.text).toContain('report.pdf (6 B) is saved in the project at .claude-desk/attachments/20261121-090507-r0-report.pdf')
    // A name collision (same second and random part) fails instead of replacing the saved file.
    await expect(prepareAttachments(project, [list[0]!], { ...fixed, random: () => 'r0' })).rejects.toMatchObject({ code: 'EEXIST' })
  })

  it('refuses images that are not images or are too large', async () => {
    await expect(prepareAttachments(project, [{ kind: 'image', name: 'x.png', mediaType: 'image/png', data: b64('<svg/>') }])).rejects.toBeInstanceOf(
      AttachmentError
    )
    const huge = Buffer.concat([PNG, Buffer.alloc(IMAGE_MAX_BYTES)])
    await expect(prepareAttachments(project, [{ kind: 'image', name: 'x.png', mediaType: 'image/png', data: b64(huge) }])).rejects.toThrow(
      /too large/
    )
  })
})

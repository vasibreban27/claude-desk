import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  ATTACHMENTS_DIR,
  FILE_MAX_BYTES,
  IMAGE_MAX_BYTES,
  TEXT_INLINE_MAX_BYTES,
  type Attachment,
  type AttachmentRef,
  type ImageMediaType
} from '../../shared/attachments'

/** An image block for the SDK user message. */
export interface PromptImage {
  mediaType: ImageMediaType
  /** Base64. */
  data: string
}

export interface PreparedAttachments {
  images: PromptImage[]
  /** Text appended to the user's message: inlined text files and notes about saved files. */
  text: string
  refs: AttachmentRef[]
}

export class AttachmentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AttachmentError'
  }
}

export interface AttachmentDeps {
  writeFile?: (file: string, data: Buffer | string, flag: 'wx') => Promise<void>
  mkdir?: (dir: string) => Promise<void>
  now?: () => Date
  random?: () => string
}

/** The real image type from the file's first bytes; null when it is not PNG, JPEG, GIF or WebP. */
export function sniffImage(buf: Buffer): ImageMediaType | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'image/gif'
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

/** UTF-8 text without NUL bytes (a BOM is allowed). */
export function decodeText(buf: Buffer): string | null {
  if (buf.includes(0)) return null
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return text.startsWith('﻿') ? text.slice(1) : text
  } catch {
    return null
  }
}

/** A file name that is safe on every OS: letters, digits, `.`, `_`, `-`; never empty or dot-only. */
export function safeFileName(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/'))
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(-80)
  return cleaned === '' ? 'file' : cleaned
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

const defaultWrite = (file: string, data: Buffer | string, flag: 'wx'): Promise<void> => writeFile(file, data, { flag })
const defaultMkdir = async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true })
}

/**
 * Turns validated attachments into what the turn needs. Images are checked by their bytes (the declared type is not
 * trusted). Small UTF-8 files are put into the message; anything else is written under ATTACHMENTS_DIR in the project
 * (never overwriting) and the message names its path. Throws AttachmentError with a user-facing message.
 */
export async function prepareAttachments(
  projectPath: string,
  list: readonly Attachment[],
  deps: AttachmentDeps = {}
): Promise<PreparedAttachments> {
  const write = deps.writeFile ?? defaultWrite
  const makeDir = deps.mkdir ?? defaultMkdir
  const now = deps.now ?? (() => new Date())
  const random = deps.random ?? (() => randomBytes(3).toString('hex'))
  const images: PromptImage[] = []
  const parts: string[] = []
  const refs: AttachmentRef[] = []
  const dir = path.join(projectPath, ...ATTACHMENTS_DIR.split('/'))
  let dirReady = false

  for (const a of list) {
    const buf = Buffer.from(a.data, 'base64')
    if (a.kind === 'image') {
      if (buf.length > IMAGE_MAX_BYTES) throw new AttachmentError(`${a.name} is too large for an image.`)
      const type = sniffImage(buf)
      if (type === null) throw new AttachmentError(`${a.name} is not a PNG, JPEG, GIF or WebP image.`)
      images.push({ mediaType: type, data: buf.toString('base64') })
      refs.push({ kind: 'image', name: a.name })
      continue
    }
    if (buf.length > FILE_MAX_BYTES) throw new AttachmentError(`${a.name} is too large.`)
    const text = buf.length <= TEXT_INLINE_MAX_BYTES ? decodeText(buf) : null
    if (text !== null) {
      parts.push(`<attached-file name="${a.name.replace(/"/g, "'")}">\n${text}\n</attached-file>`)
      refs.push({ kind: 'file', name: a.name })
      continue
    }
    if (!dirReady) {
      await makeDir(dir)
      // Keeps the whole .claude-desk folder out of git without touching the project's own .gitignore.
      await write(path.join(path.dirname(dir), '.gitignore'), '*\n', 'wx').catch((e: unknown) => {
        if ((e as { code?: unknown }).code !== 'EEXIST') throw e
      })
      dirReady = true
    }
    const fileName = `${stamp(now())}-${random()}-${safeFileName(a.name)}`
    const target = path.join(dir, fileName)
    if (path.dirname(target) !== dir) throw new AttachmentError(`${a.name} has an unusable name.`)
    await write(target, buf, 'wx')
    const rel = `${ATTACHMENTS_DIR}/${fileName}`
    parts.push(`Attached file ${a.name} (${size(buf.length)}) is saved in the project at ${rel}. Read it if you need its contents.`)
    refs.push({ kind: 'file', name: a.name, path: rel })
  }
  return { images, text: parts.join('\n\n'), refs }
}

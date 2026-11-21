import { z } from 'zod'

/**
 * Chat attachments. Images go to Claude as image blocks; other files go into the message when they are small text,
 * otherwise they are saved in the project under ATTACHMENTS_DIR and the message names their path.
 */

export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number]

/** Raw bytes; stays under the API's 5 MB per image once base64-encoded. */
export const IMAGE_MAX_BYTES = 3_750_000
export const FILE_MAX_BYTES = 20 * 1024 * 1024
/** Text files up to this size are put into the message itself. */
export const TEXT_INLINE_MAX_BYTES = 30 * 1024
export const ATTACHMENTS_MAX = 10
export const ATTACHMENT_NAME_MAX = 120
/** Project-relative folder for saved files (its own .gitignore keeps it out of git). */
export const ATTACHMENTS_DIR = '.claude-desk/attachments'

/** Base64 length for `bytes` raw bytes. */
export const base64Length = (bytes: number): number => Math.ceil(bytes / 3) * 4

const base64 = (maxBytes: number) =>
  z
    .string()
    .min(1)
    .max(base64Length(maxBytes))
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'not base64')

const name = z.string().min(1).max(ATTACHMENT_NAME_MAX)

export const attachmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), name, mediaType: z.enum(IMAGE_MEDIA_TYPES), data: base64(IMAGE_MAX_BYTES) }).strict(),
  z.object({ kind: z.literal('file'), name, data: base64(FILE_MAX_BYTES) }).strict()
])
export type Attachment = z.infer<typeof attachmentSchema>

/** What the chat history keeps of an attachment (the bytes are not kept). */
export const attachmentRefSchema = z.object({
  kind: z.enum(['image', 'file']),
  name,
  /** Project-relative path when the file was saved in the project. */
  path: z.string().max(300).optional()
})
export type AttachmentRef = z.infer<typeof attachmentRefSchema>

/** PNG, JPEG, WebP and GIF are sent as images; any other file (other image formats included) as a file. */
export function isImageType(type: string): type is ImageMediaType {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(type)
}

/** Renderer-side check before sending; null when the file is accepted. */
export function attachmentProblem(file: { name: string; type: string; size: number }): string | null {
  if (isImageType(file.type) && file.size > IMAGE_MAX_BYTES) return `${file.name} is larger than ${mb(IMAGE_MAX_BYTES)}; images must be smaller.`
  if (file.size > FILE_MAX_BYTES) return `${file.name} is larger than ${mb(FILE_MAX_BYTES)}.`
  if (file.size === 0) return `${file.name} is empty.`
  return null
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

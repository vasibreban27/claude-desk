import { ATTACHMENTS_MAX, attachmentProblem, isImageType, type Attachment } from '@shared/ipc'

/** An attachment waiting in the message box. */
export interface DraftAttachment {
  id: string
  attachment: Attachment
  size: number
  /** data: URL for an image thumbnail. */
  preview: string | null
}

let counter = 0

function readDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('unreadable')))
    reader.onerror = () => reject(reader.error ?? new Error('unreadable'))
    reader.readAsDataURL(file)
  })
}

/** A pasted screenshot has no useful name; give it one with the right extension. */
function nameOf(file: File): string {
  if (file.name && file.name !== 'image.png') return file.name
  const ext = file.type === 'image/jpeg' ? 'jpg' : (file.type.split('/')[1] ?? 'png')
  return `pasted-image.${ext}`
}

/**
 * Reads files into attachments. Files over the limits, or beyond ATTACHMENTS_MAX in total, are left out and
 * reported in `problems`.
 */
export async function readAttachments(
  files: readonly File[],
  existing: number
): Promise<{ added: DraftAttachment[]; problems: string[] }> {
  const added: DraftAttachment[] = []
  const problems: string[] = []
  for (const file of files) {
    if (existing + added.length >= ATTACHMENTS_MAX) {
      problems.push(`Up to ${ATTACHMENTS_MAX} attachments per message.`)
      break
    }
    const name = nameOf(file)
    const problem = attachmentProblem({ name, type: file.type, size: file.size })
    if (problem !== null) {
      problems.push(problem)
      continue
    }
    let url: string
    try {
      url = await readDataUrl(file)
    } catch {
      problems.push(`Could not read ${name}.`)
      continue
    }
    const data = url.slice(url.indexOf(',') + 1)
    if (data === '') {
      problems.push(`${name} is empty.`)
      continue
    }
    const attachment: Attachment = isImageType(file.type)
      ? { kind: 'image', name, mediaType: file.type, data }
      : { kind: 'file', name, data }
    added.push({ id: `a${++counter}`, attachment, size: file.size, preview: attachment.kind === 'image' ? url : null })
  }
  return { added, problems }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

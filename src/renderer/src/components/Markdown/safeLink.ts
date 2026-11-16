const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/** Returns the URL when it is absolute with an allowed scheme, otherwise null. */
export function safeLink(href: string | undefined | null): string | null {
  if (!href) return null
  const trimmed = href.trim()
  try {
    const url = new URL(trimmed)
    return ALLOWED_PROTOCOLS.has(url.protocol) ? trimmed : null
  } catch {
    return null
  }
}

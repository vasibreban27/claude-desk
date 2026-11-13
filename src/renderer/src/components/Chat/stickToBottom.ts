export const STICK_THRESHOLD_PX = 48

export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** True when the list is within `threshold` px of its bottom edge. */
export function isNearBottom(m: ScrollMetrics, threshold: number = STICK_THRESHOLD_PX): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= threshold
}

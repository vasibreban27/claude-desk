import { describe, expect, it } from 'vitest'
import { isNearBottom } from './stickToBottom'

describe('isNearBottom', () => {
  it('is true at the bottom and within the threshold', () => {
    expect(isNearBottom({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })).toBe(true)
    expect(isNearBottom({ scrollTop: 552, scrollHeight: 1000, clientHeight: 400 })).toBe(true)
  })
  it('is false when scrolled further up', () => {
    expect(isNearBottom({ scrollTop: 551, scrollHeight: 1000, clientHeight: 400 })).toBe(false)
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 })).toBe(false)
  })
  it('is true when content does not overflow', () => {
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 })).toBe(true)
  })
  it('honours a custom threshold', () => {
    expect(isNearBottom({ scrollTop: 590, scrollHeight: 1000, clientHeight: 400 }, 5)).toBe(false)
  })
})

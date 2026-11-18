import { describe, expect, it } from 'vitest'
import { findingSchema, isBlocking, type Finding } from './review'

const valid: Finding = {
  reviewer: 'reviewer',
  severity: 'major',
  file: 'src/a.ts',
  line: 3,
  text: 'bad'
}

describe('findingSchema', () => {
  it('accepts a valid finding and a null line', () => {
    expect(findingSchema.safeParse(valid).success).toBe(true)
    expect(findingSchema.safeParse({ ...valid, line: null }).success).toBe(true)
  })

  it.each([
    ['unknown severity', { severity: 'critical' }],
    ['text over 500', { text: 'x'.repeat(501) }],
    ['file over 200', { file: 'x'.repeat(201) }],
    ['non-integer line', { line: 1.5 }],
    ['unknown reviewer', { reviewer: 'other' }]
  ])('rejects %s', (_name, patch) => {
    expect(findingSchema.safeParse({ ...valid, ...patch }).success).toBe(false)
  })

  it('accepts the boundary lengths', () => {
    const r = findingSchema.safeParse({ ...valid, text: 'x'.repeat(500), file: 'x'.repeat(200) })
    expect(r.success).toBe(true)
  })
})

describe('isBlocking', () => {
  it.each([
    ['blocker', true],
    ['major', true],
    ['minor', false],
    ['nit', false]
  ] as const)('%s -> %s', (severity, expected) => {
    expect(isBlocking({ severity })).toBe(expected)
  })
})

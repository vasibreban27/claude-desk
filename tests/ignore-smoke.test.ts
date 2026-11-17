import ignore from 'ignore'
import { describe, expect, it } from 'vitest'

describe('ignore package', () => {
  it('matches env files but not the example, case-sensitively', () => {
    const ig = ignore({ ignorecase: false }).add(['.env', '.env.*', '!.env.example'])
    expect(ig.ignores('.env.local')).toBe(true)
    expect(ig.ignores('.env.example')).toBe(false)
    expect(ig.ignores('.ENV')).toBe(false)
  })

  it('matches with default options', () => {
    const ig = ignore().add(['.env', '.env.*', '!.env.example'])
    expect(ig.ignores('.env.local')).toBe(true)
    expect(ig.ignores('.env.example')).toBe(false)
  })
})

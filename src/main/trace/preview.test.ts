import { describe, expect, it } from 'vitest'
import { diffFor, formatInput, inputPreview, oneLine, previewText, redact, relativize, resultText, summarizeInput } from './preview'

describe('redact', () => {
  it('hides known secret values', () => {
    expect(redact('token is abcdef123456 here', ['abcdef123456'])).toBe('token is *** here')
  })

  it('ignores very short secret values', () => {
    expect(redact('a b c', ['b'])).toBe('a b c')
  })

  it('hides authorization headers, bearer tokens and key shapes', () => {
    expect(redact('Authorization: Bearer abc.def.ghi123')).toBe('Authorization: ***')
    expect(redact('curl -H "bearer abcdefghijklmnop"')).toContain('bearer ***')
    expect(redact('key sk-ant-api03-abcdefghijklmnop')).toBe('key ***')
    expect(redact('ghp_abcdefghijklmnopqrstuvwxyz0123')).toBe('***')
    expect(redact('lin_api_abcdefghijklmnop')).toBe('***')
  })

  it('hides values of secret-named keys', () => {
    expect(redact('DB_PASSWORD=hunter22 next')).toBe('DB_PASSWORD=*** next')
    expect(redact('{"api_key": "abc12345"}')).toBe('{"api_key": "***"}')
    expect(redact('client_secret: xyz9876')).toBe('client_secret: ***')
  })

  it('leaves ordinary text alone', () => {
    expect(redact('npm test passed in 3s')).toBe('npm test passed in 3s')
  })
})

describe('previewText', () => {
  it('keeps the first and last lines and says how many were hidden', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
    const out = previewText(text, { head: 3, tail: 2 })
    expect(out.split('\n')).toEqual(['line 0', 'line 1', 'line 2', '… 95 lines hidden …', 'line 98', 'line 99'])
  })

  it('caps the length', () => {
    const out = previewText('x'.repeat(5000), { max: 100 })
    expect(out.startsWith('x'.repeat(100))).toBe(true)
    expect(out).toContain('4900 characters hidden')
  })

  it('normalises line endings and trailing space', () => {
    expect(previewText('a\r\nb  \n\n')).toBe('a\nb')
  })
})

describe('summaries and inputs', () => {
  it('summarizes like the CLI', () => {
    expect(summarizeInput('Read', { file_path: 'src/a.ts' })).toBe('src/a.ts')
    expect(summarizeInput('Bash', { command: 'npm test' })).toBe('npm test')
    expect(summarizeInput('Grep', { pattern: 'foo', path: 'src' })).toBe('foo in src')
    expect(summarizeInput('Agent', { subagent_type: 'flow:reviewer', description: 'check it', prompt: 'long' })).toBe(
      'flow:reviewer: check it'
    )
    expect(summarizeInput('mcp__x__thing', { other: 'value' })).toBe('value')
    expect(summarizeInput('Read', null)).toBe('')
  })

  it('formats shell commands with their args and skips edit bodies', () => {
    expect(formatInput('mcp__work__run_command', { command: 'mvn', args: ['-q', 'test'] })).toBe('mvn -q test')
    expect(formatInput('Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' })).toBe('file_path: a.ts')
  })

  it('relativizes, redacts and caps inputs', () => {
    const out = inputPreview('Read', { file_path: '/work/proj/src/a.ts', token: 'secretvalue1' }, '/work/proj', [])
    expect(out).toContain('file_path: src/a.ts')
    expect(out).toContain('token: ***')
  })

  it('cuts one-liners', () => {
    expect(oneLine('a\n  b', 10)).toBe('a b')
    expect(oneLine('abcdefghijkl', 5)).toBe('abcd…')
  })

  it('relativizes paths in either slash style', () => {
    expect(relativize('C:\\work\\proj\\src\\a.ts', 'C:\\work\\proj')).toBe('src\\a.ts')
    expect(relativize('see C:/work/proj/src', 'C:\\work\\proj')).toBe('see src')
    expect(relativize('/x/y', null)).toBe('/x/y')
  })
})

describe('diffFor', () => {
  it('counts lines of an Edit', () => {
    expect(diffFor('Edit', { file_path: 'a', old_string: 'a\nb', new_string: 'a\nc\nd' })).toEqual({
      diff: '- a\n- b\n+ a\n+ c\n+ d',
      added: 3,
      removed: 2
    })
  })

  it('handles MultiEdit and Write', () => {
    expect(diffFor('MultiEdit', { edits: [{ old_string: 'x', new_string: 'y' }, { old_string: 'p', new_string: '' }] })).toEqual({
      diff: '- x\n+ y\n…\n- p',
      added: 1,
      removed: 2
    })
    expect(diffFor('Write', { content: 'one\ntwo\n' })).toEqual({ diff: '+ one\n+ two', added: 2, removed: 0 })
  })

  it('is null for other tools and bad input', () => {
    expect(diffFor('Read', { file_path: 'a' })).toBeNull()
    expect(diffFor('Edit', { old_string: 1 })).toBeNull()
  })
})

describe('resultText', () => {
  it('reads strings and text blocks, naming images', () => {
    expect(resultText('ok')).toBe('ok')
    expect(resultText([{ type: 'text', text: 'a' }, { type: 'image' }, 5])).toBe('a\n[image]')
    expect(resultText(null)).toBe('')
  })
})

import { describe, expect, it } from 'vitest'
import { FALLBACK_NAME, numbered, projectNameFrom } from './projectName'

describe('projectNameFrom', () => {
  it.each([
    ['I want a todo API in FastAPI', 'todo-api-fastapi'],
    ['Build me a Rust CLI that renames photos by date', 'rust-cli-renames'],
    ['  Café   menu, please!  ', 'cafe-menu'],
    ['create a new app', FALLBACK_NAME],
    ['', FALLBACK_NAME],
    ['x', FALLBACK_NAME]
  ])('%j -> %s', (text, name) => {
    expect(projectNameFrom(text)).toBe(name)
  })

  it('keeps names short and valid', () => {
    const name = projectNameFrom('supercalifragilisticexpialidocious extraordinarily-long-words everywhere')
    expect(name.length).toBeLessThanOrEqual(40)
    expect(name).toMatch(/^[a-z0-9][a-z0-9-]{1,48}$/)
  })
})

describe('numbered', () => {
  it('adds a suffix from the second attempt', () => {
    expect(numbered('todo', 1)).toBe('todo')
    expect(numbered('todo', 3)).toBe('todo-3')
  })
})

import { describe, expect, it } from 'vitest'
import { isArtifact, uncommittedWork } from './uncommitted'

describe('uncommittedWork', () => {
  it('ignores generated files such as Python bytecode caches (the todo-fastapi T2 case)', () => {
    const z = [
      '?? app/__pycache__/__init__.cpython-312.pyc',
      '?? app/__pycache__/db.cpython-312.pyc',
      '?? tests/__pycache__/test_db.cpython-312-pytest-9.2.0.pyc',
      '?? .pytest_cache/v/cache/nodeids',
      '?? todo.db',
      ''
    ].join('\0')
    expect(uncommittedWork(z)).toEqual([])
  })

  it('reports modified and untracked source files', () => {
    const z = [' M app/db.py', '?? app/routes.py', 'A  tests/test_x.py', ''].join('\0')
    expect(uncommittedWork(z)).toEqual(['app/db.py', 'app/routes.py', 'tests/test_x.py'])
  })

  it('skips the source path entry of a rename', () => {
    const z = ['R  app/new.py', 'app/old.py', '?? x.py', ''].join('\0')
    expect(uncommittedWork(z)).toEqual(['app/new.py', 'x.py'])
  })

  it('returns nothing for a clean tree', () => {
    expect(uncommittedWork('')).toEqual([])
  })
})

describe('isArtifact', () => {
  it.each([
    ['node_modules/x/index.js', true],
    ['.venv/Lib/site.py', true],
    ['dist/app.js', true],
    ['pkg.egg-info', true],
    ['src/build.ts', false],
    ['README.md', false],
    ['app/models.py', false]
  ])('%s -> %s', (p, expected) => expect(isArtifact(p)).toBe(expected))
})

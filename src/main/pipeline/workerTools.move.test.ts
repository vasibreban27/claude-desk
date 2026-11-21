import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_PROTECTED_PATHS } from '../../shared/settings'
import { checkWritablePath } from './workerGuard'
import { createWorkerTools, WORK_ALLOWED_TOOLS } from './workerTools'

let wt: string
const OWNS = ['src/main/java/app/', 'src/test/java/app/', 'docs/notes.md']

function write(rel: string, text = 'x'): void {
  const f = path.join(wt, ...rel.split('/'))
  mkdirSync(path.dirname(f), { recursive: true })
  writeFileSync(f, text)
}
const has = (rel: string): boolean => existsSync(path.join(wt, ...rel.split('/')))

function tools(withCheck = true) {
  return createWorkerTools({
    taskId: 'T1',
    worktree: wt,
    branch: 'task/x-t1',
    owns: OWNS,
    checks: [],
    onBlocked: () => undefined,
    ...(withCheck
      ? { checkPath: (tool: string, rel: string) => checkWritablePath(tool, rel, { worktree: wt, owns: OWNS, protectedPatterns: DEFAULT_PROTECTED_PATHS }) }
      : {})
  }).handlers
}
const text = (r: { content: { text: string }[] }): string => r.content[0]?.text ?? ''

beforeEach(() => {
  wt = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'move-')))
})
afterEach(() => rmSync(wt, { recursive: true, force: true }))

describe('move_files', () => {
  it('moves files into new folders and removes the emptied ones', async () => {
    write('src/main/java/app/api/ProjectController.java', 'class A {}')
    write('src/main/java/app/api/dto/ProjectResponse.java', 'record B() {}')
    const r = await tools().move_files({
      moves: [
        { from: 'src/main/java/app/api/ProjectController.java', to: 'src/main/java/app/controller/ProjectController.java' },
        { from: 'src/main/java/app/api/dto/ProjectResponse.java', to: 'src/main/java/app/dto/ProjectResponse.java' }
      ]
    })
    expect(r.isError).toBeUndefined()
    expect(text(r)).toMatch(/^moved 2 files\./)
    expect(readFileSync(path.join(wt, 'src/main/java/app/controller/ProjectController.java'), 'utf8')).toBe('class A {}')
    expect(has('src/main/java/app/dto/ProjectResponse.java')).toBe(true)
    expect(has('src/main/java/app/api')).toBe(false)
    expect(has('src/main/java/app')).toBe(true)
  })

  it('moves nothing when one move is not allowed', async () => {
    write('src/main/java/app/A.java')
    write('src/main/java/app/B.java')
    write('src/main/java/app/C.java')
    for (const [moves, why] of [
      [[{ from: 'src/main/java/app/A.java', to: 'src/main/java/other/A.java' }], /Owns/],
      [[{ from: 'src/main/java/app/A.java', to: '../x/A.java' }], /\.\./],
      [[{ from: 'src/main/java/app/A.java', to: 'src/main/java/app/B.java' }], /already exists/],
      [[{ from: 'src/main/java/app/Nope.java', to: 'src/main/java/app/N.java' }], /does not exist/],
      [
        [
          { from: 'src/main/java/app/A.java', to: 'src/main/java/app/x/A.java' },
          { from: 'src/main/java/app/C.java', to: 'src/main/java/app/x/A.java' }
        ],
        /two moves/
      ],
      [[{ from: 'src/main/java/app/A.java', to: 'src/main/java/app/.env' }], /protected/]
    ] as const) {
      const r = await tools().move_files({ moves })
      expect(r.isError, JSON.stringify(moves)).toBe(true)
      expect(text(r)).toMatch(/^nothing was moved/)
      expect(text(r)).toMatch(why)
    }
    expect(has('src/main/java/app/A.java')).toBe(true)
    expect(has('src/main/java/app/x')).toBe(false)
  })

  it('refuses everything without the guard check and on bad input', async () => {
    write('src/main/java/app/A.java')
    expect(text(await tools(false).move_files({ moves: [{ from: 'src/main/java/app/A.java', to: 'src/main/java/app/B.java' }] }))).toMatch(
      /not available/
    )
    expect((await tools().move_files({ moves: [] })).isError).toBe(true)
    expect((await tools().move_files('x')).isError).toBe(true)
  })
})

describe('delete_files', () => {
  it('deletes files inside Owns and removes emptied folders', async () => {
    write('src/test/java/app/project/OldTest.java')
    write('docs/notes.md')
    const r = await tools().delete_files({ paths: ['src/test/java/app/project/OldTest.java', 'docs/notes.md'] })
    expect(text(r)).toMatch(/^deleted 2 files/)
    expect(has('src/test/java/app/project')).toBe(false)
    expect(has('docs')).toBe(false)
  })

  it('deletes nothing when one path is not allowed', async () => {
    write('src/test/java/app/A.java')
    write('pom.xml')
    const r = await tools().delete_files({ paths: ['src/test/java/app/A.java', 'pom.xml'] })
    expect(text(r)).toMatch(/^nothing was deleted: .*Owns/)
    expect(has('src/test/java/app/A.java')).toBe(true)
    mkdirSync(path.join(wt, 'src/test/java/app/dir'), { recursive: true })
    expect(text(await tools().delete_files({ paths: ['src/test/java/app/dir'] }))).toMatch(/nothing was deleted/)
  })
})

describe('work tool list', () => {
  it('offers the new tools to workers', () => {
    expect(WORK_ALLOWED_TOOLS).toEqual(expect.arrayContaining(['mcp__work__move_files', 'mcp__work__delete_files']))
  })
})

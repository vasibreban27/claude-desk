import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (f: string): string => readFileSync(resolve(process.cwd(), f), 'utf8')
const pkg = JSON.parse(read('package.json')) as {
  scripts: Record<string, string>
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}

describe('scaffold acceptance (gap coverage)', () => {
  it('.env.example has the toolkit placeholder and no real path or secret', () => {
    const env = read('.env.example')
    expect(env).toContain('CLAUDE_TOOLKIT_PATH=<absolute path to your claude-toolkit clone>')
    expect(env).not.toMatch(/sk-ant|[A-Za-z]:\\|\/Users\/|\/home\//)
  })

  it('.gitignore ignores node_modules, out, dist and .env', () => {
    const lines = read('.gitignore')
      .split(/\r?\n/)
      .map((l) => l.trim())
    for (const entry of ['node_modules', 'out', 'dist', '.env']) {
      expect(lines.some((l) => l === entry || l === entry + '/')).toBe(true)
    }
  })

  it('package.json has the required dependencies', () => {
    for (const d of ['zod', '@anthropic-ai/claude-agent-sdk', 'react', 'react-dom']) {
      expect(pkg.dependencies[d]).toBeDefined()
    }
    for (const d of ['electron', 'vitest', '@testing-library/react']) {
      expect(pkg.devDependencies[d]).toBeDefined()
    }
  })

  it('package.json has the documented scripts', () => {
    for (const s of ['dev', 'build', 'typecheck', 'lint', 'test']) {
      expect(pkg.scripts[s]).toBeDefined()
    }
    expect(pkg.scripts['dev']).toBe('electron-vite dev')
  })

  it('CLAUDE.md documents each command', () => {
    const md = read('CLAUDE.md')
    for (const c of ['npm install', 'npm run dev', 'npm run build', 'npm run typecheck', 'npm run lint', 'npm test']) {
      expect(md).toContain(c)
    }
  })

  it('F1: main entry and build config share the preload file name constant', () => {
    expect(read('src/main/index.ts')).toContain('PRELOAD_FILE_NAME')
    expect(read('electron.vite.config.ts')).toContain('PRELOAD_FILE_NAME')
  })

  it('shared non-test modules import no node or electron APIs', () => {
    for (const f of ['src/shared/ipc.ts', 'src/shared/build-output.ts']) {
      expect(read(f)).not.toMatch(/from ['"](node:|electron|fs|path)/)
    }
  })
})

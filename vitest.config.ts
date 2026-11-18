import { resolve } from 'node:path'
import { configDefaults, defineConfig } from 'vitest/config'
import { SLOW_TESTS } from './vitest.slow'

const slow = process.env.VITEST_SLOW === '1'

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: {
    environment: 'node',
    setupFiles: ['src/renderer/src/test/setup.ts'],
    include: slow ? SLOW_TESTS : ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    exclude: slow ? configDefaults.exclude : [...configDefaults.exclude, ...SLOW_TESTS],
    testTimeout: slow ? 60000 : 15000
  }
})

import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: {
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    setupFiles: ['src/renderer/src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}']
  }
})

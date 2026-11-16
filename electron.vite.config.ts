import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { PRELOAD_FILE_NAME } from './src/shared/build-output'

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  preload: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      // A sandboxed preload can only require('electron'): bundle zod and other deps instead of externalizing them.
      externalizeDeps: false,
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: PRELOAD_FILE_NAME }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: { alias: { '@shared': resolve('src/shared') } },
    plugins: [react()]
  }
})

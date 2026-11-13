/// <reference types="vite/client" />
import type { DeskApi } from '@shared/ipc'

declare global {
  interface Window {
    api: DeskApi
  }
}

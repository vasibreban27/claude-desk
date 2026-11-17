import { join } from 'node:path'
import { PRELOAD_FILE_NAME } from '../shared/build-output'
import { app, BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'
import { openDatabase, createRunStore, createSettingsStore, type RunStore } from './db'
import type Database from 'better-sqlite3'
import { registerIpc } from './ipc/register'
import { openJsonProjectStore } from './projects/store'
import { loadEnvFile } from './config'

const DB_FILE_NAME = 'claude-desk.db'

/** Development only: a packaged app has no project `.env`. Real environment variables win over the file. */
export function loadDevEnv(isPackaged: boolean, appPath: string): void {
  if (isPackaged) return
  if (loadEnvFile(appPath) === 'failed') console.error('reading .env failed')
}

export function getWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  }
}

function createWindow(): void {
  const win = new BrowserWindow(getWindowOptions(join(import.meta.dirname, '../preload', PRELOAD_FILE_NAME)))
  win.once('ready-to-show', () => win.show())

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const load = devUrl
    ? win.loadURL(devUrl)
    : win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  load.catch((err: unknown) => {
    console.error('Failed to load renderer', err)
  })
}

let disposeIpc: (() => void) | undefined
let database: Database.Database | undefined

/** Opens the usage database; on failure logs the error name only and returns undefined so the app still runs. */
export function openRunStore(dataDir: string): { db: Database.Database; store: RunStore } | undefined {
  try {
    const db = openDatabase(join(dataDir, DB_FILE_NAME))
    return { db, store: createRunStore(db) }
  } catch (err) {
    console.error(`opening ${DB_FILE_NAME} failed:`, err instanceof Error ? err.name : 'unknown')
    return undefined
  }
}

loadDevEnv(app.isPackaged, app.getAppPath())

app
  .whenReady()
  .then(async () => {
    const dataDir = join(app.getPath('userData'), 'data')
    const store = await openJsonProjectStore(dataDir)
    const opened = openRunStore(dataDir)
    database = opened?.db
    disposeIpc = registerIpc(store, opened?.store, createSettingsStore(opened?.db ?? null))
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
  .catch((err: unknown) => {
    console.error('App failed to start', err)
    app.quit()
  })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  disposeIpc?.()
  try {
    database?.close()
  } catch (err) {
    console.error('closing database failed:', err instanceof Error ? err.name : 'unknown')
  }
  database = undefined
})

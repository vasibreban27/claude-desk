import { join } from 'node:path'
import { PRELOAD_FILE_NAME } from '../shared/build-output'
import { app, BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'

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

app
  .whenReady()
  .then(() => {
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

import { useCallback, useLayoutEffect, useState } from 'react'

export type ThemeMode = 'system' | 'light' | 'dark'

export const THEME_STORAGE_KEY = 'claude-desk:theme'

const MODES: readonly ThemeMode[] = ['system', 'light', 'dark']

function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value)
}

function readStoredMode(): ThemeMode {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY)
    return isThemeMode(value) ? value : 'system'
  } catch {
    return 'system'
  }
}

function persistMode(mode: ThemeMode): void {
  try {
    if (mode === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY)
    else window.localStorage.setItem(THEME_STORAGE_KEY, mode)
  } catch {
    // storage unavailable: the choice still applies for this session
  }
}

function applyMode(mode: ThemeMode): void {
  const root = document.documentElement
  if (mode === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', mode)
}

export function useTheme(): { mode: ThemeMode; setMode: (mode: ThemeMode) => void } {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode)

  // Layout effect so the attribute is set before first paint.
  useLayoutEffect(() => {
    applyMode(mode)
  }, [mode])

  const setMode = useCallback((next: ThemeMode) => {
    if (!isThemeMode(next)) return
    persistMode(next)
    setModeState(next)
  }, [])

  return { mode, setMode }
}

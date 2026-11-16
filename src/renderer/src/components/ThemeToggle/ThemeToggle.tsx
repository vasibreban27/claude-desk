import { useTheme, type ThemeMode } from '../../hooks/useTheme'
import './theme-toggle.css'

const OPTIONS: ReadonlyArray<{ value: ThemeMode; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
]

export function ThemeToggle(): React.JSX.Element {
  const { mode, setMode } = useTheme()
  return (
    <fieldset className="theme-toggle">
      <legend className="theme-toggle__legend">Theme</legend>
      {OPTIONS.map((option) => (
        <label key={option.value} className="theme-toggle__option">
          <input
            className="theme-toggle__input"
            type="radio"
            name="theme"
            value={option.value}
            checked={mode === option.value}
            onChange={() => setMode(option.value)}
          />
          <span className="theme-toggle__label">{option.label}</span>
        </label>
      ))}
    </fieldset>
  )
}

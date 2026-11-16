import { useTheme, type ThemeMode } from '../../hooks/useTheme'
import './theme-toggle.css'

function Icon({ mode }: { mode: ThemeMode }): React.JSX.Element {
  const common = {
    className: 'theme-toggle__icon',
    width: 16,
    height: 16,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false
  }
  if (mode === 'light') {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="2.75" />
        <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.05 1.05M11.55 11.55l1.05 1.05M3.4 12.6l1.05-1.05M11.55 4.45l1.05-1.05" />
      </svg>
    )
  }
  if (mode === 'dark') {
    return (
      <svg {...common}>
        <path d="M13.5 9.6A5.75 5.75 0 0 1 6.4 2.5a5.75 5.75 0 1 0 7.1 7.1Z" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <rect x="1.75" y="2.5" width="12.5" height="8.5" rx="1.25" />
      <path d="M5.5 13.5h5M8 11v2.5" />
    </svg>
  )
}

const OPTIONS: ReadonlyArray<{ value: ThemeMode; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
]

/**
 * The outer div is the size container: the options switch between stacked rows (narrow sidebar)
 * and three columns (enough room) by container width, not by window width.
 * The options live in their own grid so the legend is a plain caption, never a flex item.
 */
export function ThemeToggle(): React.JSX.Element {
  const { mode, setMode } = useTheme()
  return (
    <div className="theme-toggle">
      <fieldset className="theme-toggle__fieldset">
        <legend className="theme-toggle__legend">Theme</legend>
        <div className="theme-toggle__options">
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
              <span className={`theme-toggle__label theme-toggle__label--${option.value}`}>
                <Icon mode={option.value} />
                <span className="theme-toggle__text">{option.label}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  )
}

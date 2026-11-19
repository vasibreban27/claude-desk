import { useCallback, useEffect, useId, useState, type FormEvent } from 'react'
import {
  MCP_KEY_PATTERN,
  MCP_NAME_PATTERN,
  RESERVED_MCP_NAMES,
  type McpConnection,
  type McpSaveError,
  type McpSaveRequest,
  type McpStatus,
  type McpTransport
} from '@shared/ipc'
import './mcp.css'

const SAVE_ERRORS: Record<McpSaveError, string> = {
  invalid: 'The connection is not valid.',
  'duplicate-name': 'Another connection already uses this name.',
  'not-found': 'The connection no longer exists.',
  'secrets-unavailable': 'Secret values cannot be stored: the OS keychain is not available.',
  'too-many': 'You have reached the maximum number of connections (20).',
  'storage-error': 'The connection could not be saved.'
}

const STATUS_TEXT: Record<McpStatus, string> = {
  connected: 'Connected',
  failed: 'Could not connect',
  'needs-auth': 'Needs a sign-in or token',
  pending: 'Did not connect in time',
  disabled: 'Disabled'
}

interface SecretRow {
  key: string
  /** New value; '' keeps the saved one. */
  value: string
  /** True when a value is saved for this key. */
  saved: boolean
  remove: boolean
}

interface Draft {
  id: string | null
  name: string
  transport: McpTransport
  command: string
  args: string
  url: string
  enabled: boolean
  secrets: SecretRow[]
  allowedTools: string[]
}

export interface Preset {
  id: string
  label: string
  hint: string
  draft: Omit<Draft, 'id' | 'allowedTools'>
}

export const PRESETS: Preset[] = [
  {
    id: 'linear',
    label: 'Linear',
    hint:
      'Linear’s hosted MCP server. Create a personal API key in Linear (Settings → Security & access) and enter "Bearer <your key>" as the Authorization value. If Linear rejects the key, the server needs a browser sign-in, which comes in a later version.',
    draft: {
      name: 'linear',
      transport: 'http',
      command: '',
      args: '',
      url: 'https://mcp.linear.app/mcp',
      enabled: true,
      secrets: [{ key: 'Authorization', value: '', saved: false, remove: false }]
    }
  },
  {
    id: 'remote',
    label: 'Remote server (URL)',
    hint: 'A server reached over HTTPS. Put tokens in headers (e.g. Authorization: Bearer ...). Servers that only offer a browser sign-in are not supported yet.',
    draft: { name: '', transport: 'http', command: '', args: '', url: 'https://', enabled: true, secrets: [] }
  },
  {
    id: 'local',
    label: 'Local command',
    hint: 'A server the app starts on this computer, e.g. command "npx" with arguments "-y" and the package name. Put API keys in environment variables.',
    draft: { name: '', transport: 'stdio', command: 'npx', args: '', url: '', enabled: true, secrets: [] }
  }
]

function draftFrom(c: McpConnection): Draft {
  return {
    id: c.id,
    name: c.name,
    transport: c.transport,
    command: c.command ?? '',
    args: c.args.join('\n'),
    url: c.url ?? '',
    enabled: c.enabled,
    secrets: c.secretKeys.map((key) => ({ key, value: '', saved: true, remove: false })),
    allowedTools: [...c.allowedTools]
  }
}

function nameProblem(name: string): string | null {
  if (!MCP_NAME_PATTERN.test(name)) return 'Use 2-30 characters: a lowercase letter first, then lowercase letters, digits or _.'
  if (RESERVED_MCP_NAMES.includes(name)) return 'This name is used by the app itself.'
  return null
}

function toRequest(d: Draft): McpSaveRequest {
  const secrets: Record<string, string | null> = {}
  for (const s of d.secrets) {
    const key = s.key.trim()
    if (key === '') continue
    if (s.remove) secrets[key] = null
    else if (s.value !== '') secrets[key] = s.value
  }
  return {
    id: d.id,
    name: d.name.trim(),
    transport: d.transport,
    command: d.transport === 'stdio' ? d.command.trim() || null : null,
    args: d.transport === 'stdio' ? d.args.split(/\r?\n/).map((a) => a.trim()).filter((a) => a !== '') : [],
    url: d.transport === 'stdio' ? null : d.url.trim() || null,
    enabled: d.enabled,
    allowedTools: d.allowedTools,
    secrets
  }
}

function ConnectionForm({
  initial,
  known,
  hint,
  onSaved,
  onCancel
}: {
  initial: Draft
  known: McpConnection | null
  hint: string | null
  onSaved: (c: McpConnection) => void
  onCancel: () => void
}) {
  const id = useId()
  const [d, setD] = useState<Draft>(initial)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const set = (patch: Partial<Draft>): void => setD((x) => ({ ...x, ...patch }))
  const isLocal = d.transport === 'stdio'
  const badKeys = d.secrets.some((s) => s.key.trim() !== '' && !MCP_KEY_PATTERN.test(s.key.trim()))
  const problem = nameProblem(d.name.trim())

  async function submit(ev: FormEvent) {
    ev.preventDefault()
    if (problem || badKeys || saving) return
    setSaving(true)
    setError(null)
    try {
      const r = await window.api.mcpSave(toRequest(d))
      if (r.ok) onSaved(r.connection)
      else setError(r.message ? `${SAVE_ERRORS[r.error]} ${r.message}` : SAVE_ERRORS[r.error])
    } catch {
      setError(SAVE_ERRORS['storage-error'])
    } finally {
      setSaving(false)
    }
  }

  const tools = known?.knownTools ?? []
  const toggleTool = (name: string, on: boolean): void =>
    set({ allowedTools: on ? [...new Set([...d.allowedTools, name])] : d.allowedTools.filter((t) => t !== name) })

  return (
    <form className="mcp__form" onSubmit={submit} aria-label={d.id ? `Edit ${d.name}` : 'New connection'}>
      {hint && <p className="settings__hint">{hint}</p>}
      <div className="settings__field">
        <label htmlFor={`${id}-name`}>Name</label>
        <input id={`${id}-name`} type="text" value={d.name} onChange={(e) => set({ name: e.target.value })} spellCheck={false} />
        <p className="settings__hint">{d.name.trim() !== '' && problem ? problem : 'Agents see its tools as mcp__name__tool.'}</p>
      </div>
      <div className="settings__field">
        <label htmlFor={`${id}-type`}>Type</label>
        <select id={`${id}-type`} value={d.transport} onChange={(e) => set({ transport: e.target.value as McpTransport })}>
          <option value="http">Remote (HTTP)</option>
          <option value="sse">Remote (SSE, older servers)</option>
          <option value="stdio">Local command</option>
        </select>
      </div>
      {isLocal ? (
        <>
          <div className="settings__field">
            <label htmlFor={`${id}-command`}>Command</label>
            <input id={`${id}-command`} type="text" value={d.command} onChange={(e) => set({ command: e.target.value })} spellCheck={false} />
          </div>
          <div className="settings__field">
            <label htmlFor={`${id}-args`}>Arguments (one per line)</label>
            <textarea id={`${id}-args`} value={d.args} onChange={(e) => set({ args: e.target.value })} spellCheck={false} />
          </div>
        </>
      ) : (
        <div className="settings__field">
          <label htmlFor={`${id}-url`}>URL</label>
          <input id={`${id}-url`} type="text" value={d.url} onChange={(e) => set({ url: e.target.value })} spellCheck={false} />
        </div>
      )}
      <fieldset className="mcp__secrets">
        <legend>{isLocal ? 'Environment variables (secret)' : 'Headers (secret)'}</legend>
        <p className="settings__hint">Values are encrypted with your OS keychain and never shown again. Leave a value empty to keep the saved one.</p>
        {d.secrets.map((s, i) => (
          <div key={i} className="mcp__secret">
            <input
              type="text"
              aria-label={`${isLocal ? 'Variable' : 'Header'} ${i + 1} name`}
              value={s.key}
              disabled={s.saved}
              onChange={(e) => set({ secrets: d.secrets.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })}
              spellCheck={false}
            />
            <input
              type="password"
              aria-label={`${s.key || `${isLocal ? 'Variable' : 'Header'} ${i + 1}`} value`}
              value={s.value}
              placeholder={s.saved ? 'saved, enter to replace' : 'value'}
              disabled={s.remove}
              autoComplete="off"
              onChange={(e) => set({ secrets: d.secrets.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })}
            />
            <button
              type="button"
              onClick={() =>
                set({ secrets: s.saved ? d.secrets.map((x, j) => (j === i ? { ...x, remove: !x.remove, value: '' } : x)) : d.secrets.filter((_, j) => j !== i) })
              }
            >
              {s.saved ? (s.remove ? 'Keep' : 'Remove') : 'Remove'}
            </button>
          </div>
        ))}
        {badKeys && <p role="alert" className="settings__hint">Names may contain letters, digits, _ and -.</p>}
        <button type="button" onClick={() => set({ secrets: [...d.secrets, { key: '', value: '', saved: false, remove: false }] })}>
          Add {isLocal ? 'variable' : 'header'}
        </button>
      </fieldset>
      <label className="settings__toggle">
        <input type="checkbox" checked={d.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        Enabled in Chat and Plan
      </label>
      {d.id !== null && (
        <fieldset className="mcp__tools">
          <legend>Tools agents may use</legend>
          {tools.length === 0 ? (
            <p className="settings__hint">Save, then use Test connection to list this server’s tools.</p>
          ) : (
            <>
              <div className="mcp__tool-actions">
                <button type="button" onClick={() => set({ allowedTools: tools.filter((t) => t.readOnly === true).map((t) => t.name) })}>
                  Only read-only
                </button>
                <button type="button" onClick={() => set({ allowedTools: tools.map((t) => t.name) })}>
                  All
                </button>
                <button type="button" onClick={() => set({ allowedTools: [] })}>
                  None
                </button>
              </div>
              <ul className="mcp__tool-list">
                {tools.map((t) => (
                  <li key={t.name}>
                    <label className="settings__toggle">
                      <input type="checkbox" checked={d.allowedTools.includes(t.name)} onChange={(e) => toggleTool(t.name, e.target.checked)} />
                      <code>{t.name}</code>
                      {t.readOnly === true && <span className="mcp__badge">read-only</span>}
                      {t.readOnly === false && <span className="mcp__badge mcp__badge--write">can change data</span>}
                    </label>
                    {t.description && <p className="settings__hint">{t.description}</p>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </fieldset>
      )}
      {error && (
        <p role="alert" className="settings__message">
          {error}
        </p>
      )}
      <div className="mcp__actions">
        <button type="submit" className="settings__save" disabled={saving || problem !== null || badKeys}>
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  )
}

type Editing = { kind: 'new'; preset: Preset } | { kind: 'edit'; id: string } | null

/** App-wide MCP connections for Chat and Plan (not the pipeline). */
export function McpConnections() {
  const [connections, setConnections] = useState<McpConnection[] | null>(null)
  const [secretsAvailable, setSecretsAvailable] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing>(null)
  const [tests, setTests] = useState<Record<string, { busy: boolean; text: string | null; ok: boolean }>>({})
  const [presetOpen, setPresetOpen] = useState(false)

  const load = useCallback(async () => {
    // An older main process (dev without restart) has no MCP bridge yet: show the empty list.
    if (typeof window.api?.mcpList !== 'function') {
      setConnections([])
      return
    }
    try {
      const r = await window.api.mcpList()
      if (r.ok) {
        setConnections(r.connections)
        setSecretsAvailable(r.secretsAvailable)
        setLoadError(null)
      } else setLoadError('Connections could not be loaded.')
    } catch {
      setLoadError('Connections could not be loaded.')
    }
  }, [])

  useEffect(() => {
    queueMicrotask(() => void load())
  }, [load])

  const upsert = (c: McpConnection): void =>
    setConnections((all) => (all === null ? [c] : all.some((x) => x.id === c.id) ? all.map((x) => (x.id === c.id ? c : x)) : [...all, c]))

  async function test(c: McpConnection) {
    setTests((t) => ({ ...t, [c.id]: { busy: true, text: null, ok: false } }))
    try {
      const r = await window.api.mcpTest({ id: c.id })
      if (!r.ok) {
        setTests((t) => ({ ...t, [c.id]: { busy: false, text: 'The test could not run.', ok: false } }))
        return
      }
      upsert(r.connection)
      const text =
        r.status === 'connected'
          ? `Connected: ${r.tools.length} ${r.tools.length === 1 ? 'tool' : 'tools'}. Choose which agents may use in Edit.`
          : `${STATUS_TEXT[r.status]}${r.error ? `: ${r.error}` : ''}`
      setTests((t) => ({ ...t, [c.id]: { busy: false, text, ok: r.status === 'connected' } }))
    } catch {
      setTests((t) => ({ ...t, [c.id]: { busy: false, text: 'The test could not run.', ok: false } }))
    }
  }

  async function remove(c: McpConnection) {
    if (!window.confirm(`Remove the connection "${c.name}" and its saved secrets?`)) return
    const r = await window.api.mcpDelete({ id: c.id }).catch(() => ({ ok: false as const, error: 'storage-error' as const }))
    if (r.ok) setConnections((all) => (all ?? []).filter((x) => x.id !== c.id))
    else setLoadError('The connection could not be removed.')
  }

  const editingConnection = editing?.kind === 'edit' ? (connections ?? []).find((c) => c.id === editing.id) ?? null : null

  return (
    <section className="settings__section" aria-label="Connections">
      <h3 className="settings__heading">Connections (MCP)</h3>
      <p className="settings__hint">
        Give the Chat and the Planner access to other tools, like your Linear tasks. Pipeline workers never get them. Only the
        tools you tick can be used. The same connections apply to every project.
      </p>
      {!secretsAvailable && (
        <p role="status" className="settings__banner">
          Your OS keychain is not available, so tokens and API keys cannot be saved. Connections without secrets still work.
        </p>
      )}
      {loadError && <p role="alert">{loadError}</p>}
      {connections === null && !loadError && <p role="status">Loading connections...</p>}
      {connections !== null && connections.length === 0 && editing === null && <p className="settings__hint">No connections yet.</p>}
      {connections !== null && connections.length > 0 && (
        <ul className="mcp__list">
          {connections.map((c) => {
            const t = tests[c.id]
            return (
              <li key={c.id} className="mcp__item">
                <div className="mcp__item-head">
                  <div>
                    <strong>{c.name}</strong>{' '}
                    <span className="mcp__badge">{c.transport === 'stdio' ? 'local' : 'remote'}</span>
                    {!c.enabled && <span className="mcp__badge">off</span>}
                    <p className="settings__hint mcp__target">{c.transport === 'stdio' ? [c.command, ...c.args].join(' ') : c.url}</p>
                    <p className="settings__hint">
                      {c.allowedTools.length} of {c.knownTools.length} tools allowed
                      {c.knownTools.length === 0 ? ' (run Test connection to list them)' : ''}
                    </p>
                  </div>
                  <div className="mcp__actions">
                    <button type="button" onClick={() => void test(c)} disabled={t?.busy === true}>
                      {t?.busy ? 'Testing...' : 'Test connection'}
                    </button>
                    <button type="button" onClick={() => setEditing({ kind: 'edit', id: c.id })}>
                      Edit
                    </button>
                    <button type="button" onClick={() => void remove(c)}>
                      Remove
                    </button>
                  </div>
                </div>
                {t?.text && (
                  <p role="status" className={t.ok ? 'mcp__test mcp__test--ok' : 'mcp__test mcp__test--bad'}>
                    {t.text}
                  </p>
                )}
                {editing?.kind === 'edit' && editing.id === c.id && editingConnection && (
                  <ConnectionForm
                    initial={draftFrom(editingConnection)}
                    known={editingConnection}
                    hint={null}
                    onSaved={(saved) => {
                      upsert(saved)
                      setEditing(null)
                    }}
                    onCancel={() => setEditing(null)}
                  />
                )}
              </li>
            )
          })}
        </ul>
      )}
      {editing?.kind === 'new' ? (
        <ConnectionForm
          initial={{ ...editing.preset.draft, id: null, allowedTools: [] }}
          known={null}
          hint={editing.preset.hint}
          onSaved={(saved) => {
            upsert(saved)
            setEditing(null)
            void test(saved)
          }}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <div className="mcp__add">
          <button type="button" aria-expanded={presetOpen} onClick={() => setPresetOpen((o) => !o)}>
            Add connection
          </button>
          {presetOpen && (
            <div role="group" aria-label="Connection type" className="mcp__presets">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    setPresetOpen(false)
                    setEditing({ kind: 'new', preset: p })
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

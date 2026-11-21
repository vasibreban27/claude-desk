import { useEffect, useId, useMemo, useState } from 'react'
import {
  AGENT_INSTRUCTIONS_MAX,
  AGENT_MODELS,
  HOUSE_RULES_MAX,
  isEmptyOverride,
  type AgentLayer,
  type AgentModel,
  type AgentOverride,
  type AgentRole,
  type AgentView,
  type HookView,
  type ProjectAgentsView,
  type SkillView
} from '@shared/ipc'
import { useProjectAgents, type UseProjectAgents } from '../../hooks/useProjectAgents'
import { Markdown } from '../Markdown'
import './toolkit.css'

type Selected = { kind: 'rules' } | { kind: 'agent'; name: string } | { kind: 'skill'; name: string } | { kind: 'hook'; index: number }

const ROLE_GROUPS: { role: AgentRole; label: string }[] = [
  { role: 'worker', label: 'Workers' },
  { role: 'reviewer', label: 'Reviewers' },
  { role: 'helper', label: 'Helpers' }
]
const ROLE_LABEL: Record<AgentRole, string> = { worker: 'Worker', reviewer: 'Reviewer', helper: 'Helper' }
const ROLE_HINT: Record<AgentRole, string> = {
  worker: 'The planner assigns pipeline tasks to it; each task runs in its own worktree.',
  reviewer: 'Reviews each finished task before it is merged into the run branch.',
  helper: 'A subagent Chat and the planner can call. Project changes do not apply to helpers yet.'
}
const MODEL_NAME: Record<AgentModel, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' }

const tokens = (n: number): string => (n < 1000 ? String(n) : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`)

function modelChip(a: AgentView): string {
  if (a.override && !a.override.usedInPlans && a.role === 'worker') return 'off'
  return a.effectiveModel ?? 'default'
}

export function ToolkitPanel({ projectId }: { projectId: string }) {
  const data = useProjectAgents(projectId)
  const [selected, setSelected] = useState<Selected | null>(null)
  const [filter, setFilter] = useState('')

  if (data.loading && data.view === null) {
    return (
      <p className="toolkit" role="status">
        Loading the toolkit…
      </p>
    )
  }
  if (data.view === null) {
    return (
      <p className="toolkit toolkit__error" role="alert">
        {data.error ?? 'Could not load the toolkit.'}
      </p>
    )
  }
  const view = data.view
  const firstWorker = view.agents.find((a) => a.role === 'worker') ?? view.agents[0]
  const current: Selected = selected ?? (firstWorker ? { kind: 'agent', name: firstWorker.name } : { kind: 'rules' })

  return (
    <section className="toolkit" aria-label="Toolkit">
      <header className="toolkit__header">
        <span className="toolkit__title">{view.toolkit ? `${view.toolkit.name} ${view.toolkit.version ?? ''}`.trim() : 'Toolkit'}</span>
        <span className="toolkit__muted">
          {view.agents.length} agents · {view.skills.length} skills
        </span>
        {!view.editable && <span className="toolkit__warn">Read-only: the app database is unavailable</span>}
      </header>
      {view.problems.length > 0 && (
        <details className="toolkit__problems">
          <summary>
            {view.problems.length} {view.problems.length === 1 ? 'file' : 'files'} in the toolkit could not be read
          </summary>
          <ul>
            {view.problems.map((p) => (
              <li key={p.file}>
                <code>{p.file}</code>: {p.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="toolkit__body">
        <Nav view={view} current={current} filter={filter} setFilter={setFilter} select={setSelected} />
        <div className="toolkit__detail" aria-live="polite">
          {current.kind === 'rules' ? (
            <HouseRules key={`rules:${projectId}`} view={view} save={data.saveHouseRules} />
          ) : current.kind === 'agent' ? (
            <AgentDetail key={`${projectId}:${current.name}`} view={view} name={current.name} data={data} />
          ) : current.kind === 'skill' ? (
            <SkillDetail skill={view.skills.find((s) => s.name === current.name)} />
          ) : (
            <HookDetail hook={view.hooks[current.index]} />
          )}
        </div>
      </div>
    </section>
  )
}

function Nav({
  view,
  current,
  filter,
  setFilter,
  select
}: {
  view: ProjectAgentsView
  current: Selected
  filter: string
  setFilter: (v: string) => void
  select: (s: Selected) => void
}) {
  const q = filter.trim().toLowerCase()
  const match = (...parts: (string | null)[]): boolean => q === '' || parts.some((p) => (p ?? '').toLowerCase().includes(q))
  const isOn = (s: Selected): boolean =>
    s.kind === current.kind &&
    (s.kind === 'rules' ||
      (s.kind === 'agent' && current.kind === 'agent' && s.name === current.name) ||
      (s.kind === 'skill' && current.kind === 'skill' && s.name === current.name) ||
      (s.kind === 'hook' && current.kind === 'hook' && s.index === current.index))
  const skills = view.skills.filter((s) => match(s.name, s.description))
  const hooks = view.hooks.map((h, i) => ({ h, i })).filter(({ h }) => match(h.event, h.matcher, h.command))

  return (
    <nav className="toolkit__nav" aria-label="Toolkit items">
      <input type="search" className="toolkit__filter" placeholder="Filter agents and skills" aria-label="Filter toolkit" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <button type="button" className="toolkit__rules" aria-pressed={isOn({ kind: 'rules' })} onClick={() => select({ kind: 'rules' })}>
        <span className="toolkit__rules-title">House rules</span>
        <span className="toolkit__muted">{view.houseRules.trim() ? 'Set for this project' : 'Not set'}</span>
      </button>
      {ROLE_GROUPS.map(({ role, label }) => {
        const agents = view.agents.filter((a) => a.role === role && match(a.name, a.description))
        if (agents.length === 0) return null
        return (
          <div key={role} className="toolkit__group">
            <h3 className="toolkit__group-title">{label}</h3>
            {agents.map((a) => {
              const chip = modelChip(a)
              return (
                <button
                  key={a.name}
                  type="button"
                  className={`toolkit__row${chip === 'off' ? ' toolkit__row--off' : ''}`}
                  aria-pressed={isOn({ kind: 'agent', name: a.name })}
                  onClick={() => select({ kind: 'agent', name: a.name })}
                >
                  <span className="toolkit__row-name">{a.name}</span>
                  {a.override && <span className="toolkit__dot" title="Customized for this project" aria-label="customized" />}
                  <span className="toolkit__chip">{chip}</span>
                </button>
              )
            })}
          </div>
        )
      })}
      {skills.length > 0 && (
        <div className="toolkit__group">
          <h3 className="toolkit__group-title">Skills</h3>
          {skills.map((s) => (
            <button key={s.name} type="button" className="toolkit__row" aria-pressed={isOn({ kind: 'skill', name: s.name })} onClick={() => select({ kind: 'skill', name: s.name })}>
              <span className="toolkit__row-name">{s.name}</span>
            </button>
          ))}
        </div>
      )}
      {hooks.length > 0 && (
        <details className="toolkit__group">
          <summary className="toolkit__group-title">Advanced: hooks ({hooks.length})</summary>
          {hooks.map(({ h, i }) => (
            <button key={i} type="button" className="toolkit__row" aria-pressed={isOn({ kind: 'hook', index: i })} onClick={() => select({ kind: 'hook', index: i })}>
              <span className="toolkit__row-name">
                {h.event}
                {h.matcher ? ` (${h.matcher})` : ''}
              </span>
            </button>
          ))}
        </details>
      )}
    </nav>
  )
}

function HouseRules({ view, save }: { view: ProjectAgentsView; save: UseProjectAgents['saveHouseRules'] }) {
  const id = useId()
  const [text, setText] = useState(view.houseRules)
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const dirty = text !== view.houseRules

  return (
    <div className="toolkit__pane">
      <h2 className="toolkit__name">House rules</h2>
      <p className="toolkit__muted">
        This project&apos;s conventions: package layout, libraries, naming, test style. Every worker and reviewer gets them
        after its toolkit instructions, and the planner follows them when it chooses files for the tasks.
      </p>
      <label htmlFor={`${id}-rules`} className="toolkit__label">
        Rules for this project
      </label>
      <textarea
        id={`${id}-rules`}
        className="toolkit__textarea toolkit__textarea--tall"
        value={text}
        maxLength={HOUSE_RULES_MAX}
        disabled={!view.editable}
        placeholder={'Layer-first packages: controller, service, repository, dto, mapper, exception.\nDTOs are Java records. Use MapStruct for mapping.'}
        onChange={(e) => {
          setText(e.target.value)
          setStatus(null)
        }}
      />
      <div className="toolkit__actions">
        <span className="toolkit__muted">
          {text.length} / {HOUSE_RULES_MAX}
        </span>
        {status && (
          <span role={status.kind === 'error' ? 'alert' : 'status'} className={status.kind === 'error' ? 'toolkit__error' : 'toolkit__ok'}>
            {status.text}
          </span>
        )}
        <button
          type="button"
          className="toolkit__primary"
          disabled={!dirty || saving || !view.editable}
          onClick={async () => {
            setSaving(true)
            const err = await save(text)
            setSaving(false)
            setStatus(err ? { kind: 'error', text: err } : { kind: 'ok', text: 'Saved. The next sessions use these rules.' })
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

function AgentDetail({ view, name, data }: { view: ProjectAgentsView; name: string; data: UseProjectAgents }) {
  const agent = view.agents.find((a) => a.name === name)
  if (!agent) return <p className="toolkit__muted">This agent is no longer in the toolkit.</p>
  const customized = agent.override !== null
  return (
    <div className="toolkit__pane">
      <div className="toolkit__heading">
        <h2 className="toolkit__name">{agent.name}</h2>
        <span className={`toolkit__badge toolkit__badge--${agent.role}`}>{ROLE_LABEL[agent.role]}</span>
        {customized && <span className="toolkit__badge">Customized for this project</span>}
      </div>
      <p>{agent.description}</p>
      <p className="toolkit__muted">
        {ROLE_HINT[agent.role]}
        {agent.usage ? ` ${agent.usage.sessions} ${agent.usage.sessions === 1 ? 'session' : 'sessions'} and ${tokens(agent.usage.tokens)} tokens in the last 30 days.` : ''}
      </p>
      {agent.role !== 'helper' && <ProjectSettings key={JSON.stringify(agent.override)} agent={agent} editable={view.editable} save={data.saveOverride} />}
      <Preview key={`${JSON.stringify(agent.override)}:${view.houseRules}`} agent={agent} preview={data.preview} />
      <details className="toolkit__card">
        <summary className="toolkit__card-title">
          Toolkit instructions <span className="toolkit__muted">· {agent.source}</span>
        </summary>
        <p className="toolkit__muted">
          Model in the file: {agent.toolkitModel ? MODEL_NAME[agent.toolkitModel] : 'none'} · Tools in the file: {agent.tools.join(', ') || 'all'}
          {agent.role === 'worker' || agent.role === 'reviewer' ? ' (pipeline sessions use the app’s own tool set)' : ''}
        </p>
        <Markdown text={agent.body} />
      </details>
    </div>
  )
}

function ProjectSettings({ agent, editable, save }: { agent: AgentView; editable: boolean; save: UseProjectAgents['saveOverride'] }) {
  const id = useId()
  const initial: AgentOverride = agent.override ?? { model: null, instructions: '', usedInPlans: true }
  const [draft, setDraft] = useState<AgentOverride>(initial)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial)
  const inheritLabel = agent.toolkitModel ? `Toolkit default (${MODEL_NAME[agent.toolkitModel]})` : 'Project default'

  const run = async (next: AgentOverride | null, done: string) => {
    setSaving(true)
    const err = await save(agent.name, next === null || isEmptyOverride(next) ? null : next)
    setSaving(false)
    setStatus(err ? { kind: 'error', text: err } : { kind: 'ok', text: done })
  }

  return (
    <div className="toolkit__card">
      <h3 className="toolkit__card-title">For this project</h3>
      <div className="toolkit__form">
        <label htmlFor={`${id}-model`}>Model</label>
        <div>
          <select
            id={`${id}-model`}
            value={draft.model ?? ''}
            disabled={!editable}
            onChange={(e) => {
              setDraft({ ...draft, model: e.target.value === '' ? null : (e.target.value as AgentModel) })
              setStatus(null)
            }}
          >
            <option value="">{inheritLabel}</option>
            {AGENT_MODELS.map((m) => (
              <option key={m} value={m}>
                {MODEL_NAME[m]}
              </option>
            ))}
          </select>
          <p className="toolkit__hint">A task in the plan can still pick its own model.</p>
        </div>
        {agent.role === 'worker' && (
          <>
            <span>Use in plans</span>
            <label className="toolkit__check">
              <input
                type="checkbox"
                checked={draft.usedInPlans}
                disabled={!editable}
                onChange={(e) => {
                  setDraft({ ...draft, usedInPlans: e.target.checked })
                  setStatus(null)
                }}
              />
              The planner may assign tasks to it
            </label>
          </>
        )}
        <label htmlFor={`${id}-extra`}>Extra instructions</label>
        <div>
          <textarea
            id={`${id}-extra`}
            className="toolkit__textarea"
            value={draft.instructions}
            maxLength={AGENT_INSTRUCTIONS_MAX}
            disabled={!editable}
            placeholder="Only for this agent in this project, e.g. Use MapStruct for every mapper."
            onChange={(e) => {
              setDraft({ ...draft, instructions: e.target.value })
              setStatus(null)
            }}
          />
          <p className="toolkit__hint">
            Added after the toolkit instructions and the house rules. {draft.instructions.length} / {AGENT_INSTRUCTIONS_MAX}
          </p>
        </div>
      </div>
      <div className="toolkit__actions">
        {status && (
          <span role={status.kind === 'error' ? 'alert' : 'status'} className={status.kind === 'error' ? 'toolkit__error' : 'toolkit__ok'}>
            {status.text}
          </span>
        )}
        {agent.override && (
          <button type="button" disabled={saving || !editable} onClick={() => void run(null, 'Back to the toolkit settings.')}>
            Reset to toolkit
          </button>
        )}
        <button type="button" className="toolkit__primary" disabled={!dirty || saving || !editable} onClick={() => void run(draft, 'Saved. The next sessions use it.')}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

const LAYER_CLASS: Record<AgentLayer['kind'], string> = {
  toolkit: 'toolkit__layer--toolkit',
  'house-rules': 'toolkit__layer--project',
  agent: 'toolkit__layer--project',
  app: 'toolkit__layer--app'
}

function Preview({ agent, preview }: { agent: AgentView; preview: UseProjectAgents['preview'] }) {
  const [result, setResult] = useState<Awaited<ReturnType<UseProjectAgents['preview']>> | null>(null)
  useEffect(() => {
    let live = true
    void preview(agent.name).then((r) => {
      if (live) setResult(r)
    })
    return () => {
      live = false
    }
  }, [agent.name, preview])
  const modelText = useMemo(() => {
    if (!result?.ok) return ''
    if (agent.role === 'helper') return ''
    const base = result.model ? MODEL_NAME[result.model] : 'the project model'
    const from = result.modelSource === 'project' ? 'set for this project' : result.modelSource === 'toolkit' ? 'from the toolkit file' : 'no agent model set'
    return `Model: the task's own Model if the plan sets one, otherwise ${base} (${from}).`
  }, [result, agent.role])

  return (
    <div className="toolkit__card">
      <h3 className="toolkit__card-title">What a {agent.name} session receives</h3>
      {result === null ? (
        <p className="toolkit__muted">Loading…</p>
      ) : !result.ok ? (
        <p className="toolkit__error">Could not build the preview.</p>
      ) : (
        <>
          <ol className="toolkit__layers" aria-label="Instruction layers">
            {result.layers.map((l, i) => (
              <li key={i} className={`toolkit__layer ${LAYER_CLASS[l.kind]}`}>
                <details>
                  <summary>
                    {l.label}
                    <span className="toolkit__muted"> · {l.text.split('\n').length} lines</span>
                  </summary>
                  <pre className="toolkit__pre">{l.text}</pre>
                </details>
              </li>
            ))}
          </ol>
          {modelText && <p className="toolkit__hint">{modelText}</p>}
        </>
      )}
    </div>
  )
}

function SkillDetail({ skill }: { skill: SkillView | undefined }) {
  if (!skill) return <p className="toolkit__muted">This skill is no longer in the toolkit.</p>
  return (
    <div className="toolkit__pane">
      <div className="toolkit__heading">
        <h2 className="toolkit__name">{skill.name}</h2>
        <span className="toolkit__badge">Skill</span>
      </div>
      <p>{skill.description}</p>
      <p className="toolkit__muted">{skill.source}</p>
      <div className="toolkit__card">
        <Markdown text={skill.body} />
      </div>
    </div>
  )
}

function HookDetail({ hook }: { hook: HookView | undefined }) {
  if (!hook) return <p className="toolkit__muted">This hook is no longer in the toolkit.</p>
  return (
    <div className="toolkit__pane">
      <div className="toolkit__heading">
        <h2 className="toolkit__name">{hook.event}</h2>
        <span className="toolkit__badge">Hook</span>
      </div>
      <p className="toolkit__muted">
        Matcher: {hook.matcher ?? 'any'} · {hook.source}
      </p>
      <pre className="toolkit__pre">{hook.command}</pre>
    </div>
  )
}

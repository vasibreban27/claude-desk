# Plan: Phase 1.5 - UI polish

Source: the request for Phase 1.5 (not in `docs/vision.md`; it sits between Phase 1 and Phase 2). Renderer only. Nothing beyond this is planned here.

Branch: `phase-1-5-ui-polish` (never `main`).

## 1. Goal

As the owner I want the existing three-panel skeleton to look and behave like a finished app, so that daily use is pleasant and the later phases (workspace, runs, usage) land on a solid UI base.

Outcomes:
- One design-token layer (color, spacing, type, radius) with light and dark sets. Dark follows the OS by default; a toggle (system / light / dark) overrides it and is remembered.
- Chat reads like a chat: scrollable list, input pinned at the bottom, auto-scroll while streaming (unless the user scrolled up), distinct user/assistant messages, a streaming indicator, readable error banners.
- Assistant text renders as safe markdown (headings, lists, tables, inline code, code blocks with syntax highlighting and a copy button). Raw HTML is never rendered; links are sanitized and inert.
- Project items show name, branch, clean/dirty badge and a selected state. The three panels are resizable with minimum widths, and sizes survive a restart. Every panel has a designed empty state.

## 2. Scope

In (all under `src/renderer/`, plus `package.json`, `package-lock.json`, `vitest.config.ts`):
- Tokens, base styles, theme toggle.
- Markdown renderer component, chat layout polish.
- Project sidebar polish, resizable layout, empty states.

Out (do not build):
- Any new IPC channel, any change in `src/main`, `src/preload`, `src/shared`.
- Opening links in the system browser (needs an IPC channel plus a main-side handler; follow-up).
- Tool-call display, activity feed, usage, settings screens (Phase 2+).
- Markdown extras: images, raw HTML, math, diagrams, footnotes.
- Message timestamps, message editing or regenerating, a dismiss button on banners (the banner clears on the next send, as today).
- An icon library or web fonts (system font stack, inline SVG only where an icon is needed).

## 3. Architecture

Chosen (confirmed with the user):
- **Styling:** plain CSS with custom properties. `styles/tokens.css` (variables) and `styles/base.css` (reset, typography, focus ring, buttons, inputs, scrollbars). One `.css` file per component, imported by the component. Existing BEM-like class names are kept (`chat__message`, `projects__item`, ...).
- **Theme:** `:root` holds the light tokens. Dark tokens apply under `@media (prefers-color-scheme: dark)` for `:root:not([data-theme='light'])` and under `:root[data-theme='dark']`. A `useTheme` hook stores `'system' | 'light' | 'dark'` in `localStorage` (value validated on read, try/catch around storage), and sets or removes `data-theme` on `<html>`. No IPC.
- **Markdown:** `react-markdown` + `remark-gfm` (tables) + `rehype-highlight` limited to a small language set (ts, js, json, bash, powershell, python, css, html/xml, diff, markdown) so the bundle stays small; unknown languages render unhighlighted. react-markdown builds React elements (no `innerHTML`) and ignores raw HTML; `rehype-raw` is never added.
  - Links: only `http:`, `https:`, `mailto:` are kept; anything else (`javascript:`, `data:`, relative, malformed) renders as plain text. A kept link renders as a `<button type="button">` styled as a link, `title` = the URL, click copies the URL to the clipboard and shows "Copied" briefly. No `<a href>` is emitted, so the app window can never navigate (main has no `will-navigate` or `setWindowOpenHandler` guard, and this phase must not add one).
  - Images: not rendered; the alt text is shown instead (the CSP also blocks remote loads).
  - Code block: `<pre><code>` with a language label and a Copy button (`navigator.clipboard.writeText`, "Copied" state, failure shows nothing destructive).
  - Streaming: the message component is memoized and only the streaming message re-parses on each delta.
- **Resizable layout:** `react-resizable-panels`, with its built-in persistence (`localStorage`, renderer only). Three panels with separators (`role="separator"`, keyboard resizable). Min sizes: projects ~180px, workspace ~280px, chat ~320px if the library supports pixel constraints, otherwise equivalent percentages. The existing landmark structure (`aside` Projects, `main` Workspace, `section` Chat with named headings) is kept.
- **Auto-scroll:** the message list sticks to the bottom while the user is within ~48px of it; scrolling up pauses it; sending a message always scrolls to the bottom. A "Jump to latest" button appears while paused and streaming.

Rejected: CSS Modules and Tailwind (rewrite of all markup for no gain here); `marked` + DOMPurify (HTML-string injection conflicts with the no-raw-HTML stance); own resize hook and CSS-only resize (the user chose the library); real `<a target="_blank">` links (would open an Electron window without a main-side guard).

### Verify before building (CLAUDE.md rule: check current docs, do not rely on memory)
- `react-resizable-panels` major version and API (older: `PanelGroup`/`Panel`/`PanelResizeHandle` with `autoSaveId`; newer majors renamed components and persistence). T1 installs the library and picks the version from current docs; T4 builds against that installed version's API.
- `rehype-highlight` option for restricting languages (`languages` map from `lowlight`), and compatibility of `react-markdown` / `remark-gfm` / `rehype-highlight` majors with React 19 and Vite 8.
- `ResizeObserver` in jsdom: not implemented, needed by the panel library (T1 adds a test setup polyfill).

## 4. Changes per layer

- API: none. No new IPC, no change in `src/shared/ipc.ts`.
- Service (main): none.
- Database: none.
- UI (renderer):
  - `src/renderer/src/styles/tokens.css`, `base.css` (new); `styles/layout.css` (rewritten by T4).
  - `src/renderer/src/components/Markdown/` (new): `Markdown.tsx`, `CodeBlock.tsx`, `safeLink.ts`, `markdown.css`, tests, `index.ts`.
  - `src/renderer/src/hooks/useTheme.ts` and `src/renderer/src/components/ThemeToggle/` (new).
  - `Layout/` (resizable panels, workspace empty state), `Projects/` (items, empty states, theme toggle mount), `Chat/` (layout, messages, indicator, banner, empty states).
  - `package.json`, `package-lock.json`, `vitest.config.ts`, `src/renderer/src/test/setup.ts` (T1).

## 5. Risks

| Risk | Mitigation |
|---|---|
| Markdown XSS or navigation through links or HTML | No `rehype-raw`, no `dangerouslySetInnerHTML`, scheme allowlist, links are buttons (no href). Dedicated tests with hostile inputs (`<script>`, `<img onerror>`, `javascript:` and `data:` links, `[x](//evil)`). |
| Library API drift (resizable panels, rehype-highlight) | "Verify before building" list above; workers check installed docs first and keep the wrapper thin. |
| Existing tests assert old markup: `Layout.test.tsx` greps `layout.css` for `minmax(0,` and `overflow-x: hidden`, `App.test.tsx` expects `Claude:` text and plain paragraphs | T4 rewrites the Layout CSS assertions (keep: no `display: none`, no `@media` in layout.css, `overflow-x: hidden`); T6 updates the chat assertions in `App.test.tsx`. Behavior assertions (roles, labels, `aria-pressed`, alert text) stay unchanged. |
| jsdom has no layout, so scroll and resize cannot be measured | Unit-test the stick-to-bottom decision as a pure function plus scroll-property mocks; resize behavior tested through keyboard on the separator and persisted layout, not pixel drags. Real behavior covered by the manual check in the Test strategy. |
| Panels cannot fit if the window is narrower than the sum of min widths | Panels keep `min-width: 0` and `overflow: hidden/auto`; no horizontal page scroll (existing rule). Main window `minWidth` is a main-process change and is out of scope; note it as a follow-up. |
| Dark theme contrast regressions | A test parses `tokens.css` and asserts WCAG contrast >= 4.5:1 for the text/background pairs in both themes. |
| Theme flash on start | `useTheme` applies `data-theme` in a layout effect before first paint; system mode needs no JS (media query). |
| Bundle growth from highlight.js | Restricted language list; no highlight theme beyond two token-driven color sets. |

## 6. Test strategy

- Unit (Vitest): `safeLink` (allowlist and hostile cases), stick-to-bottom helper, `useTheme` (default system, persists, invalid stored value falls back, storage throws), token contrast test.
- Component (Testing Library, jsdom): Markdown (headings, lists, GFM table, inline and fenced code, copy button calls the clipboard, raw HTML shown as text or dropped, hostile links inert), ChatPanel (roles, indicator while busy, banner with `role="alert"`, empty states, auto-scroll with mocked scroll metrics, input disabled rules unchanged), ProjectsPanel (branch, detached, clean and dirty badges, selected state with `aria-pressed`, empty and error states), Layout (landmarks and order, separators present and keyboard-resizable, placeholder).
- Integration: the existing `App.test.tsx` flows (select project, stream, error, rejected send) keep passing with updated text assertions.
- Not tested deliberately: pixel drag of separators, real scrolling and layout, visual appearance of themes, syntax highlight colors, real clipboard. Covered by a manual check in `npm run dev`: toggle theme, drag panels, restart and confirm sizes and theme persist, stream a long markdown answer and scroll up mid-stream.

## 7. Tasks

### Wave 1

### T1: Dependencies, design tokens, base styles, test setup
- Status: [x] verified
- Worker: frontend-developer
- Contract: none
- Owns: `package.json`, `package-lock.json`, `vitest.config.ts`, `src/renderer/src/test/setup.ts`, `src/renderer/src/styles/tokens.css`, `src/renderer/src/styles/base.css`, `src/renderer/src/styles/tokens.test.ts`, `src/renderer/src/main.tsx`
- Depends on: none
- Acceptance criteria:
  - Given a clean checkout When `npm install` runs Then `react-markdown`, `remark-gfm`, `rehype-highlight` (and `lowlight`/`highlight.js` if the chosen version needs them as direct deps) and `react-resizable-panels` are in `dependencies` with versions verified against current docs, and `npm run typecheck` and `npm run build` pass.
  - Given `tokens.css` When read Then it defines variables for color (bg, surface, border, text, muted text, accent, success, warning, danger, message user/assistant backgrounds, code background), spacing scale, type scale and families, radius and shadow, in `:root` (light), in `@media (prefers-color-scheme: dark)` for `:root:not([data-theme='light'])`, and in `:root[data-theme='dark']`, with the dark values identical in both dark blocks.
  - Given the token pairs text/bg, muted/bg, accent-text/accent, danger text/bg-danger in light and dark When `npm test -- src/renderer/src/styles/tokens.test.ts` runs Then every pair has contrast >= 4.5:1.
  - Given `base.css` When the app loads Then body uses the token font, color and background, buttons, inputs and textareas have consistent styles with a visible `:focus-visible` ring, and `prefers-reduced-motion` disables transitions and animations; `main.tsx` imports `tokens.css` then `base.css`.
  - Given jsdom tests When `src/renderer/src/test/setup.ts` is registered in `vitest.config.ts` (`setupFiles`) Then `ResizeObserver` exists as a harmless stub in jsdom without breaking node-environment tests, and all existing tests still pass.

### Wave 2

### T2: Safe markdown renderer
- Status: [x] verified
- Worker: frontend-developer
- Contract: none
- Owns: `src/renderer/src/components/Markdown/**`
- Depends on: T1
- Acceptance criteria:
  - Given `<Markdown text={...}/>` with headings, ordered and unordered lists, a GFM table, inline code and a fenced block When rendered Then the matching elements exist (`h1`-`h6`, `ul`/`ol`, `table` with `th`/`td`, `code`, `pre`) and the table scrolls horizontally inside its own wrapper instead of widening the panel.
  - Given a fenced block with a language When rendered Then it shows the language label, highlighted tokens for the supported languages, and a Copy button that calls `navigator.clipboard.writeText` with exactly the code text, then shows "Copied" for ~1.5s; an unknown language renders plain.
  - Given text containing `<script>alert(1)</script>`, `<img src=x onerror=alert(1)>` and `<b>x</b>` When rendered Then no `script`, `img` or `b` element exists in the DOM and no handler attributes are present.
  - Given links `[a](https://x.dev)`, `[b](mailto:a@b.c)`, `[c](javascript:alert(1))`, `[d](data:text/html,x)`, `[e](/rel)`, `[f](//evil.com)` When rendered Then a and b render as `<button>` with `title` equal to the URL and no `href` anywhere; c to f render as plain text; clicking a copies its URL.
  - Given a markdown image `![alt](https://x/y.png)` When rendered Then no `img` element exists and the alt text is shown.
  - Given the same `text` prop When the parent re-renders Then the component does not re-parse (memoized); a changed `text` re-renders.
  - Given the module When linted Then there is no `dangerouslySetInnerHTML` and no `rehype-raw` import in `src/renderer`.

### T3: Theme hook and toggle
- Status: [x] verified
- Worker: frontend-developer
- Contract: none
- Owns: `src/renderer/src/hooks/useTheme.ts`, `src/renderer/src/hooks/useTheme.test.ts`, `src/renderer/src/components/ThemeToggle/**`
- Depends on: T1
- Acceptance criteria:
  - Given no stored value When `useTheme` mounts Then the mode is `system` and `<html>` has no `data-theme`.
  - Given the user picks light or dark When the choice is made Then `<html data-theme>` is set to it and `localStorage` holds the mode; picking system removes the attribute and the stored override.
  - Given a stored value that is not `system|light|dark`, or `localStorage` throwing When the hook mounts Then it falls back to `system` without throwing.
  - Given `<ThemeToggle/>` When rendered Then it is a labelled control group (for example a radio group named "Theme") with three options, keyboard operable, reflecting the current mode.

### T4: Resizable three-panel layout and workspace empty state
- Status: [x] verified
- Worker: frontend-developer
- Contract: none
- Owns: `src/renderer/src/components/Layout/**`, `src/renderer/src/styles/layout.css`
- Depends on: T1
- Acceptance criteria:
  - Given the app When rendered Then the landmarks `aside` "Projects", `main` "Workspace" and `section` "Chat" exist in that order with their `h2` titles, and two separators (`role="separator"`) sit between them.
  - Given a focused separator When ArrowLeft or ArrowRight is pressed Then the neighbouring panel sizes change, and never go below the minimums (projects ~180px, workspace ~280px, chat ~320px, or the percentage equivalent).
  - Given a changed layout When the layout is unmounted and mounted again Then the sizes are restored from `localStorage` (library persistence); corrupt stored data falls back to the default 20/45/35 split without throwing.
  - Given the Workspace panel with no `workspace` prop When rendered Then it shows a designed empty state (icon-free: title and one hint line) that still contains the text "Runs, activity and usage will appear here".
  - Given `layout.css` When read Then it uses tokens only (no hard-coded colors), keeps `overflow-x: hidden`, contains no `display: none` and no `@media`; `Layout.test.tsx` is updated to assert these instead of the old `minmax(0,` check.
  - Given a narrow window When panels are at their minimums Then no horizontal page scrollbar appears (`min-width: 0` on panels, overflow handled inside each panel).

### Wave 3

### T5: Project sidebar polish, empty states, theme toggle mount
- Status: [ ] todo
- Worker: frontend-developer
- Contract: none
- Owns: `src/renderer/src/components/Projects/**`
- Depends on: T1, T3, T4
- Acceptance criteria:
  - Given projects When rendered Then each item shows the name, the branch (or `detached` when null) and a `clean` or `dirty` badge whose color comes from success/warning tokens and whose meaning is also in the text (not color alone).
  - Given a selected project When rendered Then its item has `aria-pressed="true"`, a visibly distinct background and an accent marker; hover and `:focus-visible` states exist; long names and branches truncate with ellipsis and a `title`.
  - Given no projects and not loading When rendered Then an empty state shows a short explanation containing "No projects yet" and the Add project button remains the primary action.
  - Given loading or a load error When rendered Then a loading line (`Loading projects…`) or an error banner with `role="alert"` and the existing message text is shown, styled with danger tokens.
  - Given the sidebar When rendered Then `<ThemeToggle/>` is mounted in a footer pinned to the bottom of the panel, and the project list scrolls independently above it.
  - Given the existing projects tests in `App.test.tsx` When run Then they pass unchanged (this task must not break their text, roles or `aria-pressed`); new component tests live in `Projects/ProjectsPanel.test.tsx`.

### T6: Chat panel layout, messages, indicator, banners
- Status: [ ] todo
- Worker: frontend-developer
- Contract: none
- Owns: `src/renderer/src/components/Chat/**`, `src/renderer/src/App.test.tsx`
- Depends on: T1, T2, T4
- Acceptance criteria:
  - Given the chat panel When rendered Then it is a column: a scrollable message list (`role="log"`, `aria-live="polite"`, `aria-label="Messages"`, `min-height: 0`) above a composer pinned at the bottom that never scrolls away; the textarea grows up to a max height then scrolls; Enter sends, Shift+Enter inserts a newline, Send and `maxLength` behavior are unchanged.
  - Given user and assistant messages When rendered Then they are visually distinct (alignment and token backgrounds) with an accessible author label ("You" / "Claude", may be visually subtle), user text is plain text with preserved line breaks, assistant text goes through `<Markdown/>`.
  - Given a streaming turn When text deltas arrive Then the assistant message grows in place with one author label (updated assertion replaces `getAllByText(/Claude:/)` with a count of assistant message elements), and a streaming indicator (animated dots, static under `prefers-reduced-motion`, with text "Claude is answering…" available to screen readers) shows while `busy` and disappears on done or error.
  - Given the list is scrolled to within ~48px of the bottom When messages or deltas arrive Then it stays pinned to the bottom; given the user scrolled up Then it does not move and a "Jump to latest" button appears; sending a message always scrolls to the bottom. The stick-to-bottom decision is a pure, unit-tested function.
  - Given `error` is set When rendered Then a banner with `role="alert"`, danger tokens, an icon-free label ("Something went wrong") and the full message text sits between the list and the composer; long messages wrap.
  - Given no project selected When rendered Then an empty state says to add or select a project and the composer is disabled with the existing placeholder; given a project with no messages Then an empty state shows "No messages yet. Ask Claude about this project."; given `loading` Then "Loading messages…" is shown.
  - Given `App.test.tsx` When run Then all flows (select, stream, done, error event, rejected send, other-project events ignored) pass with only the text assertions that depended on the old `Claude:` prefix updated.

## 8. Wave summary

| Wave | Tasks | Parallel |
|---|---|---|
| 1 | T1 | single task (shared files: `package.json`, `vitest.config.ts`, `main.tsx`) |
| 2 | T2, T3, T4 | yes, disjoint folders |
| 3 | T5, T6 | yes, disjoint folders; T6 alone owns `App.test.tsx` |

All tasks go to `frontend-developer` (all files are under `src/renderer`). Commits: Conventional Commits with the task id, for example `feat(chat): render assistant markdown (T2)`.

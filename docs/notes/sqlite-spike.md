# SQLite spike (Phase 2, T1)

Result: `better-sqlite3` works with no rebuild step. No fallback to `node:sqlite` is needed.

- Version: `better-sqlite3` ^13.2.0 (engines node >=22), types `@types/better-sqlite3`.
- Setup: the package ships prebuilt binaries (`prebuilds/`), so one install works for both ABIs.
  npm 11 blocks its `node-gyp rebuild` install script (not approved) and that is fine; do not approve it.
- Verified on Windows, Node 24.21 (ABI 137) and Electron 45.3.1 (ABI 150):
  - Node: `tests/sqlite-smoke.test.ts` opens `:memory:` under Vitest (`npm test`).
  - Electron: a one-off script in Electron's main process (`electron <script>`) required the module,
    opened `:memory:` and ran `select sqlite_version()` (3.54.1) successfully.
  - Build: a temporary `import Database from 'better-sqlite3'` in main stayed an external import in
    `out/main/index.js` (electron-vite externalizes dependencies by default), and `npm run build` passed.
- Docs/sources consulted: npm registry metadata for `better-sqlite3`; CLAUDE.md rules (node_modules not read).
  Prebuild coverage was confirmed by running it, not from the package README.
- Switching ABIs: not needed. If a future Electron/Node release has no prebuild, fall back to
  `npx @electron/rebuild -f -w better-sqlite3` for Electron, and `npm rebuild better-sqlite3` to return to Node.
- Not verified: macOS and Linux (prebuilds are expected there; recheck when packaging).

# Threat model (claude-desk)

Local desktop app, single user, no server.

## In scope

- A cloned hostile repo: its files, `.git/config`, hooks, `.gitattributes`, symlinks and junctions, `docs/plans` files and `CLAUDE.md`. It must not make the app run code, read or write outside the project or worktree, leak secrets, or change `main`.
- A prompt-injected agent (worker or chat): it must not leave its `Owns` or worktree, get a shell, push, merge, or read protected files (`.env`, keys).
- IPC from the renderer: every payload is validated in main; the renderer never sends paths.

## Out of scope or accepted

- `run_check` runs worker-written code as the user, unsandboxed (environment allowlist only).
- Other local users or processes, physical access, a compromised Claude login, packages already installed in the project.

## Severity rule

Blocker and major need a reproduction against the app's real tools. Exotic filesystem quirks without a realistic exploit path are minor and go to Follow-ups.

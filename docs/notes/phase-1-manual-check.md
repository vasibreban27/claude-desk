# Phase 1 manual check

Confirms the "done when": add a project and chat with Claude from inside the app.
The live SDK call is the only part not covered by automated tests.

1. Be logged in to Claude Code on this machine (the SDK reuses that login).
2. Clone `claude-toolkit` somewhere and set `CLAUDE_TOOLKIT_PATH` to that folder in your shell.
3. `npm install`, then `npm run dev`.
4. Click "Add project" and pick a git repo. Expect its branch and a clean/dirty badge.
5. Pick a non-git folder. Expect a readable "not a git repo" message.
6. Select the project, send a message. Expect the reply to stream in and the input to re-enable.
7. Add a second project, send a message there. Expect separate chat histories.
8. Close and reopen the app. Expect the projects to remain and chats to be empty.

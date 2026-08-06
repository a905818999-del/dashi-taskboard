# Windows browser mode

> Status: the original browser-first MVP below is implemented at `84c2827`, but shared Codex App/browser thread handoff is still under development. See [windows-browser-handoff.md](./windows-browser-handoff.md) for the authoritative plan, current progress, safety contract, and next-agent instructions.

## Supported flow

1. Start the local service in PowerShell; it listens on `127.0.0.1` by default.
2. Create a project and task, record acceptance criteria, and bind a dedicated Git worktree.
3. Open the task detail and create or open its single primary AI conversation.
4. The first turn runs `codex exec --json`; later turns explicitly run `codex exec resume <codexThreadId>`.
5. Normalized user, assistant, tool, failure and run events are persisted in SQLite and streamed with SSE.
6. Refresh or restart restores history. Abandoned runs become `interrupted` without removing the Codex thread ID.
7. A completed run does not mark the task `done`; the task reaches `done` only after user acceptance.

## Safety and conflict checks

- Write runs require a clean worktree on the first turn.
- Branch, HEAD, dirty state, `index.lock`, merge, rebase, cherry-pick, revert and bisect state are checked.
- A lock in the worktree Git directory permits one browser write run at a time.
- Later turns reject unexpected external worktree changes rather than overwriting them.
- Windows stop and error cleanup use `taskkill /T /F` with hidden windows to terminate the full process tree.
- `danger-full-access` is never the default and requires confirmation for every turn.

## Persisted output

`ai_chat_threads` stores browser conversation identity, task origin, Codex thread ID and the last verified Git state. `ai_chat_runs` stores each process outcome. `ai_chat_events` stores only bounded normalized visible events; hidden prompts, raw reasoning and complete raw JSONL are not stored.

## Verification

- `npm run check`
- Windows runner tests with fake Codex processes, malformed JSONL and process-tree cleanup.
- Worktree guard tests using paths containing spaces and Chinese characters.
- Real Codex CLI test in a disposable Git repository.
- Browser acceptance: create a task conversation, receive a response, refresh, resume the same Codex thread, interrupt a run, and confirm history remains.

## Untested risks

- Windows ARM, WSL and network-share worktrees are outside the MVP.
- Antivirus or indexing software may delay SQLite or Git lock release.
- Codex CLI JSONL can evolve; unknown events are intentionally ignored while malformed JSONL fails the run.
- Upstream has no recognizable license; no binary release or redistribution claim is made.

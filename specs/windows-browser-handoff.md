# Codex App ↔ Dashi browser thread handoff

## Status

This is an implementation handoff, not a completion report.

- Branch: `feat/windows-browser-mvp`
- Starting commit: `84c2827`
- Upstream baseline: `677b54451db707ae6132486b6593b7be11e4ee09`
- Goal: Codex App and Dashi use one task, one Codex thread ID, and one transcript.
- Current result: the browser conversation MVP remains; three prerequisite corrections are implemented. Binding, adoption, synchronization, conflict handling, quiescence gates, UI completion, and real acceptance remain unfinished.

## Product contract

Codex App is the primary entry. Dashi is the task board and optional browser conversation surface. Neither client may silently create a parallel conversation when the task already has a Codex thread.

Required round trip:

1. App writes A1 to thread `T`.
2. Dashi explicitly adopts `T` and imports only visible safe history.
3. Dashi writes B1 with exact `codex exec resume T`.
4. App opens `T`, sees A1+B1, and writes A2.
5. Dashi incrementally imports A2 without duplicating A1 or B1.

If exact identity, compatibility, or exclusive writing cannot be proven, browser writes fail closed. No fallback thread may be created.

## Confirmed repository facts

- `tasks.thread_id` and `comments.thread_id` are mutation-attribution fields, not stable bindings.
- `ai_chat_threads` already stores local and Codex thread IDs.
- `server/ai-chat-process.mjs` already builds explicit resume calls.
- `server/ai-chat.mjs` rejects a resumed run if Codex reports a different ID.
- Windows process-tree cleanup, worktree guard, normalized events, runs, and SSE exist.
- A task currently has one browser chat via `origin_issue_id`, but no authoritative task/Codex binding.
- Thread creation cannot adopt a supplied Codex ID.
- There is no App-history import, incremental sync, source idempotency, binding conflict state, or cross-client quiescence proof.
- The task detail primary action currently opens browser chat; App must become primary again, with browser chat separate.

## Capability findings

Observed locally on 2026-08-06/07:

- PATH CLI: `codex-cli 0.128.0`.
- App session metadata had previously been observed as `0.146.0-alpha.9.2`.
- `codex app-server --help` documents default `stdio://` and accepts `--listen stdio://`; old `--stdio` is absent.
- Generated experimental schemas include `thread/read { threadId, includeTurns }` and `userMessage`, `agentMessage`, `plan`, `commandExecution`, `fileChange`, `mcpToolCall`, and `webSearch` items.

These are observations, not an official compatibility guarantee. Local paths, rollout schemas, writer-lock behavior, and long-term cross-version compatibility are undocumented. A disposable capability probe is a release gate.

## Changes made after `84c2827`

Three prerequisite corrections are implemented:

1. App Server calls use `app-server --listen stdio://` in `server/ai-chat-catalog.mjs` and `server/app.mjs`.
2. Browser `read-only` maps to the actual Codex `read-only` sandbox in `server/ai-chat-process.mjs`.
3. Hidden `<taskboard_context>`/`<user_message>` wrappers and the automatic hidden taskboard skill prefix were removed. User input remains visible; appended issue/attachment context is visible and traceable.

The prompt correction stops injecting project IDs, names, and workspace paths as hidden user content. Later work may add explicit user-visible task context but must not recreate a hidden wrapper.

## Required architecture

### Persistence

Add an authoritative binding table:

```text
task_codex_bindings
  task_id              primary key, foreign key to tasks
  codex_thread_id      unique, required when bound
  state                adopting | active | conflict | unavailable | archived
  source               app | browser | promoted_browser
  workspace_path       expected absolute workspace
  version              optimistic concurrency version
  error                bounded public failure
  created_at / updated_at
```

Keep `tasks.thread_id` as audit attribution.

Extend browser records:

- `ai_chat_threads`: `task_bound`, `legacy_browser`, or `archived`; one active browser representation per task.
- `ai_chat_runs`: verified `codex_thread_id`; one local active run per Codex ID, not just local chat ID.
- `ai_chat_events`: monotonic `seq`, `source_turn_id`, `source_item_id`, `source_key`, `source_order`, `content_hash`; unique source keys make import idempotent.
- `ai_chat_sync_state`: last imported source key/order/sequence, successful sync time, and bounded error.

Migrate old browser-only conversations to `legacy_browser`. Never silently merge their transcripts into a different App thread.

### Experimental App Server adapter

Create a small isolated module that starts short-lived `codex app-server --listen stdio://`, initializes, calls `thread/read(includeTurns=true)` for an exact ID, verifies the returned ID, normalizes approved visible items, caps response/error size, and terminates the whole process tree. Never store full responses or JSONL.

Visible-item policy:

- Keep `userMessage`, `agentMessage`, and `plan` text.
- Commands: bounded command, status, exit status, cleaned summary; no unrestricted output.
- File changes: path and operation only; no full diff.
- MCP: server, tool, status only; drop arguments/results.
- Keep bounded web-search and safety/error summaries.
- Drop reasoning, system/developer content, hook/hidden prompts, raw protocol messages, and unknown sensitive payloads.

### Service/API contract

Recommended endpoints:

- `GET /api/tasks/:taskId/ai-binding`
- `POST /api/tasks/:taskId/ai-binding/adopt`
- `POST /api/tasks/:taskId/ai-binding/resolve-conflict`
- `POST /api/tasks/:taskId/ai-sync`
- `GET /api/local/ai/threads/:id/events?afterSeq=N`

Adopt receives an expected ID but verifies it with App Server and workspace checks before committing. Turn submission accepts only a local chat ID, resolves the authoritative server binding, and uses that exact Codex ID. A client-supplied ID must never select the resume target.

SSE emits hints such as `ai.binding`, `ai.sync`, `ai.event`, and `ai.run` with max sequence. Recovery always uses `afterSeq`; SSE alone is not authoritative.

### Conflict rules

- App ID plus different legacy-browser ID: `conflict`; default keeps App and archives browser transcript read-only.
- Only legacy browser candidate: explicit promotion only after read/resume validation.
- Neither has an ID: first browser turn may atomically create and bind one ID.
- Missing, unreadable, incompatible, busy, or mismatched ID: `unavailable`; writes disabled.
- Never merge transcripts across different Codex root IDs.

### Write safety and quiescence

Use a mutex keyed by authoritative `codex_thread_id`, then:

1. Acquire/check worktree guard.
2. Read thread via App Server and reject active/busy state.
3. Confirm relevant Dashi chat PIDs and descendants exited.
4. Observe session file until consecutive events/stats are stable and no writer lock exists; no fixed sleep.
5. Re-check Git branch, HEAD, dirty state, and operation locks.
6. Run exact `codex exec resume <id>`.
7. Busy, lock, version, missing ID, and ID mismatch are terminal; never fall back to creation.
8. On completion wait for process-tree exit, terminal event, session stability, lock release, and final Git state.

Worktree guard needs controlled rebaseline after a verified same-thread App write is complete and quiet. Other/unexplained changes still block. App lock/session behavior is undocumented; if a reliable release predicate cannot be proved, browser writing remains disabled with a clear error.

### UI contract

- Restore primary action to “Open in Codex App”.
- Add distinct “Continue in browser”.
- Show unbound, adopting, synchronized, syncing, conflict, busy, unavailable, and legacy archive states.
- Require explicit conflict action; never auto-promote or auto-merge.
- Refresh/sync by sequence and report fail-closed errors.
- Do not claim complete handoff before real acceptance.

## Implementation sequence

1. Disposable compatibility and mutual-exclusion probe; record go/no-go evidence.
2. App Server reader and visible-event normalizer with fixtures.
3. DB migration, constraints, binding transactions, idempotent imports.
4. Binding/adopt/sync/conflict APIs and sequence recovery.
5. Exact-ID mutex, quiescence gate, and guarded rebaseline.
6. App-first UI plus separate browser action/status.
7. Unit/integration/server/typecheck/build and real E2E.
8. Update `windows-browser-mode.md` with verified behavior, rollback, and undocumented risks.

## Verification matrix

Automated coverage:

- normal/empty import and every allowed visible type;
- reasoning/hidden/raw/diff/MCP payload rejection;
- malformed/oversized App Server response;
- missing/mismatched IDs;
- repeated sync has zero duplicates;
- incremental sync imports only new items;
- binding uniqueness and one active run per Codex ID;
- legacy/App conflict and explicit resolution;
- real read-only and App Server arguments;
- active App/browser writer fails closed;
- Git/worktree changes and same-thread rebaseline;
- restart recovery with `afterSeq`.

Required real acceptance in a disposable repository/worktree/task:

1. App writes A1 and yields `T`; wait for observable quiescence.
2. Browser adopts `T` and imports safe A1 events.
3. Verify no reasoning, hidden prompt, raw JSONL, MCP arguments/results, or full diff stored.
4. Browser writes B1 via exact resume `T`.
5. App opens `T`, sees A1+B1, and writes A2.
6. Browser asks after last seq and receives only A2-related additions.
7. Repeat sync and prove no duplicates.
8. Exercise both concurrent-writer negatives; prove no overlapping writer PIDs/worktree writes.
9. Prove every ID equals `T` and no parallel root thread exists.

## Test evidence and environment limitation

A narrowed Node test was attempted. In the managed Windows sandbox, the Node test runner tried to spawn each test file and all 40 launches failed with `spawn EPERM` before assertions ran. This is an environment/process-creation failure, not a pass and not a product assertion failure.

The generated protocol schema directory was removed. No Codex App database/session file was modified.

Next developer should rerun outside the restrictive process sandbox:

```powershell
npm run typecheck
npm run build
node --test test/ai-chat-database.test.mjs test/ai-chat-runner.test.mjs test/ai-chat-server.test.mjs test/ai-chat-ui.test.mjs test/worktree-guard.test.mjs
npm test
```

Distinguish assertion failures from `spawn EPERM`; do not reuse old pass counts.

## Rollback

Before migration release, normal branch/file revert is sufficient. After migration, preserve events and mark old threads `legacy_browser`; do not delete transcripts or rewrite Codex sessions. A feature flag may disable adoption/sync/browser writes while leaving App deep links and archives readable. Never edit Codex App storage to roll back.

## Next-agent checklist

1. Read root `AGENTS.md`, this file, and `windows-browser-mode.md`.
2. Confirm branch, HEAD, dirty state; preserve current changes.
3. Review the three prerequisite diffs.
4. Start with disposable capability probe and record evidence.
5. Keep App Server reader isolated.
6. Implement authoritative binding/idempotent import before UI claims.
7. Never trust a client ID as the resume target.
8. Never create fallback after adopt/resume failure.
9. Never modify Codex App storage directly.
10. Do not mark complete without App → browser → App → browser acceptance.

### Latest verification (2026-08-07)

Run outside the managed process sandbox:

- `npm run typecheck`: passed.
- `npm run build:web`: passed; 469 modules transformed. Vite emitted only the existing large-chunk warning.
- Server syntax checks for the three changed modules: passed.
- `git diff --check`: passed before the documentation update.
- Targeted Node suite (`ai-chat-database`, `ai-chat-runner`, `ai-chat-server`, `ai-chat-ui`, `worktree-guard`): 21 tests discovered, 18 passed, 3 failed.

The three failures match previously handed-off baseline contract gaps and are not evidence of the shared-thread feature working:

1. Runner catalog assertion expects a compact skill object but implementation also returns empty `description` and `path`.
2. Server invalid-skill case expects `INVALID_SKILL` but receives `INVALID_FIELD` earlier in request validation.
3. UI test cannot import the pre-existing missing `insertSkillMention` export.

No real Codex App ↔ browser round trip has passed. The feature remains incomplete.

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

## 真实接力证据（2026-08-07，BLOCKED）

本节记录真实机器上的验收尝试，不是完成功能声明。

### 仓库状态核对

```text
git branch --show-current
feat/windows-browser-mvp

git rev-parse HEAD
196515620b2208bdc0e39cbba353b7f51b208694

git status --porcelain=v2 --untracked-files=all
<empty>
```

用户交接声称未提交的以下实现文件和修改，在实际工作区中不存在：

- `server/ai-chat-binding.mjs`
- `server/codex-app-server.mjs`
- `test/ai-chat-binding.test.mjs`
- `task_codex_bindings`、`assertBrowserWriteAllowed`、`browserWriteEnabled`、绑定/同步 HTTP 路由

进一步检查 `git stash list`、`git reflog`、`git worktree list` 以及整个 `dashi-taskboard-windows` 目录，也没有找到这些遗失改动。当前 HEAD 仍只有原始浏览器 AI MVP 和前一次交接文档/三项基础修正。

### 前置命令与真实响应

```text
> codex --version
codex-cli 0.128.0

> node server/index.mjs
Codex Taskboard listening on http://127.0.0.1:47823

> curl.exe -sS -i http://127.0.0.1:47823/health
HTTP/1.1 200 OK
content-type: application/json; charset=utf-8

{"status":"ok"}

> curl.exe -sS -i http://127.0.0.1:47823/api/tasks/e2e-missing/ai-binding
HTTP/1.1 404 Not Found
content-type: application/json; charset=utf-8

{"error":{"code":"NOT_FOUND","message":"API route not found"}}
```

验收服务进程 PID `15808` 已在取证后停止，结果为 `SERVER_STOPPED`。

### 阻塞判断

第一个必需的绑定读取端点即返回 404，说明权威绑定/adopt/sync 实现没有进入当前工作树。此状态下继续创建 A1/T 并调用旧浏览器写入口，只会验证旧的 browser-first 路径，并存在创建平行 root thread 的风险；这违反本次验收的同线程约束。因此没有创建 T、没有运行 B1/A2，也没有修改 Codex App session/database 文件。

没有真实 T，故无法提供伪造的 thread ID、事件列表、互斥证明或状态目录“只有 T”的证明。浏览器写入口的 App/CLI 互斥也无法进入验证阶段；本次结论是“无法证明”，但根因是验收所需实现完全缺失，而不是已实现门禁的锁语义失败。当前代码也不存在交接所述 `browserWriteEnabled` 配置面；按照“只做验收、不要重复实现”的约束，本次没有擅自重写功能。

### 十步结果

| 步骤 | 结果 | 真实证据/原因 |
| --- | --- | --- |
| 1. App 写 A1 并取得 T | BLOCKED | 绑定入口缺失；继续会冒险制造无法绑定的孤立 thread，故未创建 T |
| 2. 浏览器 adopt T | BLOCKED | `GET .../ai-binding` 已返回 404；POST adopt 路由不存在 |
| 3. 浏览器 B1 精确 resume T | BLOCKED | 无权威绑定和 adopt 结果，不能安全调用旧写入口 |
| 4. App Server 读到 A1+B1 | BLOCKED | 无 T/B1 |
| 5. App 对 T 写 A2 | BLOCKED | 无 T |
| 6. afterSeq 只新增 A2 | BLOCKED | `ai-sync`/`afterSeq` 实现不在工作树 |
| 7. App 活跃时浏览器 fail closed | BLOCKED | `assertBrowserWriteAllowed` 不在工作树，无法证明互斥 |
| 8. 浏览器活跃时另一写入 fail closed | BLOCKED | 同上，无法证明互斥 |
| 9. 全程 ID 一致 | BLOCKED | 未创建 T，不能声称一致 |
| 10. 无平行 root thread | BLOCKED | 为避免污染未创建任何验收 thread；不能提供“只有 T”证据 |
| 隐私复核 | BLOCKED | adopt/sync 事件响应不存在，无法对真实响应执行隐私断言 |

### 根因与下一步

根因是验收输入所描述的未提交实现没有存在于指定仓库、任何 stash、reflog 或邻近 worktree。下一位开发者必须先找回或重新应用那批实现，至少让绑定 GET/POST、sync、afterSeq、服务端精确绑定写入口以及 quiescence 门禁出现在 `git diff` 中，再从本节前置检查重新开始。找回前不要用旧 browser-first 写入口代替同线程验收。

### Fail-closed addendum

Because steps 7/8 could not be proven and the old browser-first turn route remained writable, the HTTP service is now instantiated with `browserWriteEnabled: false`. `AiChatService.startTurn` checks this gate before resolving or spawning a thread.

Real response after the change:

```text
> POST /api/local/ai/threads/e2e-missing/turns
> Content-Type: application/json
> {"message":"should be blocked"}

HTTP/1.1 409 Conflict
{"error":{"code":"BROWSER_WRITE_BLOCKED","message":"Browser writes are disabled until same-thread mutual exclusion is proven"}}
```

No Codex process was spawned and no thread was created by this request. Steps 7/8 remain BLOCKED as mutual-exclusion proofs, but the required safe operational outcome is active: browser writes fail closed until the missing binding/quiescence implementation is recovered and verified.

## Implementation recovered (commit `c5a200a`)

The missing implementation referenced by the blocked acceptance run above has been recovered and landed on `feat/windows-browser-mvp` as commit `c5a200a`, layered on top of `0a85feb`. The binding GET/POST routes, sync, `afterSeq`, server-side authoritative binding, quiescence gate, and conflict handling now exist in `git diff` against the upstream baseline.

### Landed surface

| File | Role |
|---|---|
| `server/ai-chat-binding.mjs` | `adopt` / `sync` / `resolveConflict`; cross-client write quiescence gate (`assertBrowserWriteAllowed`); conflict detection; never falls back to a new thread |
| `server/codex-app-server.mjs` | Short-lived App Server reader + visible-event normalizer (drops reasoning / system / developer / raw JSONL / full MCP args+results / full command output / full diff) |
| `server/database.mjs` | `task_codex_bindings` + `ai_chat_sync_state` tables; `seq` / `source_key` / `content_hash` columns; `importAiChatEvents`; `afterSeq` listing |
| `server/app.mjs` | `GET/POST /api/tasks/:id/ai-binding`, `POST .../adopt`, `POST .../resolve-conflict`, `POST .../ai-sync`; `afterSeq` on events; `browserWriteEnabled` overridable, defaults to `false` |
| `server/ai-chat.mjs` | Integrates the binding service; retains the `0a85feb` top-of-`startTurn` fail-closed gate |
| `test/ai-chat-binding.test.mjs` | 19 tests: normalizer, uniqueness, idempotent sync, conflict, fail-closed, afterSeq, binding state |

### Fail-closed by design (BLOCKED conclusion preserved)

Per the spec's blocking rule, when same-thread mutual exclusion against the real Codex App/CLI cannot be proven, browser writes stay disabled:

- `createTaskboardServer` defaults `browserWriteEnabled: false` → every browser turn returns `409 BROWSER_WRITE_BLOCKED` at the top of `startTurn`, before resolving a thread or spawning a Codex process. No new thread is created.
- `adopt` / `sync` / `afterSeq` / binding-state reads remain fully functional on the read-only import path (no Codex write).
- When mutual exclusion becomes provable, set `browserWriteEnabled: true`; task-bound threads then pass through the full `assertBrowserWriteAllowed` gate (mutex + quiescence probe + worktree guard).

`0a85feb` had corrupted the `actorFromRequest` fallback name (`"本地用户"` → `"鏈湴鐢ㄦ埛"`); `c5a200a` restores the correct UTF-8.

### Automated verification (development sandbox)

| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run build` | pass |
| `node --check` on all 5 server files | pass |
| `test/ai-chat-binding.test.mjs` (19) | 19/19 pass |
| full suite | 370 tests, 351 pass, 19 fail |
| regression vs baseline `1965156` | failing set byte-identical after stripping timings → zero new regressions |

The 19 failures are the pre-existing baseline (including the 3 AI contract failures recorded in the handoff doc), not regressions from this work.

### Real App↔browser acceptance: still BLOCKED

The development sandbox has no `codex` CLI, so the 10-step real handoff cannot be executed here. The implementation and automated tests are ready; the 10-step acceptance must be re-run on a Windows host with a real Codex App/CLI, starting from the prerequisite checks in the "真实接力证据" section above. Browser writes remain disabled until that acceptance proves mutual exclusion.

## 真实接力复测（2026-08-07，`edf1160`）

修复提交进入分支后，在真实 Windows 主机复测：

- `test/ai-chat-binding.test.mjs`：19/19 PASS。
- TypeScript 类型检查与五个服务端模块语法检查：PASS。
- Codex CLI：`0.128.0`。
- 临时单命令覆盖 `service_tier=fast` 后生成 T：`019fdc2b-e2c8-7bb1-86c4-6939ce2b22e0`；未修改用户配置。
- A1：FAIL。CLI 报告 `gpt-5.6-sol` 需要更新版 Codex，turn.failed。
- Adopt：BLOCKED。精确 adopt T 返回 409 `ADOPT_UNAVAILABLE` / `spawn EPERM`。
- 失败状态安全：binding 保留精确 T，state=`unavailable`，thread=`null`，没有 fallback 浏览器线程。
- Sync：404 `AI_CHAT_THREAD_NOT_FOUND`（adopt 未生成浏览器线程）。
- B1：409 `BROWSER_WRITE_BLOCKED`，没有启动 Codex 写进程。
- 互斥：无法证明，生产写入口继续禁用。
- 完整十步：BLOCKED。

隐私复核发现 FAIL：`normalizeAppServerTurnItem` 会把 `commandExecution.aggregatedOutput/output` 原样放入 `data.output`（最多 65,536 字符）。真实函数复现中 `SECRET_FULL_COMMAND_OUTPUT` 完整出现在规范化结果里，违反“不保存完整命令输出”的规则；现有 19 项测试反而断言保留 `output`，需要修正实现和测试。

GitHub fork 已关闭 Issues，因此无法在 `a905818999-del/dashi-taskboard` 创建 issue。复测结果已通知下一位开发者：

- PR 评论：https://github.com/a905818999-del/dashi-taskboard/pull/1#issuecomment-5217059221

尝试向不同的上游仓库创建 issue 被安全策略阻止，未绕过。若需正式 issue，仓库所有者应开启 fork 的 Issues，或明确授权将 fork 测试结果发送到指定上游仓库。

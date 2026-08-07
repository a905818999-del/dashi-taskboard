// Authoritative Codex thread binding, idempotent history import, conflict
// handling, and the cross-client write quiescence gate for the browser.
//
// The Codex App owns the thread. The browser only adopts an exact, verified
// Codex thread id, imports a safe normalized projection of the visible
// history, and — only when quiescence can be proven — writes back via
// `codex exec resume <id>`. Any unproven compatibility, busy, lock, id, or
// quiescence state fails closed. Adopt/resume failure never falls back to a
// new thread.

import { ApiError } from "./database.mjs";
import { readCodexThread } from "./codex-app-server.mjs";
import { acquireWorktreeGuard, inspectWorktree } from "./worktree-guard.mjs";

const BINDING_STATES = new Set(["adopting", "active", "conflict", "unavailable", "archived"]);
const RESOLVE_ACTIONS = new Set(["keep_app", "promote_browser"]);
const ERROR_LIMIT = 65_536;

function capError(value) {
  const message = value instanceof Error ? value.message : String(value ?? "");
  return message.slice(0, ERROR_LIMIT);
}

function requireActiveTask(database, taskId) {
  const task = database.getTask(taskId);
  if (!task) {
    throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
  }
  if (task.archivedAt) {
    throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks cannot adopt a Codex thread");
  }
  return task;
}

function requireCodexThreadId(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || value.includes("\0")) {
    throw new ApiError(400, "INVALID_CODEX_THREAD_ID", "A valid Codex thread id is required");
  }
  return value.trim();
}

// Stable, public projection of a binding for API responses. Never exposes
// internal version counters beyond what clients need for optimistic concurrency.
function publicBinding(binding, extras = {}) {
  if (!binding) return null;
  return {
    taskId: binding.taskId,
    codexThreadId: binding.codexThreadId,
    state: binding.state,
    source: binding.source,
    workspacePath: binding.workspacePath,
    version: binding.version,
    error: binding.error,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
    ...extras,
  };
}

export class AiChatBindingService {
  constructor(options) {
    this.database = options.database;
    this.codexExecutable = options.codexExecutable;
    this.codexStatePath = options.codexStatePath;
    this.processEnv = options.processEnv ?? process.env;
    // Injectable for tests; production uses the real short-lived App Server.
    this.readThread = options.readThread ?? readCodexThread;
    // Master switch. When false, every browser write fails closed with a
    // clear BLOCKED error. Used when the environment cannot reliably prove
    // quiescence (e.g. codex CLI missing, undocumented App lock semantics).
    this.browserWriteEnabled = options.browserWriteEnabled ?? true;
    this.listeners = options.listeners ?? new Set();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #emit(event) {
    for (const listener of this.listeners) {
      try { listener(event); } catch {}
    }
  }

  // Read the current binding for a task plus the local browser thread (if any)
  // and the legacy-browser conflict signal. This is the read-only state the UI
  // uses to render unbound/adopting/active/conflict/unavailable/legacy.
  getBindingState(taskId) {
    requireActiveTask(this.database, taskId);
    const binding = this.database.getTaskCodexBinding(taskId);
    const thread = this.database.getAiChatThreadForIssue(taskId) ?? null;
    const legacyThread = thread && thread.lifecycle === "legacy_browser" ? thread : null;
    const activeRunForThread = thread?.currentRun ?? null;
    let conflictingLegacyId = null;
    if (legacyThread?.codexThreadId && binding?.codexThreadId
        && legacyThread.codexThreadId !== binding.codexThreadId) {
      conflictingLegacyId = legacyThread.codexThreadId;
    }
    return {
      binding: publicBinding(binding),
      thread,
      legacyThread,
      conflictingLegacyId,
      activeRunForThread,
      browserWriteEnabled: this.browserWriteEnabled,
    };
  }

  // Explicitly adopt an App-owned Codex thread id. The id is verified via the
  // short-lived App Server before the binding is committed. Visible history is
  // imported idempotently. Never falls back to a new thread.
  async adopt(taskId, input = {}) {
    requireActiveTask(this.database, taskId);
    const codexThreadId = requireCodexThreadId(input.codexThreadId);
    const existing = this.database.getTaskCodexBinding(taskId);

    // Conflict: another Codex thread is already bound to this task.
    if (existing && existing.codexThreadId && existing.codexThreadId !== codexThreadId) {
      const conflictBinding = this.database.updateTaskCodexBinding(existing.taskId, existing.version, {
        state: "conflict",
        error: `Bound Codex thread '${existing.codexThreadId}' differs from adopt id '${codexThreadId}'`,
      });
      this.#emit({ type: "ai.binding", taskId, binding: conflictBinding });
      throw new ApiError(409, "BINDING_CONFLICT", "A different Codex thread is already bound to this task", {
        binding: publicBinding(conflictBinding),
      });
    }

    // Conflict: the codex thread id is bound to a different task. Record the
    // conflict on this task WITHOUT claiming the codex_thread_id (uniqueness
    // is authoritative: one codex thread maps to at most one task). The local
    // row uses codexThreadId=null so the owning binding is untouched.
    const otherBinding = this.database.getTaskCodexBindingByCodexThread(codexThreadId);
    if (otherBinding && otherBinding.taskId !== taskId) {
      const errorMessage = `Codex thread '${codexThreadId}' is bound to task '${otherBinding.taskId}'`;
      const conflictBinding = existing
        ? this.database.updateTaskCodexBinding(existing.taskId, existing.version, {
            state: "conflict",
            codexThreadId: null,
            error: errorMessage,
          })
        : this.database.createTaskCodexBinding({
            taskId,
            codexThreadId: null,
            state: "conflict",
            source: input.source ?? "browser",
            error: errorMessage,
          });
      this.#emit({ type: "ai.binding", taskId, binding: conflictBinding });
      throw new ApiError(409, "BINDING_CONFLICT", `Codex thread '${codexThreadId}' is bound to another task`, {
        binding: publicBinding(conflictBinding),
      });
    }

    const workspacePath = typeof input.workspacePath === "string" && input.workspacePath.trim()
      ? input.workspacePath.trim()
      : null;

    // Mark adopting (or update existing adopting/active row) before the
    // network probe so concurrent callers see the in-flight state.
    const adopting = existing
      ? this.database.updateTaskCodexBinding(existing.taskId, existing.version, {
          codexThreadId,
          state: "adopting",
          workspacePath: workspacePath ?? existing.workspacePath,
          error: null,
        })
      : this.database.createTaskCodexBinding({
          taskId,
          codexThreadId,
          state: "adopting",
          source: input.source ?? "browser",
          workspacePath,
        });
    this.#emit({ type: "ai.binding", taskId, binding: adopting });

    let readResult;
    try {
      readResult = await this.readThread({
        codexExecutable: this.codexExecutable,
        codexThreadId,
        workspacePath: adopting.workspacePath ?? workspacePath,
        processEnv: this.processEnv,
      });
    } catch (error) {
      const unavailable = this.database.updateTaskCodexBinding(adopting.taskId, adopting.version, {
        state: "unavailable",
        error: capError(error),
      });
      this.#emit({ type: "ai.binding", taskId, binding: unavailable });
      throw new ApiError(409, "ADOPT_UNAVAILABLE", capError(error), {
        binding: publicBinding(unavailable),
      });
    }

    if (readResult.threadId !== codexThreadId) {
      // The reader verifies this itself, but defend in depth. Never fall back.
      const unavailable = this.database.updateTaskCodexBinding(adopting.taskId, adopting.version, {
        state: "unavailable",
        error: "App Server returned a different thread id",
      });
      this.#emit({ type: "ai.binding", taskId, binding: unavailable });
      throw new ApiError(409, "ADOPT_UNAVAILABLE", "App Server returned a different thread id", {
        binding: publicBinding(unavailable),
      });
    }

    // Resolve the local browser thread for this task. A legacy_browser thread
    // that carries a different codex thread id is a conflict: do not merge.
    let thread = this.database.getAiChatThreadForIssue(taskId);
    if (thread && thread.lifecycle === "legacy_browser" && thread.codexThreadId
        && thread.codexThreadId !== codexThreadId) {
      const conflictBinding = this.database.updateTaskCodexBinding(adopting.taskId, adopting.version, {
        state: "conflict",
        error: `Legacy browser thread '${thread.codexThreadId}' differs from adopt id '${codexThreadId}'`,
      });
      this.#emit({ type: "ai.binding", taskId, binding: conflictBinding });
      throw new ApiError(409, "BINDING_CONFLICT", "Legacy browser thread has a different Codex thread id", {
        binding: publicBinding(conflictBinding),
      });
    }

    if (!thread) {
      // No local browser representation yet. Create a task_bound placeholder
      // tied to the verified Codex thread. The browser UI opens this thread.
      const task = this.database.getTask(taskId);
      thread = this.database.createAiChatThread({
        title: task?.identifier ?? "Adopted conversation",
        status: "idle",
        lifecycle: "task_bound",
        origin: {
          projectId: task?.projectId ?? "local",
          projectName: "Local",
          workspacePath: adopting.workspacePath ?? workspacePath ?? "",
          issueId: taskId,
          issueIdentifier: task?.identifier,
        },
        codexThreadId,
        model: input.model ?? "",
        reasoningEffort: input.reasoningEffort ?? "",
        sandbox: input.sandbox ?? "read-only",
      });
    } else if (thread.codexThreadId !== codexThreadId) {
      thread = this.database.updateAiChatThread(thread.id, {
        codexThreadId,
        lifecycle: thread.lifecycle === "legacy_browser" ? "task_bound" : thread.lifecycle,
      });
    }

    const inserted = this.database.importAiChatEvents(thread.id, readResult.events);
    const lastEvent = inserted.length > 0 ? inserted[inserted.length - 1] : null;
    const syncState = this.database.upsertAiChatSyncState(thread.id, {
      lastSourceKey: lastEvent?.sourceKey ?? null,
      lastSourceOrder: lastEvent?.sourceOrder ?? null,
      lastSeq: lastEvent?.seq ?? 0,
      error: null,
    });

    const active = this.database.updateTaskCodexBinding(adopting.taskId, adopting.version, {
      state: "active",
      error: null,
    });
    this.#emit({ type: "ai.binding", taskId, binding: active });
    this.#emit({ type: "ai.sync", taskId, threadId: thread.id, inserted: inserted.length, syncState });
    return {
      binding: publicBinding(active),
      thread,
      inserted,
      syncState,
    };
  }

  // Incremental sync. Reads the App thread again and imports only events whose
  // source_key is not already present. afterSeq recovery uses the same path.
  async sync(taskId) {
    requireActiveTask(this.database, taskId);
    const binding = this.database.getTaskCodexBinding(taskId);
    if (!binding || !binding.codexThreadId) {
      throw new ApiError(409, "NOT_BOUND", "Task has no bound Codex thread to sync");
    }
    if (binding.state === "conflict") {
      throw new ApiError(409, "BINDING_CONFLICT", "Resolve the binding conflict before syncing", {
        binding: publicBinding(binding),
      });
    }
    const thread = this.database.getAiChatThreadForIssue(taskId);
    if (!thread) {
      throw new ApiError(404, "AI_CHAT_THREAD_NOT_FOUND", "No browser thread for this task");
    }

    let readResult;
    try {
      readResult = await this.readThread({
        codexExecutable: this.codexExecutable,
        codexThreadId: binding.codexThreadId,
        workspacePath: binding.workspacePath ?? thread.origin.workspacePath,
        processEnv: this.processEnv,
      });
    } catch (error) {
      const unavailable = this.database.updateTaskCodexBinding(binding.taskId, binding.version, {
        state: "unavailable",
        error: capError(error),
      });
      this.database.upsertAiChatSyncState(thread.id, { error: capError(error) });
      this.#emit({ type: "ai.binding", taskId, binding: unavailable });
      throw new ApiError(409, "SYNC_UNAVAILABLE", capError(error), {
        binding: publicBinding(unavailable),
      });
    }

    if (readResult.threadId !== binding.codexThreadId) {
      const conflict = this.database.updateTaskCodexBinding(binding.taskId, binding.version, {
        state: "conflict",
        error: "App Server returned a different thread id during sync",
      });
      this.#emit({ type: "ai.binding", taskId, binding: conflict });
      throw new ApiError(409, "BINDING_CONFLICT", "App Server returned a different thread id during sync", {
        binding: publicBinding(conflict),
      });
    }

    const inserted = this.database.importAiChatEvents(thread.id, readResult.events);
    const lastEvent = inserted.length > 0 ? inserted[inserted.length - 1] : null;
    const previousSync = this.database.getAiChatSyncState(thread.id);
    const syncState = this.database.upsertAiChatSyncState(thread.id, {
      lastSourceKey: lastEvent?.sourceKey ?? previousSync?.lastSourceKey ?? null,
      lastSourceOrder: lastEvent?.sourceOrder ?? previousSync?.lastSourceOrder ?? null,
      lastSeq: lastEvent?.seq ?? previousSync?.lastSeq ?? 0,
      error: null,
    });
    this.#emit({ type: "ai.sync", taskId, threadId: thread.id, inserted: inserted.length, syncState });
    return {
      binding: publicBinding(this.database.getTaskCodexBinding(taskId)),
      thread,
      inserted,
      syncState,
    };
  }

  // Explicit conflict resolution. `keep_app` archives the legacy browser
  // transcript (read-only). `promote_browser` re-verifies the browser's id via
  // App Server before rebinding. Never auto-merges transcripts.
  async resolveConflict(taskId, { action }) {
    requireActiveTask(this.database, taskId);
    if (!RESOLVE_ACTIONS.has(action)) {
      throw new ApiError(400, "INVALID_ACTION", "action must be 'keep_app' or 'promote_browser'");
    }
    const binding = this.database.getTaskCodexBinding(taskId);
    if (!binding || binding.state !== "conflict") {
      throw new ApiError(409, "NOT_CONFLICT", "Binding is not in a conflict state");
    }
    const thread = this.database.getAiChatThreadForIssue(taskId);

    if (action === "keep_app") {
      // Archive the legacy browser transcript read-only; keep the App binding.
      if (thread && thread.lifecycle === "legacy_browser") {
        this.database.updateAiChatThread(thread.id, { lifecycle: "archived" });
      }
      const resolved = this.database.updateTaskCodexBinding(binding.taskId, binding.version, {
        state: binding.codexThreadId ? "active" : "unavailable",
        error: null,
      });
      this.#emit({ type: "ai.binding", taskId, binding: resolved });
      return { binding: publicBinding(resolved), thread };
    }

    // promote_browser: re-verify the browser's codex thread id via App Server
    // before rebinding. If the browser thread has no codex id, this fails.
    const browserCodexId = thread?.codexThreadId;
    if (!browserCodexId) {
      const still = this.database.updateTaskCodexBinding(binding.taskId, binding.version, {
        state: "conflict",
        error: "Legacy browser thread has no Codex thread id to promote",
      });
      throw new ApiError(409, "BINDING_CONFLICT", "Legacy browser thread has no Codex thread id to promote", {
        binding: publicBinding(still),
      });
    }
    try {
      const readResult = await this.readThread({
        codexExecutable: this.codexExecutable,
        codexThreadId: browserCodexId,
        workspacePath: binding.workspacePath ?? thread.origin.workspacePath,
        processEnv: this.processEnv,
      });
      if (readResult.threadId !== browserCodexId) {
        throw new Error("App Server returned a different thread id");
      }
      const resolved = this.database.updateTaskCodexBinding(binding.taskId, binding.version, {
        codexThreadId: browserCodexId,
        state: "active",
        source: "promoted_browser",
        error: null,
      });
      if (thread && thread.lifecycle === "legacy_browser") {
        this.database.updateAiChatThread(thread.id, { lifecycle: "task_bound" });
      }
      this.database.importAiChatEvents(thread.id, readResult.events);
      this.#emit({ type: "ai.binding", taskId, binding: resolved });
      return { binding: publicBinding(resolved), thread };
    } catch (error) {
      const unavailable = this.database.updateTaskCodexBinding(binding.taskId, binding.version, {
        state: "unavailable",
        error: capError(error),
      });
      this.#emit({ type: "ai.binding", taskId, binding: unavailable });
      throw new ApiError(409, "PROMOTE_UNAVAILABLE", capError(error), {
        binding: publicBinding(unavailable),
      });
    }
  }

  // The cross-client write quiescence gate. Called by AiChatService.startTurn
  // before a browser turn is allowed to resume a Codex thread. Every check
  // must be provable; any unproven state fails closed. Never falls back.
  //
  // Returns the verified binding + thread on success. Throws an ApiError on
  // any failure, with a code that the UI can map to a clear message.
  async assertBrowserWriteAllowed(taskId) {
    if (!this.browserWriteEnabled) {
      throw new ApiError(409, "BROWSER_WRITE_BLOCKED",
        "Browser writing is disabled: quiescence cannot be proven in this environment");
    }
    requireActiveTask(this.database, taskId);
    const binding = this.database.getTaskCodexBinding(taskId);
    if (!binding || !binding.codexThreadId) {
      throw new ApiError(409, "NOT_BOUND", "Task has no bound Codex thread");
    }
    if (binding.state !== "active") {
      throw new ApiError(409, "BINDING_NOT_ACTIVE",
        `Binding is '${binding.state}', not 'active'`, { binding: publicBinding(binding) });
    }
    const thread = this.database.getAiChatThreadForIssue(taskId);
    if (!thread) {
      throw new ApiError(404, "AI_CHAT_THREAD_NOT_FOUND", "No browser thread for this task");
    }
    if (thread.codexThreadId !== binding.codexThreadId) {
      throw new ApiError(409, "BINDING_MISMATCH",
        "Local thread codex id does not match the authoritative binding");
    }

    // Mutex: no other run (this client or any other tracked run) may be
    // active for this Codex thread id.
    if (this.database.hasActiveRunForCodexThread(binding.codexThreadId)) {
      throw new ApiError(409, "CODEX_THREAD_BUSY",
        "Another run is already active for this Codex thread");
    }
    if (thread.currentRun) {
      throw new ApiError(409, "THREAD_BUSY", "This browser thread already has a running turn");
    }

    // Quiescence probe: re-read the App thread and reject if it reports an
    // active/busy state. The reader itself verifies the id. If the codex CLI
    // is unavailable this fails closed with ADOPT_UNAVAILABLE.
    let readResult;
    try {
      readResult = await this.readThread({
        codexExecutable: this.codexExecutable,
        codexThreadId: binding.codexThreadId,
        workspacePath: binding.workspacePath ?? thread.origin.workspacePath,
        processEnv: this.processEnv,
      });
    } catch (error) {
      throw new ApiError(409, "QUIESCENCE_UNPROVEN", capError(error));
    }
    if (readResult.threadId !== binding.codexThreadId) {
      throw new ApiError(409, "BINDING_MISMATCH",
        "App Server returned a different thread id during the quiescence probe");
    }
    if (readResult.busy === true) {
      throw new ApiError(409, "CODEX_THREAD_BUSY",
        "Codex App reports the thread is busy");
    }

    // Worktree guard for write sandboxes. Read-only sandbox skips the lock.
    const isWriteSandbox = thread.sandbox !== "read-only";
    let guard = null;
    if (isWriteSandbox && thread.origin.workspacePath) {
      try {
        guard = await acquireWorktreeGuard(thread.origin.workspacePath, thread.gitState);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(409, "QUIESCENCE_UNPROVEN", capError(error));
      }
    }

    return { binding, thread, guard, readResult };
  }

  // After a verified same-thread browser write completes, rebaseline the
  // worktree guard state so the next turn can prove a clean baseline. Called
  // by AiChatService when a run finishes. Other/unexplained changes still
  // block the next turn via acquireWorktreeGuard.
  async rebaselineAfterWrite(taskId, guard) {
    if (!guard) return null;
    const task = this.database.getTask(taskId);
    if (!task) return null;
    const thread = this.database.getAiChatThreadForIssue(taskId);
    if (!thread) return null;
    try {
      const gitState = await guard.release();
      this.database.updateAiChatThread(thread.id, {
        gitRoot: gitState.root,
        gitBranch: gitState.branch,
        gitHead: gitState.head,
        gitStatus: gitState.status,
      });
      return gitState;
    } catch (error) {
      // Rebaseline failure is not silent: mark the binding unavailable so the
      // next write fails closed until a human inspects.
      const binding = this.database.getTaskCodexBinding(taskId);
      if (binding) {
        this.database.updateTaskCodexBinding(binding.taskId, binding.version, {
          state: "unavailable",
          error: `Rebaseline failed: ${capError(error)}`,
        });
      }
      throw new ApiError(409, "REBASELINE_FAILED", capError(error));
    }
  }

  // Used by tests and the catalog to verify the codex executable is reachable
  // without performing a real adopt. Returns { ok, version, error }.
  async probeCapability(workspacePath) {
    try {
      const result = await this.readThread({
        codexExecutable: this.codexExecutable,
        codexThreadId: "00000000-0000-0000-0000-000000000000",
        workspacePath,
        processEnv: this.processEnv,
      });
      return { ok: true, error: null, threadId: result.threadId };
    } catch (error) {
      return { ok: false, error: capError(error) };
    }
  }
}

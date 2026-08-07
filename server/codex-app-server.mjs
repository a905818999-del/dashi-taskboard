// Short-lived Codex App Server adapter for read-only thread history import.
//
// The Codex App is the authoritative owner of a Codex thread. The browser only
// imports a safe, normalized projection of the visible history via the
// experimental `thread/read { threadId, includeTurns: true }` call. This module
// starts a disposable `codex app-server --listen stdio://` process, performs one
// read for an exact thread id, verifies the returned id, normalizes approved
// visible items, caps every response/error, and tears the whole process tree
// down. Full responses, raw JSONL, reasoning, hidden prompts, MCP arguments /
// results, command output and diffs are never returned to the caller.

import { spawn } from "node:child_process";

import { codexInvocation, codexSpawnOptions, resolveCodexExecutableCandidates, terminateProcessTree } from "./ai-chat-process.mjs";

const READ_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const VISIBLE_TEXT_LIMIT = 65_536;
const ALLOWED_ITEM_TYPES = new Set([
  "userMessage",
  "agentMessage",
  "plan",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "webSearch",
]);

function cap(value) {
  return typeof value === "string" ? value.slice(0, VISIBLE_TEXT_LIMIT) : "";
}

// Translate a spawn failure (EPERM/ENOENT/EACCES or a synchronous throw like
// ERR_INVALID_ARG_VALUE) into a clear, fail-closed error. We never bypass the
// OS lock or modify Codex App storage; the caller (binding service) marks the
// binding unavailable so the next adopt/sync fails closed with a precise
// reason.
function spawnError(error) {
  if (!error) return new Error("Codex app-server failed to start");
  if (error.code === "EPERM") {
    return new Error("Codex app-server spawn was denied by the OS (EPERM); the Codex App may hold a lock or the executable is not executable in this context");
  }
  if (error.code === "ENOENT") {
    return new Error("Codex app-server executable was not found (ENOENT)");
  }
  if (error.code === "EACCES") {
    return new Error("Codex app-server spawn was denied by permissions (EACCES)");
  }
  // Synchronous argument/permission failures (e.g. Windows EPERM surfaced as
  // ERR_INVALID_ARG_VALUE, or empty executable). Wrap so callers always see a
  // consistent, fail-closed message instead of a bare Node code.
  const detail = error.message ? `: ${String(error.message).slice(0, VISIBLE_TEXT_LIMIT)}` : "";
  return new Error(`Codex app-server failed to start${detail}`);
}

function itemId(item) {
  return cap(item.id);
}

function statusOf(item, fallback) {
  if (typeof item.status === "string" && item.status.trim()) return cap(item.status);
  return fallback;
}

// Extract a visible text string from a user/agent message item. The real Codex
// App Server returns userMessage items as `{ id, content }` where `content` is
// a list of user inputs (e.g. `{ type: "text", text }`, `{ type: "image", ... }`,
// `{ type: "localImage", ... }`). Older/flat shapes used `item.text` or
// `item.message` as a plain string. We try the real `content` container first
// (array → join the text parts; string → use directly), then fall back to the
// flat fields. Image/audio/skill/mention parts carry no visible text and are
// skipped. The result is always capped; never returns raw protocol payloads.
function extractContent(item) {
  const content = item.content;
  if (typeof content === "string") return cap(content);
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      // Text parts use `text` under variants {type:"text"} | {type:"input_text"}.
      const text = typeof part.text === "string" ? part.text : (typeof part.content === "string" ? part.content : "");
      if (text) parts.push(text);
    }
    return cap(parts.join("\n"));
  }
  return cap(item.text ?? item.message);
}

// Normalize a single App Server turn item into a safe visible event, or return
// null when the item must be dropped (reasoning, system/developer content,
// hidden prompts, raw protocol messages, unknown sensitive payloads).
export function normalizeAppServerTurnItem(item, context = {}) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const type = typeof item.type === "string" ? item.type : "";
  if (!ALLOWED_ITEM_TYPES.has(type)) return null;

  const turnId = cap(context.turnId);
  const sourceItemId = itemId(item);
  const sourceOrder = Number.isInteger(context.sourceOrder) ? context.sourceOrder : -1;
  const sourceKey = [turnId, sourceItemId || `idx${sourceOrder}`].filter(Boolean).join(":");

  const base = {
    type,
    sourceTurnId: turnId || null,
    sourceItemId: sourceItemId || null,
    sourceKey,
    sourceOrder,
  };

  if (type === "userMessage") {
    return {
      ...base,
      role: "user",
      content: extractContent(item),
      data: { status: "completed", ...(sourceItemId ? { itemId: sourceItemId } : {}) },
    };
  }

  if (type === "agentMessage") {
    return {
      ...base,
      role: "assistant",
      content: extractContent(item),
      data: { status: statusOf(item, "completed"), ...(sourceItemId ? { itemId: sourceItemId } : {}) },
    };
  }

  if (type === "plan") {
    const text = cap(item.text ?? item.summary);
    return {
      ...base,
      role: "assistant",
      content: text,
      data: { status: statusOf(item, "plan"), ...(sourceItemId ? { itemId: sourceItemId } : {}) },
    };
  }

  if (type === "commandExecution") {
    const command = cap(item.command);
    // Privacy: raw command output (aggregatedOutput/output) is never retained.
    // Only the command, status, and exit code are visible.
    return {
      ...base,
      role: "activity",
      content: command,
      data: {
        status: statusOf(item, "completed"),
        ...(sourceItemId ? { itemId: sourceItemId } : {}),
        ...(command ? { command } : {}),
        ...(Number.isInteger(item.exitCode) ? { exitCode: item.exitCode } : {}),
      },
    };
  }

  if (type === "fileChange") {
    const changes = Array.isArray(item.changes)
      ? item.changes.map((change) => ({
          path: cap(change?.path),
          kind: cap(change?.kind ?? change?.operation),
        })).filter((change) => change.path)
      : [];
    return {
      ...base,
      role: "activity",
      content: cap(changes.map((change) => change.path).join("\n")),
      data: {
        status: statusOf(item, "completed"),
        ...(sourceItemId ? { itemId: sourceItemId } : {}),
        files: changes,
      },
    };
  }

  if (type === "mcpToolCall") {
    const server = cap(item.server);
    const tool = cap(item.tool);
    return {
      ...base,
      role: item.error ? "error" : "activity",
      content: cap([server, tool].filter(Boolean).join(".")),
      data: {
        status: statusOf(item, item.error ? "failed" : "completed"),
        ...(sourceItemId ? { itemId: sourceItemId } : {}),
        ...(server ? { server } : {}),
        ...(tool ? { tool } : {}),
      },
    };
  }

  if (type === "webSearch") {
    const query = cap(item.query);
    return {
      ...base,
      role: "activity",
      content: query,
      data: {
        status: statusOf(item, "completed"),
        ...(sourceItemId ? { itemId: sourceItemId } : {}),
        ...(query ? { query } : {}),
      },
    };
  }

  return null;
}

// Statuses that mean the Codex App is currently active on this thread (a turn
// is mid-flight: in progress / running / streaming). When the App reports one
// of these, the cross-client write gate must fail closed: only one writer
// (App or browser) may be active on a Codex thread at a time. Matched
// case-insensitively and tolerant of `in_progress` vs `in-progress`.
const BUSY_STATUSES = new Set([
  "in_progress", "in-progress", "running", "active", "streaming", "busy", "pending", "processing",
]);

function isBusyStatus(value) {
  if (typeof value !== "string") return false;
  return BUSY_STATUSES.has(value.trim().toLowerCase());
}

// The App/CLI mutual-exclusion predicate. Inspects the `thread/read` response
// for any positive busy/in-progress signal — thread-level `busy`/`status` or a
// turn currently in progress. A positive signal anywhere means another writer
// (the App) holds the thread and the browser must not write. When no busy
// signal is present the thread is treated as quiescent; this is the read side
// of mutual exclusion, complementing the browser-side run mutex in
// assertBrowserWriteAllowed. Race-free exclusion still requires App-side
// writer-lock cooperation (undocumented), so browser writes stay disabled at
// the master switch (browserWriteEnabled) until proven on a real host.
function threadIsBusy(thread) {
  if (!thread || typeof thread !== "object" || Array.isArray(thread)) return false;
  if (thread.busy === true) return true;
  if (isBusyStatus(thread.status)) return true;
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  return turns.some((turn) => (
    turn && typeof turn === "object" && !Array.isArray(turn)
    && (turn.busy === true || isBusyStatus(turn.status))
  ));
}

// Normalize the full `thread/read` result into a flat ordered list of visible
// events plus the verified thread id and the App/CLI mutual-exclusion signal.
// Drops anything that is not an approved visible item. Never returns raw turns
// or unknown payloads.
export function normalizeAppServerThread(result, expectedThreadId) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("App Server returned an invalid thread response");
  }
  // The real App Server wraps the thread as `result.thread = { id, turns }`.
  // Support a narrow compatibility shape (`result.threadId` + `result.turns`)
  // for older fixtures, but prefer the real `result.thread` wrapper. Never
  // returns raw turns or unknown payloads.
  const threadWrapper = result.thread && typeof result.thread === "object" && !Array.isArray(result.thread)
    ? result.thread
    : null;
  const threadId = threadWrapper && typeof threadWrapper.id === "string"
    ? threadWrapper.id.trim()
    : (typeof result.threadId === "string" ? result.threadId.trim() : "");
  if (!threadId || threadId.length > 256 || threadId.includes("\0")) {
    throw new Error("App Server returned an invalid thread id");
  }
  if (expectedThreadId && threadId !== expectedThreadId) {
    throw new Error("App Server returned a different thread id");
  }
  const turns = Array.isArray(threadWrapper?.turns)
    ? threadWrapper.turns
    : (Array.isArray(result.turns) ? result.turns : []);
  // App/CLI mutual-exclusion signal: a busy/in-progress thread or turn means
  // the App is the active writer and the browser must fail closed. Computed
  // from whichever shape the response used (wrapper or flat).
  const busy = threadWrapper ? threadIsBusy(threadWrapper) : threadIsBusy(result);
  const events = [];
  let sourceOrder = 0;
  for (const turn of turns) {
    if (!turn || typeof turn !== "object" || Array.isArray(turn)) continue;
    const turnId = typeof turn.id === "string" ? cap(turn.id) : "";
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const item of items) {
      const normalized = normalizeAppServerTurnItem(item, { turnId, sourceOrder });
      sourceOrder += 1;
      if (normalized) events.push(normalized);
    }
  }
  return { threadId, events, busy };
}

// Start a short-lived App Server, call thread/read for an exact id, verify it,
// normalize visible items, and terminate the process tree. Throws on any
// compatibility, size, id, or protocol failure. Never falls back to creation.
export function readCodexThread({
  codexExecutable,
  codexThreadId,
  workspacePath,
  processEnv = process.env,
  timeoutMs = READ_TIMEOUT_MS,
  maxResponseBytes = MAX_RESPONSE_BYTES,
  platform = process.platform,
  whichAll,
}) {
  if (typeof codexThreadId !== "string" || !codexThreadId.trim()) {
    throw new Error("A codex thread id is required");
  }
  return new Promise((resolve, reject) => {
    // Existence on PATH is NOT proof Node can spawn a candidate: on Windows an
    // MSIX `WindowsApps\codex.exe` exists but throws synchronous EPERM under
    // spawn(shell:false). resolveCodexExecutableCandidates returns an ordered
    // list (non-WindowsApps .exe, then .cmd, then WindowsApps .exe); we try
    // each in turn and fall back to the next on a synchronous spawn failure.
    // This fallback happens BEFORE any protocol/session write (no initialize /
    // thread/read has been sent), so no Codex App state is touched. Only when
    // every candidate fails synchronously do we fail closed with a precise
    // reason. `platform`/`whichAll` are injectable for cross-platform tests.
    const candidatePaths = resolveCodexExecutableCandidates(codexExecutable, { platform, whichAll });
    let child;
    let lastError = null;
    for (const candidatePath of candidatePaths) {
      const invocation = codexInvocation(candidatePath, ["app-server", "--listen", "stdio://"], platform);
      try {
        child = spawn(invocation.executable, invocation.args, {
          cwd: workspacePath,
          env: processEnv,
          stdio: ["pipe", "pipe", "ignore"],
          ...codexSpawnOptions(invocation.executable, platform),
        });
        break;
      } catch (error) {
        lastError = spawnError(error);
      }
    }
    if (!child) {
      reject(lastError || new Error("Codex app-server failed to start: no spawnable candidate found"));
      return;
    }

    let buffer = "";
    let totalBytes = 0;
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("Timed out reading Codex thread")), timeoutMs);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { child.stdin.end(); } catch {}
      void terminateProcessTree(child).finally(() => {
        if (error) reject(error);
        else resolve(value);
      });
    }

    function send(message) {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        finish(error);
      }
    }

    function handleMessage(message) {
      if (message?.id === 1) {
        if (message.error) return finish(new Error("Codex app-server rejected initialization"));
        send({ method: "initialized" });
        send({
          id: 2,
          method: "thread/read",
          params: { threadId: codexThreadId, includeTurns: true },
        });
        return;
      }
      if (message?.id !== 2) return;
      if (message.error) {
        return finish(new Error(cap(message.error.message) || "Codex app-server could not read the thread"));
      }
      try {
        const normalized = normalizeAppServerThread(message.result, codexThreadId);
        finish(null, normalized);
      } catch (error) {
        finish(error);
      }
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > maxResponseBytes) {
        finish(new Error("Codex app-server response exceeded the size limit"));
        return;
      }
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0 && !settled) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) {
          try {
            handleMessage(JSON.parse(line));
          } catch {
            // Ignore non-JSON keep-alive / protocol lines; malformed payloads
            // never reach the normalizer.
          }
        }
        index = buffer.indexOf("\n");
      }
    });
    child.stdin.on("error", (error) => finish(spawnError(error)));
    child.once("error", (error) => finish(spawnError(error)));
    child.once("exit", (code, signal) => {
      if (!settled) {
        finish(new Error(`Codex app-server exited before reading the thread (${signal || code})`));
      }
    });
    child.once("spawn", () => {
      send({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codex-taskboard", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        },
      });
    });
  });
}

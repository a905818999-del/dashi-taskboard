import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

const VISIBLE_TEXT_LIMIT = 65_536;
const STDERR_LIMIT = 65_536;
const SKILL_MARKER = "\uFFFC";
const ITEM_TYPES = new Set([
  "agent_message",
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "web_search",
  "todo_list",
  "error",
]);

// Windows-aware PATH lookup for a single candidate file name. Returns the
// first existing file path on PATH (or the absolute path when `name` is
// absolute), or null. Only used on win32 in production; tests inject a fake
// `which` to avoid filesystem/PATH dependence.
function defaultWhich(name) {
  if (typeof name !== "string" || name.length === 0) return null;
  if (path.isAbsolute(name)) {
    try { return existsSync(name) && statSync(name).isFile() ? name : null; } catch { return null; }
  }
  const pathEnv = process.env.PATH || "";
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

// Resolve a bare Codex executable name on Windows to a concrete, spawnable
// path. Node's spawn(shell:false) with a bare "codex" can hit the extensionless
// npm Unix shim that npm installs alongside codex.cmd, which then fails with
// EPERM (it is not a valid Windows executable). Prefer `codex.exe` (the Codex
// App's real binary, which needs no shell and has no injection surface), then
// fall back to `codex.cmd` (npm shim, which requires shell:true). Non-Windows
// platforms and already-qualified paths (with .exe/.cmd/.bat/.ps1) are returned
// unchanged; if nothing is found, the bare name is returned so spawn() fails
// closed through spawnError. `which` is injectable for cross-platform tests.
export function resolveCodexExecutable(executable, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return executable;
  if (typeof executable !== "string" || executable.length === 0) return executable;
  const ext = path.extname(executable).toLowerCase();
  if ([".exe", ".cmd", ".bat", ".ps1"].includes(ext)) return executable;
  const which = options.which ?? defaultWhich;
  for (const candidateExt of [".exe", ".cmd"]) {
    const found = which(`${executable}${candidateExt}`);
    if (found) return found;
  }
  return executable;
}

export function codexInvocation(executable, args = [], platform = process.platform, options = {}) {
  const resolved = resolveCodexExecutable(executable, { platform, which: options.which });
  if (platform === "win32" && [".js", ".mjs", ".cjs"].includes(path.extname(resolved).toLowerCase())) {
    return { executable: process.execPath, args: [resolved, ...args] };
  }
  return { executable: resolved, args };
}
export function codexSpawnOptions(executable, platform = process.platform) {
  const isWindowsShim = platform === "win32" && [".cmd", ".bat"].includes(path.extname(executable).toLowerCase());
  return { shell: isWindowsShim, windowsHide: true };
}

export function terminateProcessTree(child, platform = process.platform) {
  if (!Number.isInteger(child?.pid)) return Promise.resolve();
  if (platform === "win32") {
    return new Promise((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.once("error", () => { try { child.kill(); } catch {} resolve(); });
      killer.once("close", resolve);
    });
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  return Promise.resolve();
}
function cappedText(value) {
  return typeof value === "string" ? value.slice(0, VISIBLE_TEXT_LIMIT) : "";
}

function errorMessage(value) {
  if (typeof value === "string") return cappedText(value);
  if (value && typeof value === "object") return cappedText(value.message);
  return "";
}

function detailText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return cappedText(value);
  try {
    return cappedText(JSON.stringify(value));
  } catch {
    return "";
  }
}

function itemStatus(rawType, item) {
  if (typeof item.status === "string") return cappedText(item.status);
  return rawType.slice("item.".length);
}

function normalizedItem(rawType, item) {
  const status = itemStatus(rawType, item);
  const itemId = cappedText(item.id);
  const baseData = {
    status,
    ...(itemId ? { itemId } : {}),
  };

  if (item.type === "agent_message") {
    return {
      kind: "event",
      type: item.type,
      role: "assistant",
      content: cappedText(item.text),
      data: baseData,
    };
  }

  if (item.type === "command_execution") {
    const command = cappedText(item.command);
    // Privacy: raw command output (aggregated_output/output) is never retained.
    // Only the command, status, and exit code are visible.
    return {
      kind: "event",
      type: item.type,
      role: "activity",
      content: command,
      data: {
        ...baseData,
        command,
        ...(Number.isInteger(item.exit_code) ? { exitCode: item.exit_code } : {}),
      },
    };
  }

  if (item.type === "file_change") {
    // Privacy: file changes keep only path and operation (kind). No diffs.
    const changes = Array.isArray(item.changes)
      ? item.changes.map((change) => ({
          path: cappedText(change?.path),
          kind: cappedText(change?.kind ?? change?.operation),
        })).filter((change) => change.path)
      : [];
    const content = cappedText(changes.map((change) => change.path).join("\n"));
    return {
      kind: "event",
      type: item.type,
      role: "activity",
      content,
      data: {
        ...baseData,
        files: changes,
      },
    };
  }

  if (item.type === "mcp_tool_call") {
    const server = cappedText(item.server);
    const tool = cappedText(item.tool);
    // Privacy: full MCP arguments/results/errors are never retained. Only
    // server, tool, and status are visible.
    return {
      kind: "event",
      type: item.type,
      role: item.error ? "error" : "activity",
      content: cappedText([server, tool].filter(Boolean).join(".")),
      data: {
        ...baseData,
        ...(server ? { server } : {}),
        ...(tool ? { tool } : {}),
      },
    };
  }

  if (item.type === "web_search") {
    const query = cappedText(item.query);
    return {
      kind: "event",
      type: item.type,
      role: "activity",
      content: query,
      data: { ...baseData, ...(query ? { query } : {}) },
    };
  }

  if (item.type === "todo_list") {
    const items = Array.isArray(item.items)
      ? item.items.map((todo) => ({
          text: cappedText(todo?.text),
          ...(typeof todo?.completed === "boolean" ? { completed: todo.completed } : {}),
        })).filter((todo) => todo.text)
      : [];
    return {
      kind: "event",
      type: item.type,
      role: "activity",
      content: cappedText(items.map((todo) => todo.text).join("\n")),
      data: {
        ...baseData,
        ...(items.length > 0 ? { detail: detailText(items) } : {}),
      },
    };
  }

  const message = errorMessage(item.message ?? item.error);
  return {
    kind: "event",
    type: item.type,
    role: "error",
    content: message,
    data: baseData,
  };
}

export function buildCodexArgs(thread, addDirectories, imagePaths = []) {
  const permission = thread.sandbox === "read-only"
    ? {
        sandbox: "read-only",
        approvalPolicy: "on-request",
        reviewer: "user",
      }
    : thread.sandbox === "workspace-write"
      ? {
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
          reviewer: "auto_review",
        }
      : {
          sandbox: "danger-full-access",
          approvalPolicy: "never",
          reviewer: null,
        };
  const args = [
    "exec",
    "--json",
    "--color",
    "never",
    "-C",
    thread.origin.workspacePath,
    "-s",
    permission.sandbox,
    "-c",
    `approval_policy="${permission.approvalPolicy}"`,
  ];
  if (permission.reviewer) {
    args.push("-c", `approvals_reviewer="${permission.reviewer}"`);
  }
  for (const directory of addDirectories) {
    args.push("--add-dir", directory);
  }
  if (thread.model) {
    args.push("-m", thread.model);
  }
  if (thread.reasoningEffort) {
    args.push("-c", `model_reasoning_effort="${thread.reasoningEffort}"`);
  }
  if (thread.codexThreadId) {
    args.push("resume");
    for (const imagePath of imagePaths) {
      args.push("-i", imagePath);
    }
    args.push(thread.codexThreadId, "-");
  } else {
    for (const imagePath of imagePaths) {
      args.push("-i", imagePath);
    }
    args.push("-");
  }
  return args;
}

export function buildCodexPrompt(thread, { message, skills, attachmentPaths }, skillPath) {
  const selectedSkills = skills ?? [];
  const turnAttachmentPaths = attachmentPaths ?? [];
  let selectedSkillIndex = 0;
  const userMessage = message.replaceAll(SKILL_MARKER, () => {
    const skill = selectedSkills[selectedSkillIndex];
    selectedSkillIndex += 1;
    return `[$${skill.id}](${skill.path})`;
  });
  const context = [];
  if (thread.origin.issueIdentifier) {
    context.push(`issue_identifier: ${thread.origin.issueIdentifier}`);
  }
  if (turnAttachmentPaths.length > 0) {
    context.push(
      "turn_attachment_paths:",
      ...turnAttachmentPaths.map((attachmentPath) => `- ${attachmentPath}`),
    );
  }
  return [userMessage, ...(context.length > 0 ? ["", "Visible context:", ...context] : [])].join("\n");
}

export function normalizeCodexEvent(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  if (raw.type === "thread.started") {
    if (
      typeof raw.thread_id !== "string"
      || raw.thread_id.length === 0
      || raw.thread_id.length > 256
      || raw.thread_id.includes("\0")
    ) {
      return null;
    }
    return { kind: "thread.started", threadId: raw.thread_id };
  }

  if (raw.type === "turn.started") {
    return {
      kind: "event",
      type: raw.type,
      role: "activity",
      content: "",
      data: { status: "started" },
    };
  }

  if (raw.type === "turn.completed") {
    const usage = {};
    for (const key of ["input_tokens", "cached_input_tokens", "output_tokens"]) {
      if (Number.isFinite(raw.usage?.[key])) usage[key] = raw.usage[key];
    }
    return {
      kind: "event",
      type: raw.type,
      role: "activity",
      content: "",
      data: {
        status: "completed",
        ...(Object.keys(usage).length > 0 ? { usage } : {}),
      },
    };
  }

  if (raw.type === "turn.failed") {
    return {
      kind: "event",
      type: raw.type,
      role: "error",
      content: errorMessage(raw.error ?? raw.message),
      data: { status: "failed" },
    };
  }

  if (raw.type === "error") {
    return {
      kind: "event",
      type: raw.type,
      role: "error",
      content: errorMessage(raw.message ?? raw.error),
      data: { status: "failed" },
    };
  }

  if (
    raw.type !== "item.started"
    && raw.type !== "item.updated"
    && raw.type !== "item.completed"
  ) {
    return null;
  }
  if (!raw.item || typeof raw.item !== "object" || !ITEM_TYPES.has(raw.item.type)) {
    return null;
  }
  return normalizedItem(raw.type, raw.item);
}

export function spawnCodexTurn({
  executable,
  args,
  prompt,
  env,
  onRawEvent,
  maxLineBytes = 1_048_576,
}) {
  const invocation = codexInvocation(executable, args);
  const child = spawn(invocation.executable, invocation.args, {
    detached: true,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    ...codexSpawnOptions(invocation.executable),
  });

  let stdoutBuffer = Buffer.alloc(0);
  let stderrBuffer = Buffer.alloc(0);
  let settled = false;
  let fatalError = null;
  let stdoutEnded = false;
  let resolveCompletion;
  let rejectCompletion;

  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  function terminateProcessGroup() {
    void terminateProcessTree(child);
  }

  function rejectWithDiagnostic(error) {
    if (settled || fatalError) return;
    fatalError = error instanceof Error ? error : new Error(String(error));
    terminateProcessGroup();
  }

  function consumeLine(line) {
    if (fatalError) return;
    if (line.length > maxLineBytes) {
      rejectWithDiagnostic(new Error(`Codex JSONL line exceeded ${maxLineBytes} bytes`));
      return;
    }
    if (line.at(-1) === 13) line = line.subarray(0, -1);
    if (line.toString("utf8").trim() === "") return;
    let raw;
    try {
      raw = JSON.parse(line.toString("utf8"));
    } catch {
      rejectWithDiagnostic(new Error("Codex emitted malformed JSONL"));
      return;
    }
    try {
      onRawEvent(raw);
    } catch (error) {
      rejectWithDiagnostic(error);
    }
  }

  function consumeChunk(chunk) {
    if (settled) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length && !settled && !fatalError) {
      const newline = bytes.indexOf(10, offset);
      if (newline === -1) {
        const remainder = bytes.subarray(offset);
        if (stdoutBuffer.length + remainder.length > maxLineBytes) {
          rejectWithDiagnostic(new Error(`Codex JSONL line exceeded ${maxLineBytes} bytes`));
          return;
        }
        stdoutBuffer = stdoutBuffer.length === 0
          ? Buffer.from(remainder)
          : Buffer.concat([stdoutBuffer, remainder]);
        return;
      }
      const segment = bytes.subarray(offset, newline);
      if (stdoutBuffer.length + segment.length > maxLineBytes) {
        rejectWithDiagnostic(new Error(`Codex JSONL line exceeded ${maxLineBytes} bytes`));
        return;
      }
      const line = stdoutBuffer.length === 0
        ? segment
        : Buffer.concat([stdoutBuffer, segment]);
      stdoutBuffer = Buffer.alloc(0);
      consumeLine(line);
      offset = newline + 1;
    }
  }

  function finishStdout() {
    if (stdoutEnded) return;
    stdoutEnded = true;
    if (!fatalError && stdoutBuffer.length > 0) {
      const line = stdoutBuffer;
      stdoutBuffer = Buffer.alloc(0);
      consumeLine(line);
    }
  }

  child.stdout.on("data", consumeChunk);
  child.stdout.on("end", finishStdout);
  child.stderr.on("data", (chunk) => {
    if (stderrBuffer.length >= STDERR_LIMIT) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stderrBuffer = Buffer.concat([
      stderrBuffer,
      bytes.subarray(0, STDERR_LIMIT - stderrBuffer.length),
    ]);
  });
  child.on("error", rejectWithDiagnostic);
  child.on("close", (exitCode, signal) => {
    finishStdout();
    if (settled) return;
    settled = true;
    if (fatalError) {
      if (stderrBuffer.length > 0) {
        fatalError.stderr = stderrBuffer.toString("utf8");
      }
      rejectCompletion(fatalError);
      return;
    }
    resolveCompletion({ exitCode, signal });
  });
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);

  return { child, completion };
}

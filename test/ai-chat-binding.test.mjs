import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
import { AiChatBindingService } from "../server/ai-chat-binding.mjs";
import {
  normalizeAppServerTurnItem,
  normalizeAppServerThread,
} from "../server/codex-app-server.mjs";

async function createDatabase() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-binding-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  return { database, directory, async close() { database.close(); await rm(directory, { recursive: true, force: true }); } };
}

function createTask(database, overrides = {}) {
  const project = database.createProject({
    id: overrides.projectId ?? "proj-1",
    name: "Project One",
    workspacePath: "/tmp/proj-1",
  });
  return database.createTask({
    projectId: project.id,
    title: overrides.title ?? "Adopt me",
    description: "",
    status: "todo",
    priority: "medium",
    labels: [],
    workflowId: null,
    developmentContext: null,
    dueDate: null,
    recurrence: null,
    actor: { type: "user", id: "u1", name: "User", avatarUrl: null },
    assignee: { type: "user", id: "u1", name: "User", avatarUrl: null },
  });
}

function makeReader({ threadId, events, busy = false, failWith = null }) {
  return async () => {
    if (failWith) throw new Error(failWith);
    return { threadId, events, busy };
  };
}

const VISIBLE_EVENTS = [
  { type: "userMessage", role: "user", content: "A1", sourceTurnId: "t1", sourceItemId: "i1", sourceKey: "t1:i1", sourceOrder: 0 },
  { type: "agentMessage", role: "assistant", content: "Visible answer", sourceTurnId: "t1", sourceItemId: "i2", sourceKey: "t1:i2", sourceOrder: 1 },
  { type: "commandExecution", role: "activity", content: "npm test", sourceTurnId: "t1", sourceItemId: "i3", sourceKey: "t1:i3", sourceOrder: 2, data: { status: "completed", command: "npm test", exitCode: 0, output: "ok" } },
  { type: "fileChange", role: "activity", content: "src/a.ts", sourceTurnId: "t1", sourceItemId: "i4", sourceKey: "t1:i4", sourceOrder: 3, data: { status: "completed", files: [{ path: "src/a.ts", kind: "modify" }] } },
  { type: "mcpToolCall", role: "activity", content: "github.create_issue", sourceTurnId: "t1", sourceItemId: "i5", sourceKey: "t1:i5", sourceOrder: 4, data: { status: "completed", server: "github", tool: "create_issue" } },
  { type: "webSearch", role: "activity", content: "codex docs", sourceTurnId: "t1", sourceItemId: "i6", sourceKey: "t1:i6", sourceOrder: 5, data: { status: "completed", query: "codex docs" } },
];

test("normalizer keeps every approved visible type and drops reasoning/system/raw/diff/MCP args", () => {
  const turnId = "turn-1";
  const items = [
    { type: "userMessage", id: "u1", text: "hello" },
    { type: "agentMessage", id: "a1", text: "hi", status: "completed" },
    { type: "plan", id: "p1", text: "step 1" },
    { type: "commandExecution", id: "c1", command: "npm test", aggregatedOutput: "ok", exitCode: 0 },
    { type: "fileChange", id: "f1", changes: [{ path: "a.ts", kind: "modify" }] },
    { type: "mcpToolCall", id: "m1", server: "github", tool: "create_issue", arguments: { secret: true }, result: { ok: 1 } },
    { type: "webSearch", id: "w1", query: "docs" },
    { type: "reasoning", id: "r1", text: "SECRET chain of thought" },
    { type: "systemMessage", id: "s1", text: "hidden system" },
    { type: "developerMessage", id: "d1", text: "hidden developer" },
    { type: "rawJsonl", id: "raw1", text: "{\"secret\":true}" },
    { type: "unknownType", id: "x1", text: "drop me" },
  ];
  const normalized = items.map((item, index) => normalizeAppServerTurnItem(item, { turnId, sourceOrder: index })).filter(Boolean);
  assert.equal(normalized.length, 7);
  assert.deepEqual(normalized.map((n) => n.type), [
    "userMessage", "agentMessage", "plan", "commandExecution", "fileChange", "mcpToolCall", "webSearch",
  ]);
  // MCP must drop arguments/results, keeping only server/tool/status.
  const mcp = normalized.find((n) => n.type === "mcpToolCall");
  assert.equal(mcp.data.server, "github");
  assert.equal(mcp.data.tool, "create_issue");
  assert.equal(mcp.data.arguments, undefined);
  assert.equal(mcp.data.result, undefined);
  // File change keeps only path + operation, no diff.
  const file = normalized.find((n) => n.type === "fileChange");
  assert.deepEqual(file.data.files, [{ path: "a.ts", kind: "modify" }]);
  assert.equal(file.data.diff, undefined);
  // Reasoning/system/developer/raw are all dropped.
  assert.equal(normalized.some((n) => n.type === "reasoning"), false);
  assert.equal(normalized.some((n) => /system|developer|raw/i.test(n.type)), false);
});

test("normalizer rejects malformed/oversized App Server responses", () => {
  assert.throws(() => normalizeAppServerThread(null, "x"), /invalid thread response/);
  assert.throws(() => normalizeAppServerThread({ threadId: "" }, "x"), /invalid thread id/);
  assert.throws(() => normalizeAppServerThread({ threadId: "a".repeat(300) }, "x"), /invalid thread id/);
  assert.throws(() => normalizeAppServerThread({ threadId: "good", turns: [] }, "different"), /different thread id/);
  // NUL byte in id
  assert.throws(() => normalizeAppServerThread({ threadId: "bad\0id" }, "bad\0id"), /invalid thread id/);
});

test("normalizeAppServerThread caps visible text and flattens turns in order", () => {
  const longText = "x".repeat(70_000);
  const result = normalizeAppServerThread({
    threadId: "T",
    turns: [
      { id: "t1", items: [
        { type: "userMessage", id: "i1", text: longText },
        { type: "agentMessage", id: "i2", text: "ok" },
      ]},
      { id: "t2", items: [
        { type: "agentMessage", id: "i3", text: "second turn" },
      ]},
    ],
  }, "T");
  assert.equal(result.threadId, "T");
  assert.equal(result.events.length, 3);
  assert.equal(result.events[0].content.length, 65_536);
  assert.deepEqual(result.events.map((e) => e.sourceKey), ["t1:i1", "t1:i2", "t2:i3"]);
  assert.equal(result.events[0].sourceOrder, 0);
  assert.equal(result.events[2].sourceOrder, 2);
});

test("adopt verifies the App thread id, imports visible history, and sets the binding active", async () => {
  const fixture = await createDatabase();
  try {
    const task = createTask(fixture.database);
    const reader = makeReader({ threadId: "T", events: VISIBLE_EVENTS });
    const service = new AiChatBindingService({
      database: fixture.database,
      codexExecutable: "codex",
      readThread: reader,
      browserWriteEnabled: true,
    });
    const result = await service.adopt(task.id, { codexThreadId: "T", workspacePath: "/tmp/proj-1", source: "browser" });
    assert.equal(result.binding.state, "active");
    assert.equal(result.binding.codexThreadId, "T");
    assert.equal(result.inserted.length, 6);
    const thread = fixture.database.getAiChatThreadForIssue(task.id);
    assert.equal(thread.codexThreadId, "T");
    assert.equal(thread.lifecycle, "task_bound");
    const events = fixture.database.listAiChatEvents(thread.id);
    assert.equal(events.length, 6);
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4, 5, 6]);
  } finally {
    await fixture.close();
  }
});

test("adopt with a mismatched App Server id fails closed and never creates a thread", async () => {
  const fixture = await createDatabase();
  try {
    const task = createTask(fixture.database);
    const reader = makeReader({ threadId: "DIFFERENT", events: VISIBLE_EVENTS });
    const service = new AiChatBindingService({
      database: fixture.database,
      codexExecutable: "codex",
      readThread: reader,
    });
    await assert.rejects(service.adopt(task.id, { codexThreadId: "T" }), (error) => (
      error.code === "ADOPT_UNAVAILABLE" && /different thread id/.test(error.message)
    ));
    assert.equal(fixture.database.getTaskCodexBinding(task.id).state, "unavailable");
    assert.equal(fixture.database.getAiChatThreadForIssue(task.id), null);
  } finally {
    await fixture.close();
  }
});

test("adopt failure (reader throws) marks unavailable and never falls back to a new thread", async () => {
  const fixture = await createDatabase();
  try {
    const task = createTask(fixture.database);
    const reader = makeReader({ failWith: "codex app-server crashed" });
    const service = new AiChatBindingService({
      database: fixture.database,
      codexExecutable: "codex",
      readThread: reader,
    });
    await assert.rejects(service.adopt(task.id, { codexThreadId: "T" }), (error) => (
      error.code === "ADOPT_UNAVAILABLE" && /crashed/.test(error.message)
    ));
    const binding = fixture.database.getTaskCodexBinding(task.id);
    assert.equal(binding.state, "unavailable");
    assert.match(binding.error, /crashed/);
    assert.equal(fixture.database.getAiChatThreadForIssue(task.id), null);
  } finally {
    await fixture.close();
  }
});

test("repeated sync imports zero duplicates (idempotent source keys)", async () => {
  const fixture = await createDatabase();
  try {
    const task = createTask(fixture.database);
    const reader = makeReader({ threadId: "T", events: VISIBLE_EVENTS });
    const service = new AiChatBindingService({
      database: fixture.database,
      codexExecutable: "codex",
      readThread: reader,
    });
    await service.adopt(task.id, { codexThreadId: "T" });
    const thread = fixture.database.getAiChatThreadForIssue(task.id);

    const sync1 = await service.sync(task.id);
    assert.equal(sync1.inserted.length, 0);
    assert.equal(fixture.database.listAiChatEvents(thread.id).length, 6);

    const sync2 = await service.sync(task.id);
    assert.equal(sync2.inserted.length, 0);
    assert.equal(fixture.database.listAiChatEvents(thread.id).length, 6);
    // seq never grows on a no-op sync.
    assert.deepEqual(fixture.database.listAiChatEvents(thread.id).map((e) => e.seq), [1, 2, 3, 4, 5, 6]);
  } finally {
    await fixture.close();
  }
});

test("incremental sync imports only new items after App writes A2", async () => {
  const fixture = await createDatabase();
  try {
    const task = createTask(fixture.database);
    let appEvents = VISIBLE_EVENTS;
    const reader = async () => ({ threadId: "T", events: appEvents, busy: false });
    const service = new AiChatBindingService({
      database: fixture.database,
      codexExecutable: "codex",
      readThread: reader,
    });
    await service.adopt(task.id, { codexThreadId: "T" });
    const thread = fixture.database.getAiChatThreadForIssue(task.id);

    // App writes A2 (two new items).
    appEvents = [
      ...VISIBLE_EVENTS,
      { type: "userMessage", role: "user", content: "A2", sourceTurnId: "t2", sourceItemId: "i7", sourceKey: "t2:i7", sourceOrder: 6 },
      { type: "agentMessage", role: "assistant", content: "A2 reply", sourceTurnId: "t2", sourceItemId: "i8", sourceKey: "t2:i8", sourceOrder: 7 },
    ];
    const sync = await service.sync(task.id);
    assert.equal(sync.inserted.length, 2);
    const events = fixture.database.listAiChatEvents(thread.id);
    assert.equal(events.length, 8);
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(events.slice(-2).map((e) => e.content), ["A2", "A2 reply"]);
  } finally {
    await fixture.close();
  }
});

test("legacy browser thread with a different codex id enters conflict and never merges transcripts", async () => {
  const fixture = await createDatabase();
  try {
    const task = createTask(fixture.database);
    // Pre-existing legacy browser thread with a different codex thread id.
    fixture.database.createAiChatThread({
      title: "Legacy browser chat",
      status: "idle",
      lifecycle: "legacy_browser",
      origin: {
        projectId: task.projectId,
        projectName: "Project One",
        workspacePath: "/tmp/proj-1",
        issueId: task.id,
        issueIdentifier: task.identifier,
      },
      codexThreadId: "LEGACY-ID",
      model: "gpt-real",
      reasoningEffort: "medium",
      sandbox: "read-only",
    });
    const reader = makeReader({ threadId: "T", events: VISIBLE_EVENTS });
    const service = new AiChatBindingService({
      database: fixture.database,
      codexExecutable: "codex",
      readThread: reader,
    });
    await assert.rejects(service.adopt(task.id, { codexThreadId: "T" }), (error) => (
      error.code === "BINDING_CONFLICT" && /Legacy browser thread/.test(error.message)
    ));
    const binding = fixture.database.getTaskCodexBinding(task.id);
    assert.equal(binding.state, "conflict");
    // Transcript is NOT merged: legacy thread still has zero events.
    const legacyThread = fixture.database.getAiChatThreadForIssue(task.id);
    assert.equal(legacyThread.codexThreadId, "LEGACY-ID");
    assert.equal(fixture.database.listAiChatEvents(legacyThread.id).length, 0);
  } finally {
    await fixture.close();
  }
});

test("resolveConflict keep_app archives the legacy transcript and keeps the App binding", async () => {
  const fixture = await createDatabase();
  try {
    const task = createTask(fixture.database);
    const legacyThread = fixture.database.createAiChatThread({
      title: "Legacy",
      status: "idle",
      lifecycle: "legacy_browser",
      origin: { projectId: task.projectId, projectName: "P", workspacePath: "/tmp", issueId: task.id, issueIdentifier: task.identifier },
      codexThreadId: "LEGACY-ID",
      model: "gpt", reasoningEffort: "medium", sandbox: "read-only",
    });
    fixture.database.createTaskCodexBinding({
      taskId: task.id, codexThreadId: "T", state: "conflict", source: "app",
    });
    const service = new AiChatBindingService({
      database: fixture.database, codexExecutable: "codex",
      readThread: makeReader({ threadId: "T", events: [] }),
    });
    const result = await service.resolveConflict(task.id, { action: "keep_app" });
    assert.equal(result.binding.state, "active");
    assert.equal(result.binding.codexThreadId, "T");
    const updated = fixture.database.getAiChatThread(legacyThread.id);
    assert.equal(updated.lifecycle, "archived");
  } finally {
    await fixture.close();
  }
});

test("fail-closed: browser write is blocked when the binding is not active", async () => {
  const fixture = await createDatabase();
  try {
    const task = createTask(fixture.database);
    fixture.database.createTaskCodexBinding({
      taskId: task.id, codexThreadId: "T", state: "unavailable", source: "app",
    });
    const service = new AiChatBindingService({
      database: fixture.database, codexExecutable: "codex",
      readThread: makeReader({ threadId: "T", events: [] }),
      browserWriteEnabled: true,
    });
    await assert.rejects(service.assertBrowserWriteAllowed(task.id), (error) => (
      error.code === "BINDING_NOT_ACTIVE"
    ));
  } finally {
    await fixture.close();
  }
});

test("fail-closed: browser write is blocked when no binding exists", async () => {
  const fixture = await createDatabase();
  try {
    const task = createTask(fixture.database);
    const service = new AiChatBindingService({
      database: fixture.database, codexExecutable: "codex",
      readThread: makeReader({ threadId: "T", events: [] }),
    });
    await assert.rejects(service.assertBrowserWriteAllowed(task.id), (error) => (
      error.code === "NOT_BOUND"
    ));
  } finally {
    await fixture.close();
  }
});

test("fail-closed: browser write is blocked when another run is active for the same Codex thread", async () => {
  const fixture = await createDatabase();
  try {
    const task = createTask(fixture.database);
    const thread = fixture.database.createAiChatThread({
      title: "T", status: "idle", lifecycle: "task_bound",
      origin: { projectId: task.projectId, projectName: "P", workspacePath: "/tmp", issueId: task.id, issueIdentifier: task.identifier },
      codexThreadId: "T", model: "gpt", reasoningEffort: "medium", sandbox: "read-only",
    });
    fixture.database.createTaskCodexBinding({ taskId: task.id, codexThreadId: "T", state: "active", source: "app" });
    // A run for the same codex thread id is already running (simulating the App
    // or another browser tab holding the writer mutex).
    fixture.database.createAiChatRun({
      threadId: thread.id, status: "running", codexThreadId: "T",
    });
    const service = new AiChatBindingService({
      database: fixture.database, codexExecutable: "codex",
      readThread: makeReader({ threadId: "T", events: [] }),
    });
    await assert.rejects(service.assertBrowserWriteAllowed(task.id), (error) => (
      error.code === "CODEX_THREAD_BUSY"
    ));
  } finally {
    await fixture.close();
  }
});

test("fail-closed: browser write is blocked when the quiescence probe cannot prove quietness", async () => {
  const fixture = await createDatabase();
  try {
    const task = createTask(fixture.database);
    fixture.database.createAiChatThread({
      title: "T", status: "idle", lifecycle: "task_bound",
      origin: { projectId: task.projectId, projectName: "P", workspacePath: "/tmp", issueId: task.id, issueIdentifier: task.identifier },
      codexThreadId: "T", model: "gpt", reasoningEffort: "medium", sandbox: "read-only",
    });
    fixture.database.createTaskCodexBinding({ taskId: task.id, codexThreadId: "T", state: "active", source: "app" });
    const service = new AiChatBindingService({
      database: fixture.database, codexExecutable: "codex",
      readThread: makeReader({ failWith: "codex CLI missing" }),
    });
    await assert.rejects(service.assertBrowserWriteAllowed(task.id), (error) => (
      error.code === "QUIESCENCE_UNPROVEN" && /codex CLI missing/.test(error.message)
    ));
  } finally {
    await fixture.close();
  }
});

test("fail-closed: browser write is blocked when browserWriteEnabled is false", async () => {
  const fixture = await createDatabase();
  try {
    const task = createTask(fixture.database);
    fixture.database.createTaskCodexBinding({ taskId: task.id, codexThreadId: "T", state: "active", source: "app" });
    fixture.database.createAiChatThread({
      title: "T", status: "idle", lifecycle: "task_bound",
      origin: { projectId: task.projectId, projectName: "P", workspacePath: "/tmp", issueId: task.id, issueIdentifier: task.identifier },
      codexThreadId: "T", model: "gpt", reasoningEffort: "medium", sandbox: "read-only",
    });
    const service = new AiChatBindingService({
      database: fixture.database, codexExecutable: "codex",
      readThread: makeReader({ threadId: "T", events: [] }),
      browserWriteEnabled: false,
    });
    await assert.rejects(service.assertBrowserWriteAllowed(task.id), (error) => (
      error.code === "BROWSER_WRITE_BLOCKED"
    ));
  } finally {
    await fixture.close();
  }
});

test("assertBrowserWriteAllowed succeeds for a quiet read-only bound thread and returns the verified binding", async () => {
  const fixture = await createDatabase();
  try {
    const task = createTask(fixture.database);
    fixture.database.createAiChatThread({
      title: "T", status: "idle", lifecycle: "task_bound",
      origin: { projectId: task.projectId, projectName: "P", workspacePath: "/tmp", issueId: task.id, issueIdentifier: task.identifier },
      codexThreadId: "T", model: "gpt", reasoningEffort: "medium", sandbox: "read-only",
    });
    fixture.database.createTaskCodexBinding({ taskId: task.id, codexThreadId: "T", state: "active", source: "app" });
    const service = new AiChatBindingService({
      database: fixture.database, codexExecutable: "codex",
      readThread: makeReader({ threadId: "T", events: [], busy: false }),
    });
    const gate = await service.assertBrowserWriteAllowed(task.id);
    assert.equal(gate.binding.codexThreadId, "T");
    assert.equal(gate.thread.codexThreadId, "T");
    assert.equal(gate.guard, null); // read-only sandbox takes no worktree guard
  } finally {
    await fixture.close();
  }
});

test("binding uniqueness: one codex thread id maps to at most one task", async () => {
  const fixture = await createDatabase();
  try {
    fixture.database.createProject({ id: "proj-1", name: "Project One", workspacePath: "/tmp/proj-1" });
    const task1 = fixture.database.createTask({
      projectId: "proj-1", title: "Task 1", description: "", status: "todo", priority: "medium",
      labels: [], workflowId: null, developmentContext: null, dueDate: null, recurrence: null,
      actor: { type: "user", id: "u1", name: "User", avatarUrl: null },
      assignee: { type: "user", id: "u1", name: "User", avatarUrl: null },
    });
    const task2 = fixture.database.createTask({
      projectId: "proj-1", title: "Task 2", description: "", status: "todo", priority: "medium",
      labels: [], workflowId: null, developmentContext: null, dueDate: null, recurrence: null,
      actor: { type: "user", id: "u1", name: "User", avatarUrl: null },
      assignee: { type: "user", id: "u1", name: "User", avatarUrl: null },
    });
    const reader = makeReader({ threadId: "T", events: [] });
    const service = new AiChatBindingService({
      database: fixture.database, codexExecutable: "codex", readThread: reader,
    });
    await service.adopt(task1.id, { codexThreadId: "T" });
    await assert.rejects(service.adopt(task2.id, { codexThreadId: "T" }), (error) => (
      error.code === "BINDING_CONFLICT" && /bound to another task/.test(error.message)
    ));
  } finally {
    await fixture.close();
  }
});

test("afterSeq recovery returns only events with seq greater than the cursor", async () => {
  const fixture = await createDatabase();
  try {
    const task = createTask(fixture.database);
    const reader = makeReader({ threadId: "T", events: VISIBLE_EVENTS });
    const service = new AiChatBindingService({
      database: fixture.database, codexExecutable: "codex", readThread: reader,
    });
    await service.adopt(task.id, { codexThreadId: "T" });
    const thread = fixture.database.getAiChatThreadForIssue(task.id);
    const after3 = fixture.database.listAiChatEvents(thread.id, { afterSeq: 3 });
    assert.equal(after3.length, 3);
    assert.deepEqual(after3.map((e) => e.seq), [4, 5, 6]);
    const after6 = fixture.database.listAiChatEvents(thread.id, { afterSeq: 6 });
    assert.equal(after6.length, 0);
  } finally {
    await fixture.close();
  }
});

test("getBindingState reports unbound/active/conflict/legacy signals for the UI", async () => {
  const fixture = await createDatabase();
  try {
    const task = createTask(fixture.database);
    const service = new AiChatBindingService({
      database: fixture.database, codexExecutable: "codex",
      readThread: makeReader({ threadId: "T", events: [] }),
    });
    const unbound = service.getBindingState(task.id);
    assert.equal(unbound.binding, null);
    assert.equal(unbound.thread, null);
    assert.equal(unbound.conflictingLegacyId, null);

    await service.adopt(task.id, { codexThreadId: "T" });
    const active = service.getBindingState(task.id);
    assert.equal(active.binding.state, "active");
    assert.equal(active.thread.codexThreadId, "T");
  } finally {
    await fixture.close();
  }
});

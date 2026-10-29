/**
 * The CLI adapters' line parsers against stream lines captured from the real CLIs on
 * 2026-10-29 (codex exec --json, claude stream-json, grok streaming-json, dsh headless --json,
 * pi --mode json), plus v1 → v2 state migration.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CodexAdapter } from "../src/agents/codex.js";
import { ClaudeAdapter } from "../src/agents/claude.js";
import { GrokAdapter } from "../src/agents/grok.js";
import { DshAdapter } from "../src/agents/dsh.js";
import { PiAdapter } from "../src/agents/pi.js";
import { migrate } from "../src/core/store.js";

function run(adapter, lines) {
  const ctx = { sessionId: null };
  const events = lines.flatMap((l) => adapter.parseLine(typeof l === "string" ? l : JSON.stringify(l), ctx));
  return { ctx, events, types: events.map((e) => e.type) };
}

test("codex exec --json", () => {
  const { ctx, events, types } = run(new CodexAdapter(), [
    { type: "thread.started", thread_id: "01a1875c-9275-7cf1-b4ec-761f24c5652d" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "我会运行指定命令。" } },
    { type: "item.started", item: { id: "item_1", type: "command_execution", command: "/bin/bash -lc 'ls'", status: "in_progress" } },
    { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "/bin/bash -lc 'ls'", exit_code: 0 } },
    { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "ok" } },
    { type: "turn.completed", usage: {} },
  ]);
  assert.equal(ctx.sessionId, "01a1875c-9275-7cf1-b4ec-761f24c5652d");
  assert.deepEqual(types, ["message", "tool_call", "tool_call", "tool_result", "message"]);
  assert.equal(events.at(-1).text, "ok");
  assert.deepEqual(run(new CodexAdapter(), [{ type: "turn.failed", error: { message: "boom" } }]).events, [{ type: "failure", code: "turn_failed", message: "boom" }]);
});

test("codex resume reads the prompt from stdin", () => {
  const a = new CodexAdapter();
  const r = a.buildRun({ sessionId: "abc", threadId: "t", cwd: "/tmp" }, "你好", { images: [] });
  assert.deepEqual(r.args.slice(0, 3), ["exec", "resume", "abc"]);
  assert.equal(r.args.at(-1), "-");
  assert.equal(r.stdin, "你好");
});

test("claude stream-json", () => {
  const sid = "1061c837-b454-43e2-a66a-061346534c73";
  const { ctx, events, types } = run(new ClaudeAdapter(), [
    { type: "system", subtype: "init", session_id: sid },
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } } },
    { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu1", name: "Bash" } } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1" }] } },
    { type: "stream_event", event: { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "ok" } } },
    { type: "assistant", message: { model: "claude-opus-5.5", content: [{ type: "text", text: "ok" }] } },
    { type: "result", subtype: "success", is_error: false },
  ]);
  assert.equal(ctx.sessionId, sid);
  assert.deepEqual(types, ["thinking", "tool_call", "tool_result", "text_start", "text_delta", "message"]);
  assert.equal(events[1].name, "Bash");
});

test("claude: a synthetic CLI message is a failure, not an answer", () => {
  const { events } = run(new ClaudeAdapter(), [
    { type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: "Not logged in · Please run /login" }] } },
  ]);
  assert.deepEqual(events, [{ type: "failure", code: "claude", message: "Not logged in · Please run /login" }]);
});

test("grok streaming-json: text chunks close into a message at tool calls and the end", () => {
  const { ctx, events, types } = run(new GrokAdapter(), [
    { type: "available_commands", tools: [] },
    { type: "text", data: "我来" },
    { type: "text", data: "执行。" },
    { type: "tool_call", toolCallId: "c1", toolName: "run_terminal_command", status: "pending" },
    { type: "tool_call_update", toolCallId: "c1", status: "in_progress" },
    { type: "tool_call_update", toolCallId: "c1", status: "completed" },
    { type: "text", data: "GROK_SESSION_ID=x" },
    { type: "end", stopReason: "end_turn", sessionId: "01a18755-f470-77d2-b688-6220e4c24adf" },
  ]);
  assert.equal(ctx.sessionId, "01a18755-f470-77d2-b688-6220e4c24adf");
  assert.deepEqual(types, ["text_start", "text_delta", "text_delta", "message", "tool_call", "tool_result", "text_start", "text_delta", "message"]);
  assert.equal(events[3].text, "我来执行。");
  assert.equal(events.at(-1).text, "GROK_SESSION_ID=x");
});

test("dsh headless --json", () => {
  const { ctx, types } = run(new DshAdapter(), [
    { type: "session", sessionId: "session-498866bf-529c-4749-a5b0-85d4f376abd3", cwd: "/tmp" },
    { type: "status", phase: "turn_start", turn: 1 },
    { type: "tool_call", callId: "c", tool: "bash", input: {} },
    { type: "tool_result", callId: "c", status: "completed", result: "x" },
    { type: "text", text: "ok" },
    { type: "status", phase: "turn_end", turn: 1, reason: { kind: "completed" } },
    { type: "final", text: "ok" },
  ]);
  assert.equal(ctx.sessionId, "session-498866bf-529c-4749-a5b0-85d4f376abd3");
  assert.deepEqual(types, ["tool_call", "tool_result", "message"]);
});

test("pi --mode json, including a provider error", () => {
  const { ctx, events, types } = run(new PiAdapter(), [
    { type: "session", version: 3, id: "01a18753-5b30-767e-bb99-e6d84b30f011", cwd: "/tmp" },
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
    { type: "message_update", assistantMessageEvent: { type: "text_start" } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } },
    { type: "tool_execution_start", toolCallId: "t", toolName: "bash" },
    { type: "tool_execution_end", toolCallId: "t", toolName: "bash" },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" } },
    { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "401: bad token" } },
  ]);
  assert.equal(ctx.sessionId, "01a18753-5b30-767e-bb99-e6d84b30f011");
  assert.deepEqual(types, ["text_start", "text_delta", "tool_call", "tool_result", "message", "failure"]);
  assert.equal(events.at(-1).message, "401: bad token");
});

test("v1 state (Feishu + Penguin maps) migrates to bindings", () => {
  const v1 = {
    maps: { omt_1: { sessionId: "session-x-00e2f32b", rootMessageId: "om_1", title: "继续完成任务", createdAt: "2026-10-08T09:58:19.319Z" } },
    seen: ["om_a"],
    sentTexts: [],
    openCards: { omt_1: { cardId: "c", messageId: "om_2" } },
  };
  const v2 = migrate(v1);
  assert.equal(v2.version, 2);
  assert.deepEqual(v2.bindings["feishu:omt_1"], {
    id: "feishu:omt_1",
    channel: "feishu",
    agent: "penguin",
    sessionId: "session-x-00e2f32b",
    cwd: null,
    title: "继续完成任务",
    createdAt: "2026-10-08T09:58:19.319Z",
    address: { threadId: "omt_1", rootMessageId: "om_1" },
  });
  assert.deepEqual(v2.openCards["feishu:omt_1"], { cardId: "c", messageId: "om_2" });
  assert.deepEqual(v2.seen, ["om_a"]);
  assert.deepEqual(migrate(v2), v2); // idempotent
});

/**
 * Pure text helpers: the /ht parser (with @agent), /pd, stop intent, reply-file paths, the
 * Penguin mirror filter, session lookup. Run with: node --test test/*.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseCommand, splitQueuePrefix, isStopIntent, extractFilePaths, resolveSession } from "../src/core/commands.js";
import { sanitizeMirroredUserText } from "../src/agents/penguin.js";
import { handleOf, displayTitle } from "../src/core/format.js";

test("/ht family parses kind, agent and arguments", () => {
  const cases = [
    ["/ht", { kind: "new", agent: undefined }],
    ["/ht〈测试标题〉", { kind: "new", agent: undefined, name: "测试标题" }],
    ["/ht《测试》", { kind: "new", agent: undefined, name: "测试" }],
    ["/ht<文件测试>", { kind: "new", agent: undefined, name: "文件测试" }],
    ["/ht＜全角尖括号＞", { kind: "new", agent: undefined, name: "全角尖括号" }],
    ["/ht@codex", { kind: "new", agent: "codex" }],
    ["/ht@Claude〈写周报〉", { kind: "new", agent: "claude", name: "写周报" }],
    ["/ht@cc〈别名〉", { kind: "new", agent: "claude", name: "别名" }],
    ["/ht@deepseek 最近", { kind: "attach", agent: "dsh", target: "最近" }],
    ["/ht@nope", { kind: "new", agent: "?nope" }],
    ["/ht abc123", { kind: "attach", agent: undefined, target: "abc123" }],
    ["/ht 最近", { kind: "attach", agent: undefined, target: "最近" }],
    ["/ht-list", { kind: "list", agent: undefined }],
    ["/ht-list@pi", { kind: "list", agent: "pi" }],
    ["/ht-list codex", { kind: "list", agent: "codex" }],
    ["／ht-list", { kind: "list", agent: undefined }],
    ["/ht-agents", { kind: "agents" }],
    ["/ht-help", { kind: "help" }],
    ["/ht-use 1a2b3c4d", { kind: "use", target: "1a2b3c4d" }],
    ["/ht-cn〈新名字〉", { kind: "rename", name: "新名字" }],
    ["/ht-cn〈abcd1234〉〈新名字〉", { kind: "rename", target: "abcd1234", name: "新名字" }],
    ["/ht-close", { kind: "close", target: undefined }],
    ["/ht-close〈abcd〉", { kind: "close", target: "abcd" }],
  ];
  for (const [input, want] of cases) assert.deepEqual(parseCommand(input), want, input);
  assert.equal(parseCommand("你好"), null);
  assert.equal(parseCommand("ht"), null);
});

test("/pd forces the queue; a bare /pd is plain text", () => {
  assert.deepEqual(splitQueuePrefix("/pd 排队测试"), { queue: true, text: "排队测试" });
  assert.deepEqual(splitQueuePrefix("/pd"), { queue: false, text: "/pd" });
  assert.deepEqual(splitQueuePrefix("普通消息"), { queue: false, text: "普通消息" });
});

test("stop intent only fires on short, distinctive messages", () => {
  for (const t of ["stop", "/stop", "停止", "停", "打住！", "停一下，我要改个需求"]) assert.equal(isStopIntent(t), true, t);
  for (const t of ["帮我把这个文件停下来分析一下问题", "继续", "你好", "/ht-list"]) assert.equal(isStopIntent(t), false, t);
});

test("reply-file paths: bare and backticked (spaces allowed in backticks)", () => {
  assert.deepEqual(extractFilePaths("报告在 /Users/me/ws/report.md 里。"), ["/Users/me/ws/report.md"]);
  assert.deepEqual(extractFilePaths("见 ~/Desktop/a/b.png 与 /tmp/x.zip"), ["~/Desktop/a/b.png", "/tmp/x.zip"]);
  assert.deepEqual(extractFilePaths("没有路径的中文句子。"), []);
  assert.deepEqual(extractFilePaths("输出：`/Users/me/ws/输出 2026.pdf`"), ["/Users/me/ws/输出 2026.pdf"]);
  assert.deepEqual(
    extractFilePaths("路径为：\n[/Users/me/Library/Application Support/AB/hello.md](/Users/me/Library/Application%20Support/AB/hello.md)"),
    ["/Users/me/Library/Application Support/AB/hello.md"],
  );
});

test("penguin mirror filter keeps the human's words only", () => {
  assert.equal(sanitizeMirroredUserText("你好"), "你好");
  assert.equal(sanitizeMirroredUserText("[user_steering]\n别动线上库\n[/user_steering]"), "别动线上库");
  assert.equal(sanitizeMirroredUserText("[turn_aborted]\nx\n[/turn_aborted]"), null);
  assert.equal(sanitizeMirroredUserText("[use_skills]\nskills: a\n[/use_skills]\n帮我分析"), "帮我分析");
  assert.equal(sanitizeMirroredUserText("   "), null);
});

test("session lookup by id, prefix, handle, title, 最近", () => {
  const sessions = [
    { sessionId: "01a18753-5b66-7d00-ba1a-835f75f8f855", title: "迁移方案", updatedAt: "2026-10-28T00:00:00Z" },
    { sessionId: "session-0a1614e6-b500-4287-8fb1-88ccbd6096ed", title: "淘宝到货", updatedAt: "2026-10-29T00:00:00Z" },
  ];
  assert.equal(resolveSession(sessions, "最近").title, "淘宝到货");
  assert.equal(resolveSession(sessions, "01a18753").title, "迁移方案");
  assert.equal(resolveSession(sessions, "0a1614e6").title, "淘宝到货"); // dsh prefix without "session-"
  assert.equal(resolveSession(sessions, handleOf(sessions[0].sessionId)).title, "迁移方案");
  assert.equal(resolveSession(sessions, "到货").title, "淘宝到货");
  assert.equal(resolveSession(sessions, "zzz"), null);
});

test("display titles carry the agent", () => {
  assert.equal(displayTitle("codex", "修复登录"), "[Codex] 修复登录");
  assert.equal(displayTitle("dsh", "x"), "[DeepSeek] x");
  assert.equal(handleOf("session-2026-10-08-15-43-36-00e2f32b"), "00e2f32b");
});

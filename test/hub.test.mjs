/**
 * The hub's routing with a fake channel and a fake agent: binding creation, the session id a
 * CLI agent mints on its first run, inbound routing in thread and shared isolation, echo
 * suppression, stop, and unbinding. No network, no Feishu.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ht-hub-"));
process.env.HT_HOME = home;
const { Hub } = await import("../src/hub/hub.js");
const { Store } = await import("../src/core/store.js");
const { AgentAdapter } = await import("../src/agents/base.js");
const { Channel } = await import("../src/channels/base.js");

class FakeAgent extends AgentAdapter {
  constructor() {
    super("codex");
    this.capabilities = { create: true, steer: false, abort: true, approvals: false, sweep: false, mirrorsOwnSide: false };
    this.sent = [];
    this.running = false;
  }
  async available() {
    return { ok: true };
  }
  async listSessions() {
    return [{ sessionId: "s-existing-0000aaaa", title: "已有会话", cwd: "/tmp", updatedAt: "2026-10-29T00:00:00Z" }];
  }
  async send(link, parts) {
    this.sent.push({ sessionId: link.sessionId, parts });
    if (!link.sessionId) link.emit({ type: "session_id", sessionId: `s-new-${this.sent.length}` });
    link.emit({ type: "run_start" });
    link.emit({ type: "message", text: "好的" });
    link.emit({ type: "run_end" });
    return {};
  }
  async abort() {
    return { running: true };
  }
}

class FakeChannel extends Channel {
  constructor(isolation) {
    super("fake", { isolation }, null);
    this.capabilities = { threads: true };
    this.replies = [];
    this.events = [];
    this.n = 0;
  }
  async open(b) {
    this.n += 1;
    return this.isolation === "shared"
      ? { id: `fake:m:${this.n}`, address: { anchorMessageId: `anchor${this.n}`, shared: true } }
      : { id: `fake:t${this.n}`, address: { threadId: `t${this.n}` } };
  }
  createView(b) {
    const events = this.events;
    return { taskState: "idle", onEvent: (ev) => events.push({ b: b.id, ...ev }), start() {}, stop() {} };
  }
  resolveBinding(inbound) {
    const store = this.hub.store;
    if (inbound.threadKey) return store.find((x) => x.address?.threadId === inbound.threadKey);
    if (this.isolation === "shared") {
      const byQuote = inbound.quotedMessageId ? store.find((x) => x.address?.anchorMessageId === inbound.quotedMessageId) : null;
      return byQuote ?? store.binding(store.active(`fake:${inbound.chatKey}`));
    }
    return null;
  }
  async reply(inbound, r) {
    this.replies.push(r);
  }
  async closed() {}
  async refresh() {}
}

function setup(isolation) {
  const agent = new FakeAgent();
  const hub = new Hub({ cfg: { defaultAgent: "codex", channels: {}, agents: {} }, agents: new Map([["codex", agent]]), store: new Store(path.join(home, `${isolation}-${Date.now()}.json`)) });
  const ch = new FakeChannel(isolation);
  ch.hub = hub;
  hub.addChannel(ch);
  return { hub, ch, agent };
}

let mid = 0;
const msg = (text, extra = {}) => ({ chatKey: "c1", messageId: `m${++mid}`, threadKey: null, quotedMessageId: null, text, parts: [{ type: "text", text }], summary: text, ...extra });

test("thread isolation: /ht@codex opens a topic; the first message mints the session id", async () => {
  const { hub, ch, agent } = setup("thread");
  await hub.inbound(ch, msg("/ht@codex〈写周报〉"));
  const [b] = hub.store.bindings();
  assert.equal(b.agent, "codex");
  assert.equal(b.title, "写周报");
  assert.equal(b.sessionId, null);
  await hub.inbound(ch, msg("开始吧", { threadKey: b.address.threadId }));
  assert.equal(agent.sent.length, 1);
  assert.equal(hub.store.binding(b.id).sessionId, "s-new-1");
  assert.deepEqual(
    ch.events.filter((e) => e.b === b.id).map((e) => e.type),
    ["session_id", "run_start", "message", "run_end"],
  );
  // The next message resumes the minted session.
  await hub.inbound(ch, msg("继续", { threadKey: b.address.threadId }));
  assert.equal(agent.sent[1].sessionId, "s-new-1");
});

test("thread isolation: a message in an unbound topic opens a session with it as the first input", async () => {
  const { hub, ch, agent } = setup("thread");
  await hub.inbound(ch, msg("帮我查天气", { threadKey: "t-unbound" }));
  assert.equal(hub.store.bindings().length, 1);
  assert.equal(agent.sent[0].parts[0].text, "帮我查天气");
});

test("redelivered messages are processed once", async () => {
  const { hub, ch } = setup("thread");
  const m = msg("/ht");
  await hub.inbound(ch, m);
  await hub.inbound(ch, m);
  assert.equal(hub.store.bindings().length, 1);
});

test("attach is idempotent per session", async () => {
  const { hub, ch } = setup("thread");
  await hub.inbound(ch, msg("/ht@codex 最近"));
  await hub.inbound(ch, msg("/ht@codex 0000aaaa"));
  assert.equal(hub.store.bindings().length, 1);
  assert.match(ch.replies.at(-1).text, /已经接过了/);
});

test("shared isolation: quote routes to that session, otherwise the active one", async () => {
  const { hub, ch, agent } = setup("shared");
  await hub.inbound(ch, msg("/ht〈A〉"));
  await hub.inbound(ch, msg("/ht〈B〉"));
  const [a, b] = hub.store.bindings();
  // B was opened last, so it is active.
  await hub.inbound(ch, msg("给 B"));
  assert.equal(agent.sent.at(-1).parts[0].text, "给 B");
  assert.equal(hub.store.binding(b.id).sessionId, "s-new-1");
  // Quoting A's anchor routes to A.
  await hub.inbound(ch, msg("给 A", { quotedMessageId: a.address.anchorMessageId }));
  assert.equal(hub.store.binding(a.id).sessionId, "s-new-2");
  // /ht-use switches the active session.
  await hub.inbound(ch, msg("/ht-use s-new-2"));
  await hub.inbound(ch, msg("还是给 A"));
  assert.equal(agent.sent.at(-1).sessionId, "s-new-2");
});

test("own injections are not echoed back as agent-side messages", async () => {
  const { hub, ch } = setup("thread");
  await hub.inbound(ch, msg("/ht"));
  const [b] = hub.store.bindings();
  await hub.send(b.id, [{ type: "text", text: "你好" }]);
  const before = ch.events.length;
  hub.link(b.id).emit({ type: "user_text", text: "你好" });
  assert.equal(ch.events.length, before);
  hub.link(b.id).emit({ type: "user_text", text: "在 Agent 里打的字" });
  assert.equal(ch.events.at(-1).type, "user_text");
});

test("stop words during a run stop it; /ht-close unbinds", async () => {
  const { hub, ch } = setup("thread");
  await hub.inbound(ch, msg("/ht"));
  const [b] = hub.store.bindings();
  hub.views.get(b.id).taskState = "running";
  await hub.inbound(ch, msg("停", { threadKey: b.address.threadId }));
  assert.match(ch.replies.at(-1).text, /已停止/);
  await hub.inbound(ch, msg("/ht-close", { threadKey: b.address.threadId }));
  assert.equal(hub.store.bindings().length, 0);
});

test("a channel's agent allow-list is enforced", async () => {
  const { hub, ch } = setup("thread");
  ch.options.allowedAgents = ["penguin"];
  await hub.inbound(ch, msg("/ht@codex"));
  assert.equal(hub.store.bindings().length, 0);
  assert.equal(ch.replies.at(-1).kind, "error");
});

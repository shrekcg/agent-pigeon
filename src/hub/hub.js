/**
 * The hub: channels above, agents below, bindings in between.
 *
 * A binding ties one agent session to one place in one channel. The hub owns the bindings
 * (store), routes channel inbound to the bound agent session, routes the agent's events to
 * the binding's channel view, and keeps the bookkeeping both sides share: the session id an
 * agent mints on its first run, title follow-ups, own-text echo suppression, the last
 * instruction (retry), stale-card recovery, and the archived-session sweep.
 *
 * Commands (`/ht …`) are parsed here and executed by `commands.js`; channels only render.
 */
import fs from "node:fs";
import { paths } from "../core/paths.js";
import { log } from "../core/log.js";
import { Store } from "../core/store.js";
import { isStopIntent, parseCommand, splitQueuePrefix } from "../core/commands.js";
import { runCommand } from "./commands.js";

const SESSION_SWEEP_MS = 24 * 60 * 60_000;

export class Hub {
  constructor({ cfg, agents, store = null }) {
    this.cfg = cfg;
    this.agents = agents; // id → adapter
    this.channels = new Map(); // id → channel
    this.store = store ?? new Store();
    this.views = new Map(); // binding id → channel view
    this.stops = new Map(); // binding id → adapter attach stop
    this.links = new Map(); // binding id → adapter-facing link
    this.sessionCache = new Map(); // `${agent}` → { at, byId }
    this.lastUserText = new Map(); // binding id → last instruction
    this.lastPausedNoticeAt = 0;
    this.startedAt = new Date();
  }

  isPaused() {
    return fs.existsSync(paths.paused);
  }

  setPaused(value) {
    if (value) fs.writeFileSync(paths.paused, new Date().toISOString());
    else fs.rmSync(paths.paused, { force: true });
  }

  addChannel(channel) {
    this.channels.set(channel.id, channel);
  }

  /** Brings every channel and every stored binding up. Channel failures are logged, not fatal. */
  async start() {
    for (const ch of this.channels.values()) {
      try {
        await ch.start();
        log(`渠道已启动 · ${ch.label} · ${ch.status().detail ?? ""}`);
      } catch (err) {
        log(`渠道启动失败 · ${ch.label}`, err?.message ?? err);
      }
    }
    await this.closeOpenCards("启动").catch((err) => log("启动收尾遗留卡片失败", err));
    for (const b of this.store.bindings()) this.#activate(b);
    this.#startSweep();
  }

  async shutdown(reason = "退出") {
    await this.closeOpenCards(reason).catch(() => {});
    for (const a of this.agents.values()) await a.shutdown().catch(() => {});
  }

  // ——— bindings ————————————————————————————————————————————————————————————————————————

  /**
   * The adapter-facing link of a binding: identity + an emit that reaches the view. The same
   * object is handed out every time, so an adapter holding it sees the session id the
   * binding learns after its first run.
   */
  link(bindingId) {
    const b = this.store.binding(bindingId);
    if (!b) return null;
    let l = this.links.get(bindingId);
    if (!l) {
      l = { bindingId, threadId: bindingId, agent: b.agent, emit: (ev) => this.#onAgentEvent(bindingId, ev) };
      this.links.set(bindingId, l);
    }
    return Object.assign(l, { sessionId: b.sessionId, cwd: b.cwd, title: b.title });
  }

  #activate(b) {
    const channel = this.channels.get(b.channel);
    const adapter = this.agents.get(b.agent);
    if (!channel || !adapter) return;
    if (!this.views.has(b.id)) this.views.set(b.id, channel.createView(b, adapter));
    if (b.sessionId && !this.stops.has(b.id) && adapter.capabilities.mirrorsOwnSide) {
      this.stops.set(b.id, adapter.attach(this.link(b.id)) ?? (() => {}));
    }
  }

  #onAgentEvent(bindingId, ev) {
    const b = this.store.binding(bindingId);
    if (!b) return;
    if (ev.type === "session_id" && ev.sessionId && ev.sessionId !== b.sessionId) {
      this.store.updateBinding(bindingId, { sessionId: ev.sessionId });
      this.link(bindingId);
      log("绑定拿到会话 ID", bindingId, b.agent, ev.sessionId);
    } else if (ev.type === "title" && ev.title) {
      const placeholder = b.title === "新会话" || b.title === "" || /^会话 [0-9a-z]{6,}$/i.test(b.title ?? "");
      if (!placeholder || b.title === ev.title) return;
      this.store.updateBinding(bindingId, { title: ev.title });
      this.link(bindingId);
    } else if (ev.type === "user_text") {
      if (typeof ev.text === "string") this.lastUserText.set(bindingId, ev.text);
      if (this.store.consumeSent(bindingId, ev.text)) return; // our own injection coming back
    }
    this.views.get(bindingId)?.onEvent(ev);
  }

  /**
   * Creates a binding for `{ agent, session }` in `channel` (opening the platform place).
   * Idempotent per channel + session: an existing binding is returned as `already`.
   */
  async bind(channel, { agent, session, title = null, ctx = null }) {
    const existing = session.sessionId ? this.store.bySession(agent, session.sessionId, channel.id) : null;
    if (existing) return { binding: existing, already: true };
    const draft = {
      id: null,
      channel: channel.id,
      agent,
      sessionId: session.sessionId ?? null,
      cwd: session.cwd ?? null,
      model: session.model ?? null,
      title: title ?? session.title ?? "新会话",
      createdAt: new Date().toISOString(),
    };
    const { id, address } = await channel.open(draft, { ctx });
    const binding = { ...draft, id, address };
    delete binding.model;
    this.store.putBinding(binding);
    if (channel.isolation === "shared" && ctx?.chatKey) this.store.setActive(`${channel.id}:${ctx.chatKey}`, id);
    this.#activate(binding);
    log("已建立绑定", { id, agent, sessionId: binding.sessionId, title: binding.title });
    return { binding, already: false };
  }

  /** Takes a binding offline: mirror stops, a live card is frozen, the place says so. */
  async unbind(bindingId, { reason = "手动下线", notify = true } = {}) {
    const b = this.store.binding(bindingId);
    if (!b) return false;
    try {
      this.stops.get(bindingId)?.();
    } catch {
      /* gone */
    }
    this.stops.delete(bindingId);
    this.views.get(bindingId)?.stop();
    this.views.delete(bindingId);
    this.links.delete(bindingId);
    const channel = this.channels.get(b.channel);
    const open = this.store.openCards()[bindingId];
    if (open?.cardId && channel?.closeStaleCard) void channel.closeStaleCard(bindingId, { ...open, note: `${reason}，本卡在此冻结` });
    this.store.removeBinding(bindingId);
    if (notify && channel) void channel.closed(b, reason);
    log("绑定已下线", bindingId, b.agent, b.sessionId, reason);
    return true;
  }

  // ——— inbound ——————————————————————————————————————————————————————————————————————————

  async inbound(channel, inbound) {
    if (this.store.seenBefore(inbound.messageId)) return; // platforms redeliver
    this.store.rememberSeen(inbound.messageId);

    const cmd = inbound.text !== null ? parseCommand(inbound.text) : null;
    if (cmd) {
      await runCommand(this, channel, cmd, inbound);
      return;
    }
    const binding = channel.resolveBinding(inbound);
    if (binding) {
      await this.#toBinding(channel, binding, inbound);
      return;
    }
    if (inbound.threadKey || channel.isolation === "shared") {
      // An unbound topic (or a shared chat with nothing active): this message opens a session.
      await runCommand(this, channel, { kind: "new", agent: undefined, firstInput: inbound }, inbound);
      return;
    }
    await channel.reply(inbound, { kind: "help", agents: await this.agentRows(), defaultAgent: this.cfg.defaultAgent });
  }

  async #toBinding(channel, binding, inbound) {
    const adapter = this.agents.get(binding.agent);
    if (!adapter) {
      await channel.reply(inbound, { kind: "error", text: `这个会话的 Agent「${binding.agent}」已在配置里关闭。` });
      return;
    }
    if (this.isPaused()) {
      if (Date.now() - this.lastPausedNoticeAt > 60_000) {
        this.lastPausedNoticeAt = Date.now();
        await channel.reply(inbound, { kind: "text", text: "镜像已暂停（本地配置页或 `ht resume` 可恢复）。", bindingId: binding.id });
      }
      return;
    }
    const view = this.views.get(binding.id);
    if (inbound.text !== null && isStopIntent(inbound.text) && view?.taskState === "running") {
      const out = await this.stop(binding.id).catch((err) => ({ error: err }));
      const text = out?.error ? `停止失败：${String(out.error?.message ?? out.error).slice(0, 100)}` : "已停止本轮运行。";
      await channel.reply(inbound, { kind: "text", text, bindingId: binding.id });
      return;
    }
    const parsed = splitQueuePrefix(inbound.text);
    const parts = inbound.text === null ? inbound.parts : [{ type: "text", text: parsed.text }];
    const mode = parsed.queue || inbound.text === null ? "queue" : "steer";
    try {
      const res = await this.send(binding.id, parts, { mode, summary: inbound.text === null ? inbound.summary : parsed.text });
      if (res.steered) await channel.reply(inbound, { kind: "text", text: "已插话：这条会并入当前运行（在下一次工具调用时带上）。", bindingId: binding.id });
      else if (res.queued) {
        const ahead = Number.isInteger(res.ahead) ? res.ahead : Number.isInteger(view?.queuedCount) ? view.queuedCount - 1 : null;
        const where = ahead !== null && ahead > 0 ? `（前面还有 ${ahead} 条）` : "";
        await channel.reply(inbound, { kind: "text", text: `已排队${where}：会话正在忙，轮到你这条会自动开始。`, bindingId: binding.id });
      }
    } catch (err) {
      log("注入失败", binding.id, err);
      await channel.reply(inbound, { kind: "text", text: `没能送进会话：${String(err?.message ?? err).slice(0, 160)}`, bindingId: binding.id });
    }
  }

  // ——— actions (commands, buttons, admin API) ———————————————————————————————————————————

  async send(bindingId, parts, { mode = "steer", summary = null } = {}) {
    const b = this.store.binding(bindingId);
    if (!b) throw new Error("这个绑定已经不存在");
    const adapter = this.agents.get(b.agent);
    if (!adapter) throw new Error(`Agent「${b.agent}」未启用`);
    const shown = summary ?? parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
    this.store.rememberSent(bindingId, shown);
    this.lastUserText.set(bindingId, shown);
    const res = await adapter.send(this.link(bindingId), parts, { mode });
    // A session the adapter just created (pending id) starts mirroring once it has an id.
    const fresh = this.store.binding(bindingId);
    if (fresh?.sessionId) this.#activate(fresh);
    return res ?? {};
  }

  injectText(bindingId, text) {
    return this.send(bindingId, [{ type: "text", text }], { mode: "queue" });
  }

  async stop(bindingId) {
    const b = this.store.binding(bindingId);
    const adapter = b ? this.agents.get(b.agent) : null;
    if (!adapter) throw new Error("找不到这个会话");
    return await adapter.abort(this.link(bindingId));
  }

  async decide(bindingId, toolCallId, decision) {
    const b = this.store.binding(bindingId);
    const adapter = b ? this.agents.get(b.agent) : null;
    if (!adapter) throw new Error("找不到这个会话");
    return await adapter.decide(this.link(bindingId), toolCallId, decision);
  }

  // ——— helpers ——————————————————————————————————————————————————————————————————————————

  async agentRows() {
    const rows = [];
    for (const [id, a] of this.agents) {
      const st = await a.available().catch((err) => ({ ok: false, reason: String(err?.message ?? err) }));
      rows.push({
        id,
        label: a.label,
        ok: st.ok,
        reason: st.reason ?? null,
        capabilities: a.capabilities,
        topics: this.store.bindings().filter((b) => b.agent === id).length,
      });
    }
    return rows;
  }

  /** Session info for a binding, cached 60 s per agent (cards only want model + cwd). */
  async sessionInfoCached(b) {
    if (!b?.sessionId) return null;
    const adapter = this.agents.get(b.agent);
    if (!adapter) return null;
    const key = `${b.agent}:${b.sessionId}`;
    const hit = this.sessionCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.info;
    const info = await adapter.getSession(b.sessionId).catch(() => null);
    this.sessionCache.set(key, { at: Date.now(), info });
    return info;
  }

  /** Closes every card recorded as open (boot: a previous process died with them). */
  async closeOpenCards(reason) {
    for (const [bindingId, info] of Object.entries(this.store.openCards())) {
      const b = this.store.binding(bindingId);
      const channel = this.channels.get(b?.channel ?? "feishu");
      if (!info?.cardId || !channel?.closeStaleCard) {
        this.store.clearOpenCard(bindingId);
        continue;
      }
      const closed = await channel.closeStaleCard(bindingId, info).catch(() => false);
      if (closed) this.store.clearOpenCard(bindingId);
      else log("遗留卡片收尾失败", reason, bindingId, info.cardId);
    }
  }

  /** A binding whose session is archived or deleted can never take a message: take it offline. */
  #startSweep() {
    const tick = () => void this.sweep().catch((err) => log("会话巡检失败", err?.message ?? err));
    tick();
    const timer = setInterval(tick, SESSION_SWEEP_MS);
    if (typeof timer.unref === "function") timer.unref();
  }

  async sweep() {
    let closed = 0;
    for (const [id, adapter] of this.agents) {
      if (!adapter.capabilities.sweep) continue;
      const bound = this.store.bindings().filter((b) => b.agent === id && b.sessionId);
      if (bound.length === 0) continue;
      const sessions = await adapter.listSessions({ includeArchived: true, limit: 2000 });
      const byId = new Map(sessions.map((s) => [s.sessionId, s]));
      for (const b of bound) {
        const s = byId.get(b.sessionId);
        if (!s && (await this.unbind(b.id, { reason: "会话已被删除" }))) closed += 1;
        else if (s?.archived && (await this.unbind(b.id, { reason: "会话已归档" }))) closed += 1;
      }
    }
    if (closed > 0) log("会话巡检：已下线", closed, "个");
    return closed;
  }
}

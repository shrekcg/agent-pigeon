/**
 * The Feishu channel. One app, one chat (the bot's DM with the user), WebSocket long
 * connection for events, REST + CardKit for output.
 *
 * Thread isolation: a binding is a topic — an anchor 名片 whose first line is
 * `[Agent] 会话标题`, with every reply threaded under it. Shared isolation: one anchor card per
 * binding in the main timeline; output is labelled with the session's name, and an inbound
 * goes to the binding of the message it quotes, else to the chat's active binding.
 */
import { log } from "../../core/log.js";
import { displayTitle, handleOf } from "../../core/format.js";
import { agentLabel } from "../../agents/base.js";
import { Channel } from "../base.js";
import { Feishu } from "./client.js";
import { RunCards } from "./runcard.js";
import { FeishuView } from "./view.js";
import { inboundMedia, textOf } from "./inbound.js";
import * as cards from "./cards.js";

export class FeishuChannel extends Channel {
  constructor(options, hub) {
    super("feishu", options, hub);
    this.capabilities = { threads: true, cards: true, streaming: true, buttons: true, reactions: true, media: true };
    this.feishu = null;
    this.runCards = null;
    this.cardRegistry = new Map(); // our card messageId → { kind, bindingId, … }
    this.approvalCardsSent = new Map(); // toolCallId → sentAt (pending approvals are redelivered)
    this.messageBinding = new Map(); // shared mode: our messageId → bindingId
    this.state = { ok: false, reason: "未启动" };
  }

  get label() {
    return "飞书";
  }

  get chatId() {
    return this.options.chatId;
  }

  status() {
    return this.state;
  }

  async start() {
    if (!this.options.appId || !this.options.appSecret) {
      this.state = { ok: false, reason: "找不到飞书应用凭据（config.json 或 PenguinHarness 的飞书绑定）" };
      throw new Error(this.state.reason);
    }
    if (!this.chatId) {
      this.state = { ok: false, reason: "找不到 chatId：先在飞书里给机器人发过一条消息" };
      throw new Error(this.state.reason);
    }
    this.feishu = new Feishu(this.options);
    this.runCards = new RunCards(this.feishu);
    this.feishu.startEvents({
      onMessage: (data) => void this.#onMessage(data).catch((err) => log("飞书 inbound 处理失败", err)),
      onCardAction: (data) => this.#onCardAction(data),
      onReaction: (data) => this.#onReaction(data),
    });
    this.state = { ok: true, detail: `凭据来自 ${this.options.credentialSource ?? "config.json"}` };
  }

  createView(binding, adapter) {
    return new FeishuView(this, binding, adapter);
  }

  trackMessage(messageId, bindingId) {
    this.messageBinding.set(messageId, bindingId);
    if (this.messageBinding.size > 3000) {
      const drop = [...this.messageBinding.keys()].slice(0, 1000);
      for (const k of drop) this.messageBinding.delete(k);
    }
  }

  // ——— inbound ——————————————————————————————————————————————————————————————————————

  async #onMessage(data) {
    const msg = data?.message;
    const sender = data?.sender;
    if (!msg || !sender) return;
    if (msg.chat_id !== this.chatId) return; // another chat; not ours
    if (sender.sender_type !== "user") return; // events from bots are not inputs
    const text = textOf(msg);
    let parts;
    let summary;
    if (text === null) {
      const media = await inboundMedia(this.feishu, msg);
      if (media.notice) {
        await this.feishu.replyText(msg.message_id, media.notice, { replyInThread: Boolean(msg.thread_id) }).catch(() => {});
        return;
      }
      parts = media.parts;
      summary = media.summary;
    } else {
      parts = [{ type: "text", text }];
      summary = text;
    }
    await this.hub.inbound(this, {
      chatKey: this.chatId,
      messageId: msg.message_id,
      threadKey: msg.thread_id ?? null,
      quotedMessageId: msg.parent_id ?? null,
      text,
      parts,
      summary,
    });
  }

  /** Thread mode routes by topic; shared mode by quoted message, then the active binding. */
  resolveBinding(inbound) {
    const store = this.hub.store;
    if (inbound.threadKey) {
      const b = store.find((x) => x.channel === this.id && x.address?.threadId === inbound.threadKey);
      if (b) return b;
    }
    if (this.isolation === "shared" && !inbound.threadKey) {
      const quoted = inbound.quotedMessageId ? this.messageBinding.get(inbound.quotedMessageId) : null;
      const anchor = inbound.quotedMessageId ? store.find((x) => x.channel === this.id && x.address?.anchorMessageId === inbound.quotedMessageId) : null;
      const id = quoted ?? anchor?.id ?? store.active(`${this.id}:${inbound.chatKey}`);
      return id ? store.binding(id) : null;
    }
    return null;
  }

  // ——— conversations ——————————————————————————————————————————————————————————————————

  #nameCard(b, status = "已接入") {
    return cards.nameCard({ agent: b.agent, title: b.title, sessionId: b.sessionId, model: b.model ?? null, workspace: b.cwd, status });
  }

  /**
   * Opens the place for a new binding. Thread isolation: anchor card + first threaded reply
   * (which creates the topic). Shared isolation: an anchor card in the timeline.
   */
  async open(binding, { intro = null } = {}) {
    const anchor = await this.feishu.sendCard(this.chatId, this.#nameCard(binding, binding.sessionId ? "已接入" : "新会话"));
    const hello = intro ?? `已接入。在本话题内发言即可与这个会话对话。（${agentLabel(binding.agent)} · 会话 ${handleOf(binding.sessionId)}）`;
    if (this.isolation === "shared") {
      this.trackMessage(anchor.message_id, binding.id);
      return { id: `${this.id}:m:${anchor.message_id}`, address: { chatId: this.chatId, anchorMessageId: anchor.message_id, shared: true } };
    }
    const reply = await this.feishu.replyText(anchor.message_id, hello, { replyInThread: true });
    const threadId = reply.thread_id ?? anchor.thread_id;
    if (!threadId) throw new Error("话题创建失败：回复没有返回 thread_id");
    return { id: `${this.id}:${threadId}`, address: { threadId, rootMessageId: anchor.message_id } };
  }

  async refresh(binding) {
    const a = binding?.address ?? {};
    const mid = a.rootMessageId ?? a.anchorMessageId;
    if (!mid) return;
    await this.feishu.patchCard(mid, this.#nameCard(binding));
  }

  async closed(binding, reason) {
    const a = binding?.address ?? {};
    const mid = a.rootMessageId ?? a.anchorMessageId;
    if (!mid) return;
    const text = a.shared
      ? `「${displayTitle(binding.agent, binding.title)}」已下线（${reason}）。`
      : `已下线（${reason}）：本话题不再连接任何会话。之后在这里发消息会新建一个会话；要接回旧会话，发 /ht〈ID前缀〉。`;
    await this.feishu.replyText(mid, text, { replyInThread: !a.shared }).catch((err) => log("下线通知发送失败", binding.id, err?.message ?? err));
  }

  async ask(binding, { question, options, questionId }) {
    const view = this.hub.views.get(binding.id);
    const sent = await (view ?? this.createView(binding, null)).sayCard(cards.askCard({ question, options, bindingId: binding.id, questionId }));
    if (sent?.message_id) this.cardRegistry.set(sent.message_id, { kind: "ask", bindingId: binding.id, question, questionId });
    return { messageId: sent?.message_id ?? null };
  }

  /** Hub replies to an inbound (commands, notices). */
  async reply(inbound, r) {
    const target = inbound.messageId;
    const inThread = Boolean(inbound.threadKey);
    const card = (c) => this.feishu.replyCard(target, c, { replyInThread: inThread });
    switch (r.kind) {
      case "help":
        return card(cards.helpCard({ agents: r.agents, defaultAgent: r.defaultAgent, isolation: this.isolation }));
      case "agents":
        return card(cards.agentsCard(r.rows));
      case "list":
        return card(cards.listCard({ agent: r.agent, sessions: r.sessions, maps: r.bindings }));
      case "error":
        return card(cards.errorCard(r.text));
      default: {
        const res = await this.feishu.replyText(target, r.text, { replyInThread: inThread });
        if (r.bindingId && this.isolation === "shared") this.trackMessage(res?.message_id, r.bindingId);
        return res;
      }
    }
  }

  // ——— stale cards ——————————————————————————————————————————————————————————————————————

  /** Replaces a card nobody will finalize with a static, button-less notice. */
  async closeStaleCard(bindingId, info) {
    const note = info.note ?? "Agent 信鸽重启，本卡内容在此冻结（本轮已结束）· 后续回答见下方消息";
    const card = {
      schema: "2.0",
      header: { title: { tag: "plain_text", content: info.title ?? "会话" }, icon: { tag: "standard_icon", token: "pause-round_filled", color: "grey" } },
      config: { streaming_mode: false, summary: { content: note } },
      body: {
        elements: [
          { tag: "markdown", content: "（上一轮的中继进程已退出，本卡内容在此冻结；该轮余下的回答见后续消息。）", element_id: "answer" },
          { tag: "markdown", content: "", element_id: "steps" },
          { tag: "markdown", content: note, element_id: "status" },
        ],
      },
    };
    // The card's sequence is not persisted, so climb a ladder well above any counter this
    // relay uses (it increments by one per update) until the platform accepts one.
    for (const seq of [1_000_000_000, 1_500_000_000, 2_000_000_000]) {
      try {
        await this.feishu.updateCardEntity(info.cardId, card, seq);
        await this.feishu.patchCardSettings(info.cardId, { streaming_mode: false, summary: { content: note } }, seq + 1).catch(() => {});
        log("遗留卡片已收尾", bindingId, info.cardId);
        return true;
      } catch (err) {
        if (err?.code !== 300317) {
          log("遗留卡片收尾失败", bindingId, err?.message ?? err);
          return false;
        }
      }
    }
    log("遗留卡片收尾失败（序号冲突）", bindingId, info.cardId);
    return false;
  }

  // ——— card buttons & reactions ——————————————————————————————————————————————————————————

  /**
   * A click on a card button. The platform treats this as request/response: the receipt
   * (a toast) must come back promptly, so the work is awaited only as far as needed.
   */
  async #onCardAction(data) {
    try {
      const chatId = data?.context?.open_chat_id ?? data?.open_chat_id ?? null;
      if (chatId !== null && chatId !== this.chatId) return { toast: { type: "error", content: "不在允许的会话中" } };
      const value = data?.action?.value ?? {};
      const messageId = data?.context?.open_message_id ?? data?.open_message_id ?? null;
      const bindingId = value.bindingId ?? (value.threadId ? `feishu:${value.threadId}` : null);
      const fail = (prefix, err) => ({ toast: { type: "error", content: `${prefix}：${String(err?.message ?? err).slice(0, 60)}` } });
      switch (value.action) {
        case "stop": {
          const out = await this.hub.stop(bindingId).catch((err) => ({ error: err }));
          if (out?.error) return fail("停止失败", out.error);
          return { toast: { type: "info", content: out.running ? "已请求停止…" : "当前没有正在运行的任务" } };
        }
        case "approve":
        case "deny": {
          const decision = value.action === "approve" ? "allow" : "deny";
          const out = await this.hub.decide(bindingId, value.toolCallId, decision).catch((err) => ({ error: err }));
          if (out?.error) return fail("处理失败", out.error);
          if (messageId) {
            const next = out?.stale ? cards.approvalGoneCard({ toolName: value.toolName }) : cards.approvalDecidedCard({ decision, toolName: value.toolName });
            void this.feishu.patchCard(messageId, next).catch((err) => log("审批卡更新失败", err));
          }
          if (out?.stale) return { toast: { type: "info", content: "这条审批已处理过（卡片已同步）" } };
          return { toast: { type: "info", content: decision === "allow" ? "已允许" : "已拒绝" } };
        }
        case "answer": {
          const answer = String(value.answer ?? data?.action?.form_value?.answer ?? "").trim();
          if (answer === "") return { toast: { type: "error", content: "没有回答内容" } };
          const tracked = messageId ? this.cardRegistry.get(messageId) : null;
          const out = await this.hub.injectText(bindingId, answer).catch((err) => ({ error: err }));
          if (out?.error) return fail("提交失败", out.error);
          if (messageId) {
            void this.feishu.patchCard(messageId, cards.askAnsweredCard({ question: tracked?.question ?? "（问题）", answer })).catch(() => {});
          }
          return { toast: { type: "success", content: "已收到回答" } };
        }
        default:
          log("卡片操作未识别", JSON.stringify(value).slice(0, 120));
          return { toast: { type: "error", content: "这张卡片没有再可执行的操作" } };
      }
    } catch (err) {
      log("card action 处理失败", err);
      return { toast: { type: "error", content: "处理失败" } };
    }
  }

  /**
   * Reactions on our approval cards act like their buttons (the fastest interaction on a
   * phone): DONE/THUMBSUP/OK allow, CROSS_MARK/THUMBDOWN deny. Reactions elsewhere are ignored.
   */
  #onReaction(data) {
    try {
      if (data?.operator_type === "app") return;
      const messageId = data?.message_id ?? "";
      const emoji = String(data?.reaction_type?.emoji_type ?? "").toUpperCase();
      const tracked = this.cardRegistry.get(messageId);
      if (!tracked || tracked.kind !== "approval") return;
      const isAllow = ["DONE", "THUMBSUP", "OK"].includes(emoji);
      if (!isAllow && !["CROSS_MARK", "THUMBDOWN"].includes(emoji)) return;
      const decision = isAllow ? "allow" : "deny";
      log("收到表情审批", messageId, emoji, decision);
      void this.hub
        .decide(tracked.bindingId, tracked.toolCallId, decision)
        .then((out) => {
          const next = out?.stale ? cards.approvalGoneCard({ toolName: tracked.toolName }) : cards.approvalDecidedCard({ decision, toolName: tracked.toolName });
          return this.feishu.patchCard(messageId, next);
        })
        .catch((err) => log("表情审批提交失败", err));
    } catch (err) {
      log("reaction 处理失败", err);
    }
  }

  /** Self-test hook (admin API): drive the handlers as the platform would. */
  async debugEvent(kind, payload) {
    if (kind === "message") {
      await this.#onMessage(payload);
      return { routed: "message" };
    }
    if (kind === "card") return { routed: "card", result: await this.#onCardAction(payload) };
    if (kind === "reaction") {
      this.#onReaction(payload);
      return { routed: "reaction" };
    }
    throw new Error("kind must be message|card|reaction");
  }
}

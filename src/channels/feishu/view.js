/**
 * The Feishu rendering of one binding: the agent's events for a session come in here and
 * become Feishu output — a streaming process card per run, the run's conclusion as its own
 * card, reply files, failure notices, approval cards, title follow-ups and own-side echoes.
 *
 * Thread isolation writes everything into the binding's topic. Shared isolation writes into
 * the one chat, every card and line labelled with the session's display name, and records
 * each message it sends so a quoted reply routes back to this binding.
 *
 * All writes of a binding go through `chain` (ordering); cards through RunCard's own op
 * chain (sequence numbers).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "../../core/log.js";
import { idleEdge, extractFilePaths } from "../../core/commands.js";
import { displayTitle } from "../../core/format.js";
import * as cards from "./cards.js";

export class FeishuView {
  constructor(channel, binding, adapter) {
    this.channel = channel;
    this.hub = channel.hub;
    this.bindingId = binding.id;
    this.threadId = binding.id; // log label
    this.adapter = adapter;
    this.chain = Promise.resolve();
    // Resolves once the previous run's conclusion is in the chat: a queued follow-up's card
    // waits for it, so the reading order stays question → process → answer, run after run.
    this.settled = Promise.resolve();
    this.runSeen = false;
    this.taskState = "idle";
    this.runCard = null;
    this.runText = "";
    this.lastAssistantText = null;
    this.runStartedAt = null;
    this.lastRunFailure = null;
    this.runStopped = false;
    this.queuedCount = null;
    this.lastEventAt = 0;
    this.stopAttach = null;
  }

  get binding() {
    return this.hub.store.binding(this.bindingId);
  }

  get feishu() {
    return this.channel.feishu;
  }

  get shared() {
    return this.binding?.address?.shared === true;
  }

  /** Where replies go: the topic's root (thread mode) or the binding's anchor in the chat. */
  get replyTo() {
    const a = this.binding?.address ?? {};
    return a.rootMessageId ?? a.anchorMessageId;
  }

  #label() {
    const b = this.binding;
    return displayTitle(b?.agent, b?.title);
  }

  /** Text into the binding's place; shared mode prefixes the session's name. */
  async say(text) {
    const body = this.shared ? `【${this.#label()}】\n${text}` : text;
    const res = await this.feishu.replyText(this.replyTo, body, { replyInThread: !this.shared });
    this.#track(res);
    return res;
  }

  async sayCard(card) {
    const res = await this.feishu.replyCard(this.replyTo, card, { replyInThread: !this.shared });
    this.#track(res);
    return res;
  }

  /** Shared mode: remember which binding a message belongs to, so a quote routes back. */
  #track(res) {
    if (this.shared && res?.message_id) this.channel.trackMessage(res.message_id, this.bindingId);
  }

  start() {}

  stop() {}

  // ——— event dispatch ————————————————————————————————————————————————————————————————

  onEvent(ev) {
    this.lastEventAt = Date.now();
    try {
      switch (ev.type) {
        case "run_start":
          return this.#onRunStart();
        case "run_end":
          return this.#onRunEnd();
        case "thinking": {
          const card = this.#card();
          if (card) {
            card.onThinking();
            void card.ensureSent();
          }
          return undefined;
        }
        case "tool_call":
        case "tool_result": {
          const card = this.#card();
          if (card) {
            card.onToolEvent(ev.type === "tool_call" ? "call" : "output", ev.name, ev.id);
            if (ev.type === "tool_call") void card.ensureSent();
          }
          return undefined;
        }
        case "text_start": {
          const card = this.#card();
          if (card && !card.dead) {
            card.startPartial();
            void card.ensureSent();
          }
          return undefined;
        }
        case "text_delta": {
          const card = this.#card();
          if (card && !card.dead && typeof ev.text === "string") {
            void card.ensureSent();
            card.pushDelta(ev.text);
          }
          return undefined;
        }
        case "message":
          return void this.#assistantText(ev.text);
        case "user_text":
          return this.#ownSideUserText(ev.text);
        case "failure":
          this.lastRunFailure = { status: "failed", code: ev.code ?? null, message: ev.message ?? null };
          log("本轮请求失败", this.threadId, this.binding?.agent, ev.code ?? "", String(ev.message ?? "").slice(0, 140));
          return undefined;
        case "stopped":
          this.lastRunFailure = null;
          this.runStopped = true;
          return undefined;
        case "queued":
          this.queuedCount = ev.count;
          return undefined;
        case "session_id":
          return this.#onSessionId(ev.sessionId);
        case "title":
          return this.#onTitle(ev.title);
        case "approval":
          return this.#onApproval(ev);
        default:
          return undefined;
      }
    } catch (err) {
      log("事件处理失败", this.threadId, ev?.type, err);
      return undefined;
    }
  }

  #card() {
    return this.runCard ?? this.channel.runCards.current(this.bindingId);
  }

  #onSessionId() {
    // The hub stored the id; the name card shows it from now on.
    void this.channel.refresh(this.binding).catch(() => {});
  }

  #onTitle() {
    void this.channel.refresh(this.binding).catch((err) => log("名片标题更新失败", err));
  }

  #onApproval({ toolCallId, toolName }) {
    if (this.hub.isPaused()) return;
    const sent = this.channel.approvalCardsSent;
    // Pending approvals are resent on reconnect: one card per tool call, never two.
    const at = toolCallId ? sent.get(toolCallId) : undefined;
    if (at && Date.now() - at < 10 * 60_000) return;
    if (toolCallId) {
      sent.set(toolCallId, Date.now());
      const cutoff = Date.now() - 10 * 60_000;
      for (const [id, t] of sent) if (t < cutoff) sent.delete(id);
    }
    this.chain = this.chain
      .then(async () => {
        const res = await this.sayCard(cards.approvalCard({ toolName, toolCallId, bindingId: this.bindingId }));
        if (res?.message_id) {
          this.channel.cardRegistry.set(res.message_id, { kind: "approval", bindingId: this.bindingId, toolCallId, toolName });
          log("审批卡已发送", { messageId: res.message_id, toolCallId, toolName, threadId: this.threadId });
        }
      })
      .catch((err) => log("审批提醒发送失败", err));
  }

  #ownSideUserText(shown) {
    if (typeof shown !== "string" || shown.trim() === "") return;
    const text = `[${this.adapter?.label ?? "Agent"} 端] ${shown}`;
    this.chain = this.chain.then(() => this.deliver(text));
  }

  // ——— run edges ——————————————————————————————————————————————————————————————————————

  #onRunStart() {
    // Penguin re-announces `running` during one run (each tool round): one run, one card.
    if (this.taskState === "running" && this.runCard && !this.runCard.closing) return;
    this.taskState = "running";
    this.runSeen = true;
    this.runText = "";
    this.lastAssistantText = null; // the conclusion of THIS run, not the previous one's
    this.runStartedAt = Date.now();
    this.lastRunFailure = null;
    this.runStopped = false;
    const b = this.binding;
    const card = this.channel.runCards.begin(this.bindingId, {
      replyTo: this.replyTo,
      inThread: !this.shared,
      agentLabel: this.adapter?.label,
      heading: this.shared ? this.#label() : "执行过程",
      canStop: this.adapter?.capabilities.abort !== false,
      title: b?.title ?? "会话",
      isPaused: () => this.hub.isPaused(),
      after: this.settled,
      onSent: (messageId) => {
        this.channel.cardRegistry.set(messageId, { kind: "run", bindingId: this.bindingId });
        this.#track({ message_id: messageId });
        // Persisted, so a process that dies before this card is finalized can be closed by
        // the next boot instead of leaving a live-looking card with a 停止 button behind.
        this.hub.store.setOpenCard(this.bindingId, { cardId: card.cardId, messageId, title: b?.title ?? "会话", agent: b?.agent });
      },
    });
    log("run start", this.threadId, b?.agent, "begin card");
    this.runCard = card;
    void card.ensureSent(); // the card appears immediately: the wait is the model's, not ours
    void this.#applyModel(card);
    const timer = setTimeout(() => {
      if (this.channel.runCards.current(this.bindingId) === card && !card.sent && !card.dead) void card.heartbeat();
    }, 3500);
    if (typeof timer.unref === "function") timer.unref();
  }

  #onRunEnd() {
    this.taskState = "idle";
    if (idleEdge(this) === "snapshot") {
      // Nothing ended here: this is a connect snapshot. Drop the previous run's text so a
      // later edge cannot post a duplicate conclusion, and keep the topic untouched.
      const hadStale = (this.lastAssistantText ?? null) !== null || (this.runText ?? "") !== "";
      this.lastAssistantText = null;
      this.runText = "";
      this.runStartedAt = null;
      if (hadStale) log("忽略 idle 快照（重连），未重复发送", this.threadId);
      return;
    }
    const card = this.channel.runCards.current(this.bindingId);
    // This run is over: a queued follow-up starts within milliseconds, and it needs a card
    // of its own while this one waits out its quiet window.
    if (card) card.closing = true;
    log("run end", this.threadId, card ? `有卡(sent=${card.sent},dead=${card.dead})` : "无卡");
    if (card && this.lastRunFailure) card.noteFailure(this.lastRunFailure);
    const failure = this.lastRunFailure;
    const stopped = this.runStopped;
    const conclusion = this.lastAssistantText;
    let markSettled;
    this.settled = new Promise((r) => {
      markSettled = r;
    });
    const finish = () => {
      // Without a card there is nothing in the chat to carry the failure: say it plainly.
      if (failure && (!card || !card.sent)) {
        const text = `本轮运行失败（${failure.code ?? failure.status}）${failure.message ? `：${String(failure.message).slice(0, 200)}` : ""}`;
        void this.say(text).catch(() => {});
      }
      void this.#deliverReplyFiles().catch((err) => log("回传文件流程失败", err));
      this.channel.runCards.finish(this.bindingId, card);
      this.#postConclusion(conclusion, card);
      this.chain = this.chain.then(markSettled, markSettled);
      this.hub.store.clearOpenCard(this.bindingId); // finalized: nothing left to close after a crash
    };
    if (card) {
      // Close as soon as the run's events have gone quiet (a tool round trip can push the
      // final text past the idle frame): 500 ms of silence, or 5 s at the latest.
      const deadline = Date.now() + 5000;
      const tick = () => {
        const quiet = Date.now() - (this.lastEventAt ?? 0);
        if (quiet >= 500 || Date.now() >= deadline) {
          void card.finalize({ interrupted: stopped === true, conclusion: this.lastAssistantText ?? conclusion ?? null }).finally(finish);
          return;
        }
        const timer = setTimeout(tick, 200);
        if (typeof timer.unref === "function") timer.unref();
      };
      tick();
    } else {
      finish();
    }
    this.runCard = null;
  }

  async #applyModel(card) {
    try {
      const info = await this.hub.sessionInfoCached(this.binding);
      if (info?.model && this.channel.runCards.current(this.bindingId) === card) card.model = info.model;
    } catch {
      /* model is decorative; never let it break the run */
    }
  }

  // ——— output ———————————————————————————————————————————————————————————————————————————

  /** A completed assistant message: into the run card, or plain text when the card is down. */
  async #assistantText(text) {
    if (typeof text !== "string" || text.trim() === "") return;
    this.runText = this.runText ? `${this.runText}\n\n${text}` : text;
    this.lastAssistantText = text; // the run's conclusion, posted as its own card at the end
    const card = this.#card();
    if (card && !card.dead) {
      const ok = card.sent || (await card.ensureSent());
      if (ok) {
        card.completeMessage(text);
        return;
      }
    }
    // The card closed a moment too early (a slow tool pushed this text past the beat):
    // let it absorb the text rather than emit a stray plain-text message.
    const late = this.channel.runCards.lastCard(this.bindingId);
    if (late && late.finalized && !late.dead) {
      const absorbed = await late.absorbText(text).catch(() => false);
      if (absorbed) return;
    }
    for (const part of cards.mirrorChunks(text)) {
      this.chain = this.chain.then(() => this.deliver(part));
    }
  }

  /**
   * The run's conclusion goes out as its own card, below the question; the process card above
   * keeps the tool calls and the analysis, folded away. Only the run's last message counts.
   */
  #postConclusion(conclusion, card) {
    const text = String(conclusion ?? "").trim();
    if (text === "") return;
    this.chain = this.chain.then(async () => {
      try {
        await this.sayCard(cards.conclusionCard(text, this.shared ? this.#label() : null));
        log("结论卡已发送", this.threadId, `${text.length} 字`);
      } catch (err) {
        log("结论卡发送失败，回退文本", this.threadId, err?.message ?? err);
        for (const part of cards.mirrorChunks(text)) await this.deliver(part);
      }
    });
  }

  /**
   * Files the run's own reply mentioned follow it into the topic: path-like tokens that
   * resolve inside the session's working directory (or the relay inbox), exist, and were
   * touched by this run — pictures as pictures, the rest as attachments, capped.
   */
  async #deliverReplyFiles() {
    const text = this.runText ?? "";
    const startedAt = this.runStartedAt;
    if (text === "" || !startedAt) return;
    const candidates = extractFilePaths(text);
    if (candidates.length === 0) return;
    const info = await this.hub.sessionInfoCached(this.binding).catch(() => null);
    // Compare real paths: agents print `/tmp/…` where the recorded cwd is `/private/tmp/…`.
    const real = (p) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return null;
      }
    };
    const roots = [...new Set([info?.cwd, this.binding?.cwd].filter(Boolean).map(real).filter(Boolean))];
    if (roots.length === 0) return;
    const picked = [];
    for (const token of candidates) {
      const abs = real(token.startsWith("~/") ? path.join(os.homedir(), token.slice(2)) : token);
      if (!abs || !roots.some((r) => abs.startsWith(`${r}${path.sep}`))) continue; // outside the session's dir
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (st.mtimeMs < startedAt - 120_000) continue; // not this run's output
      if (picked.length >= 5) {
        await this.say("（还有更多文件未发送：一次运行最多回传 5 个。）").catch(() => {});
        break;
      }
      picked.push({ path: abs, name: path.basename(abs), size: st.size });
    }
    for (const f of picked) {
      try {
        const isImage = /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name);
        if (isImage && f.size <= 10 * 1024 * 1024) {
          const key = await this.feishu.uploadImage(fs.readFileSync(f.path), f.name);
          if (key) this.#track(await this.feishu.reply(this.replyTo, "image", { image_key: key }, { replyInThread: !this.shared }));
        } else if (f.size <= 30 * 1024 * 1024) {
          const key = await this.feishu.uploadFile(fs.readFileSync(f.path), f.name);
          if (key) this.#track(await this.feishu.reply(this.replyTo, "file", { file_key: key }, { replyInThread: !this.shared }));
        } else {
          await this.say(`文件 ${f.name}（${Math.round(f.size / 1048576)}MB）超过 30MB，未发送。`).catch(() => {});
        }
      } catch (err) {
        log("回传文件失败", f.path, err?.message ?? err);
        await this.say(`文件 ${f.name} 没能发出去（${String(err?.message ?? err).slice(0, 100)}）`).catch(() => {});
      }
    }
  }

  async deliver(text) {
    if (this.hub.isPaused()) return;
    if (!this.binding) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.say(text);
        return;
      } catch (err) {
        if (attempt === 1) log("镜像投递失败（已重试一次）", this.threadId, err?.message ?? err);
        else await new Promise((r) => setTimeout(r, 1200));
      }
    }
  }
}

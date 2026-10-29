/**
 * One streaming card per run, inside a topic.
 *
 * The pacing follows the official lark openclaw plugin (larksuite/openclaw-lark): CardKit
 * flushes at most every 100 ms (frequent, small pushes are what make the typewriter feel
 * smooth), a pause longer than 2 s batches for 300 ms so the first frame after it carries
 * real text, and the status line refreshes every 1.5 s. Updates are serialized per card —
 * the platform rejects an out-of-order `sequence` (300317).
 *
 * Any failure marks the card dead and the caller falls back to plain text messages. The card is
 * agent-agnostic: the header carries the agent's icon, the stop button names the topic.
 */
import { log } from "../../core/log.js";

const CONTENT_MIN_INTERVAL_MS = 100; // official CARDKIT_MS
const LONG_GAP_MS = 2000; // official LONG_GAP_THRESHOLD_MS
const GAP_BATCH_MS = 300; // official BATCH_AFTER_GAP_MS
const STATUS_MIN_INTERVAL_MS = 1500; // official REASONING_STATUS_MS
const MAX_CARD_TEXT = 20000; // cards cap at 30KB of JSON; leave room and say so when hit
const STEPS_VISIBLE = 6; // the tool panel keeps the newest few steps

export class RunCard {
  constructor({ feishu, bindingId, replyTo, inThread, agentLabel, heading, canStop, title, startedAt, isPaused, after, onSent }) {
    this.feishu = feishu;
    this.bindingId = bindingId;
    this.threadId = bindingId; // log label
    this.replyTo = replyTo;
    this.inThread = inThread !== false;
    this.heading = heading ?? "执行过程";
    this.agentLabel = agentLabel ?? "Agent";
    this.canStop = canStop !== false;
    this.title = title;
    this.model = null;
    this.isPaused = typeof isPaused === "function" ? isPaused : () => false;
    this.onSent = typeof onSent === "function" ? onSent : null;
    /** The card goes out only after this settles (the previous run's conclusion is posted). */
    this.after = after ?? Promise.resolve();
    this.startedAt = startedAt ?? Date.now();
    this.cardId = null;
    this.sequence = 0;
    this.dead = false;
    this.sent = false;
    this.parts = []; // completed assistant messages
    this.buffer = ""; // current message's partial text
    this.phase = "starting"; // starting | thinking | text | tool
    this.failure = null; // the run's LLM failure, when one was reported
    this.lastToolName = null;
    this.toolSteps = []; // { id, name, startedAt, endedAt }
    this.stepsDirty = false;
    this.lastStepsValue = "";
    this.lastStepsSentAt = 0;
    this.stepsTimer = null;
    this.messageId = null; // the card's message (for the reaction/card registry)
    this.lastContentValue = "";
    this.lastContentSentAt = 0;
    this.lastStatusValue = "";
    this.lastStatusSentAt = 0;
    this.statusTimer = null;
    this.contentTimer = null;
    this.flushInFlight = false;
    this.needsReflush = false;
    this.sendPromise = null;
    this.opChain = Promise.resolve();
    this.finalized = false;
    // `idle` seen: this run is over even though the card still waits out its quiet window,
    // so the next run must claim a card of its own rather than this one.
    this.closing = false;
    // Streaming mode dies after ten minutes (200850): full-card updates still work then, so
    // the card switches over instead of dying and spilling the run into plain messages.
    this.fullMode = false;
    this.createdAt = Date.now();
    this.lastFullAt = 0;
    this.lastActivityAt = Date.now();
  }

  /**
   * Every cardkit call for this card runs through one chain: the platform compares a
   * strictly increasing `sequence` and a request that arrives out of order is rejected
   * (300317), so two in-flight updates must never race.
   */
  #op(fn) {
    const run = this.opChain.then(fn);
    this.opChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #nextSequence() {
    this.sequence += 1;
    return this.sequence;
  }

  #fullText() {
    const all = [...this.parts];
    if (this.buffer !== "") all.push(this.buffer);
    const text = all.join("\n\n").trim();
    return text.length > MAX_CARD_TEXT
      ? `${text.slice(0, MAX_CARD_TEXT)}\n\n…（卡片仅保留前 2 万字，完整内容见原 Agent 会话）`
      : text;
  }

  #elapsed() {
    const s = Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }

  #statusLine() {
    switch (this.phase) {
      case "thinking":
        return `思考中 · ${this.#elapsed()}`;
      case "tool":
        return `调用工具 ${this.lastToolName ?? ""} · ${this.#elapsed()}`;
      case "text":
        return `生成中 · ${this.#elapsed()}`;
      default:
        return "开始处理…";
    }
  }

  /** Card JSON 2.0; `buttons` is a plain array of button descriptors or null. */
  #cardJson(status, text, streaming, buttons = null) {
    const stepsText = this.#stepsText();
    const elements = [
      { tag: "markdown", content: text || "…", element_id: "answer" },
      { tag: "markdown", content: stepsText, element_id: "steps" },
      // Body-level elements must be components (a bare plain_text is rejected), and
      // markdown streams just as well.
      { tag: "markdown", content: status, element_id: "status", icon: statusIcon(this.phase) },
    ];
    if (buttons && buttons.length > 0) {
      // Card JSON 2.0 dropped the `action` container; a button is a body element, and a
      // row of them is a column_set of one-column buttons.
      const els = buttons.map((b) => ({
        tag: "button",
        text: { tag: "plain_text", content: b.label },
        type: b.type ?? "default",
        value: b.value,
      }));
      elements.push(els.length === 1 ? els[0] : { tag: "column_set", columns: els.map((el) => ({ tag: "column", width: "auto", elements: [el] })) });
    }
    return {
      schema: "2.0",
      // No session title in the header: the topic already says whose conversation this is, and
      // every reply repeating it was noise.
      header: this.#header(),
      config: {
        streaming_mode: streaming,
        summary: { content: text.slice(0, 60) || "执行中…" },
      },
      body: { elements },
    };
  }

  /**
   * Card header: Feishu's own icon set (no emoji) and the agent as a text tag, so where a run
   * comes from reads at a glance in thread and shared isolation alike.
   */
  #header(outcome = null) {
    const color = { done: "green", failed: "red", stopped: "grey", empty: "orange" }[outcome] ?? "blue";
    return {
      title: { tag: "plain_text", content: this.heading },
      icon: { tag: "standard_icon", token: "robot_outlined", color },
      text_tag_list: [{ tag: "text_tag", text: { tag: "plain_text", content: this.agentLabel }, color: "indigo" }],
      template: outcome === "failed" ? "red" : "default",
    };
  }

  #runningButtons() {
    if (!this.canStop) return null;
    return [
      {
        label: "停止",
        type: "danger",
        value: { action: "stop", bindingId: this.bindingId },
      },
    ];
  }

  /** The finished card carries no buttons: the run is over, nothing more to press. */
  #doneButtons() {
    return null;
  }

  /** Creates the entity and sends it into the topic; false when the card is not usable. */
  async ensureSent() {
    if (this.sent) return !this.dead;
    if (this.dead) return false;
    // Single-flight: partial deltas arrive in bursts and each must not create its own card.
    if (this.sendPromise) return this.sendPromise;
    this.sendPromise = this.#doSend();
    return this.sendPromise;
  }

  async #doSend() {
    try {
      await this.after;
      await this.#op(async () => {
        this.cardId = await this.feishu.createCardEntity(
          this.#cardJson(this.#statusLine(), "", true, this.#runningButtons()),
        );
        if (!this.cardId) throw new Error("createCardEntity 没有返回 card_id");
        const sent = await this.feishu.replyCardEntity(this.replyTo, this.cardId, this.inThread);
        this.messageId = sent?.message_id ?? null;
      });
      this.sent = true;
      this.lastStatusValue = this.#statusLine();
      this.lastStatusSentAt = Date.now();
      this.#armStatusTimer();
      this.#scheduleContentFlush();
      if (this.messageId) this.onSent?.(this.messageId);
      log("流式卡片已创建", this.threadId, this.cardId);
      return true;
    } catch (err) {
      this.dead = true;
      log("流式卡片不可用，回退为文本镜像", this.threadId, err?.message ?? err);
      return false;
    }
  }

  #armStatusTimer() {
    if (this.statusTimer !== null) return;
    this.statusTimer = setInterval(() => {
      if (this.finalized || this.phase === "starting") return;
      void this.setStatus(this.#statusLine()).catch(() => {});
    }, STATUS_MIN_INTERVAL_MS);
    if (typeof this.statusTimer.unref === "function") this.statusTimer.unref();
  }

  /** Long-run kick: send the card (status only) when no text has arrived yet. */
  async heartbeat() {
    if (this.sent || this.dead) return;
    const ok = await this.ensureSent();
    if (ok) await this.setStatus(this.#statusLine(), true);
  }

  /** A card nobody finalized (a lost race, a crash) gives up instead of updating forever. */
  #stale() {
    if (Date.now() - this.lastActivityAt > 12 * 60_000) {
      if (!this.dead) {
        this.dead = true;
        log("卡片长时间无活动，已放弃更新", this.threadId);
      }
      return true;
    }
    return false;
  }

  async setStatus(status, force = false) {
    if (!this.sent || this.dead || this.isPaused() || this.#stale()) return;
    if (!force && status === this.lastStatusValue) return;
    if (!force && Date.now() - this.lastStatusSentAt < STATUS_MIN_INTERVAL_MS) return;
    if (this.fullMode) {
      void this.#pushFull();
      return;
    }
    try {
      const sentAt = Date.now();
      await this.#op(() => this.feishu.streamCardContent(this.cardId, "status", status, this.#nextSequence()));
      this.lastStatusValue = status;
      this.lastStatusSentAt = sentAt;
    } catch (err) {
      if (err?.code === 200850 || err?.code === 300309) {
        this.#useFullMode(`状态行：${err.code}`);
        void this.#pushFull();
        return;
      }
      this.dead = true;
      log("状态行更新失败", this.threadId, err?.message ?? err);
    }
  }

  // ——— phase + content ————————————————————————————————————————————————————————————

  onThinking() {
    this.lastActivityAt = Date.now();
    if (this.phase === "starting" || this.phase === "tool") this.phase = "thinking";
  }

  onTool(name) {
    this.lastActivityAt = Date.now();
    if (typeof name === "string" && name !== "") this.lastToolName = name;
    this.phase = "tool";
  }

  startPartial() {
    this.lastActivityAt = Date.now();
    this.buffer = "";
    if (this.phase !== "text") this.phase = "text";
  }

  /** Appends a partial delta; schedules a paced content flush. */
  pushDelta(delta) {
    if (this.dead) return;
    this.lastActivityAt = Date.now();
    this.phase = "text";
    this.buffer += delta;
    this.#scheduleContentFlush();
  }

  /** The run's LLM request failed (request_end status not completed): shown at the end. */
  noteFailure(failure) {
    this.failure = failure;
    this.lastActivityAt = Date.now();
  }

  /** The tool panel: newest few steps, each with its duration (running step included). */
  #stepsText() {
    const steps = this.toolSteps;
    if (steps.length === 0) return "";
    const shown = steps.slice(-STEPS_VISIBLE);
    const hidden = steps.length - shown.length;
    const lines = shown.map((s) => {
      const ms = (s.endedAt ?? Date.now()) - s.startedAt;
      const secs = ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;
      const mark = s.endedAt === null ? "进行中" : "完成";
      const name = String(s.name ?? "工具").slice(0, 32);
      return `· ${name} · ${secs} · ${mark}`;
    });
    const head = `**工具执行**（${steps.length} 步${hidden > 0 ? `，显示最近 ${shown.length}` : ""}）`;
    return [head, ...lines].join("\n");
  }

  /** A completed assistant message joins the card (replacing whatever partials it had). */
  completeMessage(text) {
    this.lastActivityAt = Date.now();
    this.parts.push(text);
    this.buffer = "";
    this.phase = "text";
    this.#scheduleContentFlush();
  }

  /** The run's text so far (used by the file-follow step at the run's end). */
  finalText() {
    return this.#fullText();
  }

  /**
   * A completed message that arrived after the card was closed (a slow tool can push the
   * last text past the closing beat): it joins the card instead of becoming a stray text
   * message. Only within a minute of the card's end, and only when nobody touched it since.
   */
  async absorbText(text) {
    if (this.dead) return false;
    if (!this.finalized) {
      this.completeMessage(text);
      return true;
    }
    if (this.endedAt && Date.now() - this.endedAt > 60_000) return false;
    this.parts.push(text);
    try {
      await this.#op(() =>
        this.feishu.updateCardEntity(
          this.cardId,
          this.#cardJson(this.finalStatus ?? this.#statusLine(), this.#fullText(), false, this.#doneButtons()),
          this.#nextSequence(),
        ),
      );
      log("卡片补收尾后文本", this.threadId, this.cardId);
      return true;
    } catch (err) {
      log("补文本失败", this.threadId, err?.message ?? err);
      return false;
    }
  }

  /** Tool panel events: a call opens a step, its output closes it. */
  onToolEvent(kind, name, id) {
    this.lastActivityAt = Date.now();
    if (typeof name === "string" && name !== "") this.lastToolName = name;
    this.phase = "tool";
    if (kind === "call") {
      const stepId = typeof id === "string" && id !== "" ? id : `t${this.toolSteps.length + 1}`;
      if (!this.toolSteps.some((s) => s.id === stepId)) {
        this.toolSteps.push({ id: stepId, name: name ?? "工具", startedAt: Date.now(), endedAt: null });
        if (this.toolSteps.length > 40) this.toolSteps.splice(0, this.toolSteps.length - 40);
      }
    } else {
      const open = typeof id === "string" && id !== "" ? this.toolSteps.find((s) => s.id === id && s.endedAt === null) : null;
      const target = open ?? [...this.toolSteps].reverse().find((s) => s.endedAt === null);
      if (target) target.endedAt = Date.now();
    }
    this.stepsDirty = true;
    this.#scheduleStepsFlush();
  }

  #scheduleStepsFlush() {
    if (this.dead || !this.sent || this.finalized) return;
    const elapsed = Date.now() - this.lastStepsSentAt;
    const delay = Math.max(0, STATUS_MIN_INTERVAL_MS - elapsed);
    if (this.stepsTimer !== undefined && this.stepsTimer !== null) return;
    this.stepsTimer = setTimeout(() => {
      this.stepsTimer = null;
      void this.flushSteps();
    }, delay);
    if (typeof this.stepsTimer?.unref === "function") this.stepsTimer.unref();
  }

  async flushSteps() {
    if (!this.sent || this.dead || this.isPaused() || this.finalized || !this.stepsDirty) return;
    if (this.fullMode) {
      void this.#pushFull();
      return;
    }
    const text = this.#stepsText();
    if (text === this.lastStepsValue) return;
    try {
      const sentAt = Date.now();
      await this.#op(() => this.feishu.streamCardContent(this.cardId, "steps", text, this.#nextSequence()));
      this.lastStepsValue = text;
      this.lastStepsSentAt = sentAt;
      this.stepsDirty = false;
    } catch (err) {
      log("工具面板更新失败", this.threadId, err?.message ?? err);
    }
  }

  /**
   * Official pacing (FlushController): flush immediately when the minimum interval has
   * passed; after a long pause batch briefly so the first frame carries real text;
   * otherwise schedule a deferred flush at the interval's end. Reflush when text arrived
   * while a flush was in flight.
   */
  #scheduleContentFlush() {
    if (this.dead || !this.sent || this.finalized) return;
    // Ten minutes is the platform's streaming limit: switch one minute early, on our terms.
    if (!this.fullMode && Date.now() - this.createdAt > 9 * 60_000) this.#useFullMode("超过 9 分钟");
    if (this.fullMode) {
      void this.#pushFull();
      return;
    }
    const now = Date.now();
    const elapsed = now - this.lastContentSentAt;
    if (elapsed >= CONTENT_MIN_INTERVAL_MS) {
      if (this.contentTimer !== null) {
        clearTimeout(this.contentTimer);
        this.contentTimer = null;
      }
      if (elapsed > LONG_GAP_MS) {
        this.lastContentSentAt = now;
        this.contentTimer = setTimeout(() => {
          this.contentTimer = null;
          void this.flush();
        }, GAP_BATCH_MS);
        if (typeof this.contentTimer.unref === "function") this.contentTimer.unref();
      } else {
        void this.flush();
      }
      return;
    }
    if (this.contentTimer === null) {
      this.contentTimer = setTimeout(() => {
        this.contentTimer = null;
        void this.flush();
      }, CONTENT_MIN_INTERVAL_MS - elapsed);
      if (typeof this.contentTimer.unref === "function") this.contentTimer.unref();
    }
  }

  /**
   * The platform closes streaming after ten minutes (200850) and then rejects element pushes
   * while whole-card updates keep working. Switching over beats the alternative the user saw:
   * a card that dies mid-run and spills every later message into the chat as plain text.
   */
  #useFullMode(reason) {
    if (this.fullMode) return;
    this.fullMode = true;
    log("卡片切换为整卡更新", this.threadId, reason);
  }

  /** One whole-card PUT, paced — the update path once streaming is out of the picture. */
  async #pushFull() {
    if (!this.sent || this.dead || this.finalized) return;
    if (Date.now() - this.lastFullAt < 1500) return; // a full PUT is heavier than a push
    const status = this.#statusLine();
    const text = this.#fullText();
    if (text === this.lastContentValue && status === this.lastStatusValue) return;
    this.lastFullAt = Date.now();
    try {
      await this.#op(() =>
        this.feishu.updateCardEntity(
          this.cardId,
          this.#cardJson(status, text, false, this.#runningButtons()),
          this.#nextSequence(),
        ),
      );
      this.lastContentValue = text;
      this.lastStatusValue = status;
      this.lastStatusSentAt = Date.now();
      this.lastStepsSentAt = Date.now();
      this.stepsDirty = false;
    } catch (err) {
      log("整卡更新失败", this.threadId, err?.message ?? err);
    }
  }

  async flush() {
    if (!this.sent || this.dead || this.isPaused()) return;
    if (this.flushInFlight) {
      this.needsReflush = true;
      return;
    }
    const text = this.#fullText();
    if (text === this.lastContentValue) return;
    this.flushInFlight = true;
    try {
      const sentAt = Date.now();
      await this.#op(() => this.feishu.streamCardContent(this.cardId, "answer", text || "…", this.#nextSequence()));
      this.lastContentValue = text;
      this.lastContentSentAt = sentAt;
    } catch (err) {
      if (err?.code === 200850 || err?.code === 300309) {
        this.#useFullMode(`流式文本：${err.code}`);
        void this.#pushFull();
      } else {
        this.dead = true;
        log("流式文本更新失败", this.threadId, err?.message ?? err);
      }
    } finally {
      this.flushInFlight = false;
      if (this.needsReflush) {
        this.needsReflush = false;
        this.#scheduleContentFlush();
      }
    }
  }

  /** Final content + status, streaming closed. Safe to call once; never throws. */
  async finalize({ interrupted = false, conclusion = null } = {}) {
    if (this.finalized) return;
    // A fast run's `idle` can beat its last text: wait for an in-flight send, and create
    // the card when text is already here but the card never went out — otherwise the card
    // would be born after the run ended and sit at "生成中" until the platform times out.
    if (!this.sent && !this.dead) {
      if (this.sendPromise || this.parts.length > 0 || this.buffer !== "") {
        await this.ensureSent().catch(() => {});
      }
      if (!this.sent || this.dead) return;
    }
    this.finalized = true;
    const toolCount = this.toolSteps.length;
    if (this.statusTimer !== null) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    if (this.contentTimer !== null) {
      clearTimeout(this.contentTimer);
      this.contentTimer = null;
    }
    if (this.stepsTimer !== null) {
      clearTimeout(this.stepsTimer);
      this.stepsTimer = null;
    }
    const seconds = (Date.now() - this.startedAt) / 1000;
    const duration = seconds >= 10 ? `${Math.round(seconds)}s` : `${seconds.toFixed(1)}s`;
    const empty = this.#fullText() === "";
    const tail = ` · 用时 ${duration}${this.model ? ` · ${this.model}` : ""}`;
    const outcome = interrupted ? "stopped" : this.failure ? "failed" : empty ? "empty" : "done";
    const status = {
      stopped: `已停止（手动中断）${tail}`,
      failed: `请求失败（${this.failure?.code ?? this.failure?.status}）${tail}`,
      empty: `已结束（本轮没有文字输出）${tail}`,
      done: `完成${tail}`,
    }[outcome];
    // The conclusion is its own message; this card keeps everything else, folded away. The
    // reader sees one status line and can unfold the run when they want the machinery.
    const parts = [...this.parts];
    if (conclusion !== null && parts.length > 0 && parts[parts.length - 1] === conclusion) parts.pop();
    const analysis = parts.join("\n\n").trim();
    const stepsText = this.#stepsText();
    const panel = {
      tag: "collapsible_panel",
      expanded: false,
      header: {
        title: { tag: "markdown", content: `执行过程 · ${toolCount} 步` },
        vertical_align: "center",
        icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" },
        icon_position: "right",
        icon_expanded_angle: -180,
      },
      border: { color: "grey", corner_radius: "5px" },
      elements: [
        { tag: "markdown", content: analysis || "（本轮的分析内容见结论卡）", element_id: "answer" },
        { tag: "markdown", content: stepsText || "（本轮没有工具调用）", element_id: "steps" },
      ],
    };
    const card = {
      schema: "2.0",
      header: this.#header(outcome),
      config: { streaming_mode: false, summary: { content: status } },
      body: { elements: [panel, { tag: "markdown", content: status, element_id: "status", icon: statusIcon(outcome) }] },
    };
    try {
      await this.#op(async () => {
        await this.feishu.updateCardEntity(this.cardId, card, this.#nextSequence());
        await this.feishu.patchCardSettings(
          this.cardId,
          { streaming_mode: false, summary: { content: status } },
          this.#nextSequence(),
        );
      });
      this.lastStatusValue = status;
      this.finalStatus = status;
      this.endedAt = Date.now();
      log("卡片已收尾", this.threadId, this.cardId, status, `工具 ${toolCount} 步`);
    } catch (err) {
      log("收尾更新失败", this.threadId, err?.message ?? err);
    }
  }
}

/** The status line's icon, from Feishu's standard icon set. */
function statusIcon(phase) {
  const [token, color] = {
    thinking: ["loading_outlined", "blue"],
    tool: ["setting_outlined", "blue"],
    text: ["edit_outlined", "blue"],
    done: ["succeed_filled", "green"],
    failed: ["error_filled", "red"],
    stopped: ["stop_outlined", "grey"],
    empty: ["warning_filled", "orange"],
  }[phase] ?? ["time_outlined", "grey"];
  return { tag: "standard_icon", token, color };
}

export class RunCards {
  constructor(feishu) {
    this.feishu = feishu;
    this.byThread = new Map();
  }

  /**
   * The card for a run; created on demand. Returns null when the card layer is dead.
   *
   * A run that follows another immediately — the queue's follow-up, which the platform starts
   * as soon as the previous run goes idle — finds the previous card still finalizing; it gets
   * a fresh card instead of writing its own output into the previous run's.
   */
  begin(bindingId, opts) {
    const threadId = bindingId;
    let entry = this.byThread.get(threadId);
    if (!entry || entry.finished || entry.card.closing || entry.card.finalized || entry.card.dead) {
      entry = {
        finished: false,
        card: new RunCard({ feishu: this.feishu, bindingId, ...opts, startedAt: Date.now() }),
      };
      this.byThread.set(threadId, entry);
    }
    return entry.card;
  }

  current(threadId) {
    const entry = this.byThread.get(threadId);
    return entry && !entry.finished ? entry.card : null;
  }

  /** The most recent card for a thread, even after its run was finished. */
  lastCard(threadId) {
    return this.byThread.get(threadId)?.card ?? null;
  }

  /**
   * Marks the thread's card finished. `card` is the run that ended: when a newer run has
   * already claimed the thread, its card is left alone.
   */
  finish(threadId, card = null) {
    const entry = this.byThread.get(threadId);
    if (!entry) return;
    if (card && entry.card !== card) return;
    entry.finished = true;
  }
}

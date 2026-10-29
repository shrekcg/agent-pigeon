/**
 * The Feishu side: tenant token + REST calls over plain fetch, and the event stream over the
 * official SDK's WebSocket long connection (the same mechanism the built-in connector uses;
 * only one client may hold this app's stream, which is why the built-in "启用连接" stays off
 * while the relay runs).
 *
 * REST bodies are JSON strings per the open platform: card content is the card JSON
 * serialized, text content is `{"text":"…"}`.
 */
import * as Lark from "@larksuiteoapi/node-sdk";
import { log } from "../../core/log.js";

export class Feishu {
  constructor({ appId, appSecret, baseDomain }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.base = (baseDomain ?? "https://open.feishu.cn").replace(/\/+$/, "");
    this.cachedToken = null;
    this.tokenExpiresAt = 0;
    this.imChain = Promise.resolve();
    this.lastImAt = 0;
  }

  /**
   * IM message operations (send/reply/patch) share one paced chain: the chat itself has a
   * rate limit (230020), and a burst of replies is exactly how to hit it. Retries the
   * rate-limit code with backoff; cardkit (card element) calls do not go through here.
   */
  async imCall(path, body, method = "POST") {
    const run = this.imChain.then(async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const wait = this.lastImAt + 1100 - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        this.lastImAt = Date.now();
        try {
          return await this.call(method, path, body);
        } catch (err) {
          if (err?.code === 230020 && attempt < 3) {
            await new Promise((r) => setTimeout(r, 1400 * (attempt + 1)));
            continue;
          }
          throw err;
        }
      }
      throw new Error("imCall: 重试耗尽");
    });
    this.imChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async token() {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt - 60_000) return this.cachedToken;
    const res = await fetch(`${this.base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const data = await res.json();
    if (data.code !== 0 || !data.tenant_access_token) {
      throw new Error(`获取 tenant_access_token 失败: code=${data.code} msg=${data.msg}`);
    }
    this.cachedToken = data.tenant_access_token;
    this.tokenExpiresAt = Date.now() + (data.expire ?? 7200) * 1000;
    return this.cachedToken;
  }

  async call(method, path, body) {
    const token = await this.token();
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (data.code !== 0) {
      const err = new Error(`Feishu API ${path} 失败: code=${data.code} msg=${data.msg}`);
      err.code = data.code;
      throw err;
    }
    return data.data ?? {};
  }

  /** A message into the chat (not threaded) — used for anchors and main-timeline replies. */
  async send(chatId, msgType, content) {
    return await this.imCall("/open-apis/im/v1/messages?receive_id_type=chat_id", {
      receive_id: chatId,
      msg_type: msgType,
      content: JSON.stringify(content),
    });
  }

  async sendCard(chatId, card) {
    return await this.send(chatId, "interactive", card);
  }

  async sendText(chatId, text) {
    return await this.send(chatId, "text", { text });
  }

  /** Replies to a message; `replyInThread` keeps it inside that message's topic. */
  async reply(messageId, msgType, content, { replyInThread = false } = {}) {
    return await this.imCall(`/open-apis/im/v1/messages/${messageId}/reply`, {
      content: JSON.stringify(content),
      msg_type: msgType,
      reply_in_thread: replyInThread,
    });
  }

  async replyText(messageId, text, opts) {
    return await this.reply(messageId, "text", { text }, opts);
  }

  async replyCard(messageId, card, opts) {
    return await this.reply(messageId, "interactive", card, opts);
  }

  /** Updates a card this app sent (≤14 days). Title/preview updates come from here. */
  async patchCard(messageId, card) {
    return await this.imCall(
      `/open-apis/im/v1/messages/${messageId}`,
      { content: JSON.stringify(card) },
      "PATCH",
    );
  }

  // ——— CardKit: streaming cards ————————————————————————————————————————————————

  /** Creates a card entity from card JSON 2.0 → `card_id`. */
  async createCardEntity(card) {
    const data = await this.call("POST", "/open-apis/cardkit/v1/cards", {
      type: "card_json",
      data: JSON.stringify(card),
    });
    return data.card_id ?? null;
  }

  /** Sends an existing card entity as a threaded reply (an entity can be sent once). */
  async replyCardEntity(messageId, cardId, replyInThread = true) {
    return await this.reply(messageId, "interactive", { type: "card", data: { card_id: cardId } }, { replyInThread });
  }

  /** 流式更新文本：pushes the FULL text of one element; the platform renders the delta. */
  async streamCardContent(cardId, elementId, content, sequence) {
    await this.call("PUT", `/open-apis/cardkit/v1/cards/${cardId}/elements/${elementId}/content`, {
      content,
      sequence,
    });
  }

  /** 更新卡片配置：closes the streaming mode and sets the chat-list summary. */
  async patchCardSettings(cardId, config, sequence) {
    await this.call("PATCH", `/open-apis/cardkit/v1/cards/${cardId}/settings`, {
      settings: JSON.stringify({ config }),
      sequence,
    });
  }

  /** 全量更新卡片实体：header + elements in one shot (used to finalize a run). */
  async updateCardEntity(cardId, card, sequence) {
    await this.call("PUT", `/open-apis/cardkit/v1/cards/${cardId}`, {
      card: { type: "card_json", data: JSON.stringify(card) },
      sequence,
    });
  }

  // ——— media ————————————————————————————————————————————————————————————————————

  /** Downloads a message attachment (`type` is `image` or `file`) as bytes. */
  async downloadResource(messageId, fileKey, type) {
    const token = await this.token();
    const res = await fetch(
      `${this.base}/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=${type}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`下载资源失败: ${res.status} ${text.slice(0, 160)}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = res.headers.get("content-type") ?? (type === "image" ? "image/png" : "application/octet-stream");
    return { buffer: buf, mime };
  }

  /** Uploads an image for messages (multipart) → image_key. */
  async uploadImage(buffer, fileName, mime = "image/png") {
    const form = new FormData();
    form.append("image_type", "message");
    form.append("image", new Blob([buffer], { type: mime }), fileName);
    const token = await this.token();
    const res = await fetch(`${this.base}/open-apis/im/v1/images`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error(`上传图片失败: code=${data.code} msg=${data.msg}`);
    return data.data?.image_key ?? null;
  }

  /** Uploads a file for messages (multipart) → file_key. */
  async uploadFile(buffer, fileName, fileType = "stream") {
    const form = new FormData();
    form.append("file_type", fileType);
    form.append("file_name", fileName);
    form.append("file", new Blob([buffer], { type: "application/octet-stream" }), fileName);
    const token = await this.token();
    const res = await fetch(`${this.base}/open-apis/im/v1/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error(`上传文件失败: code=${data.code} msg=${data.msg}`);
    return data.data?.file_key ?? null;
  }

  /**
   * Subscribes to messages, card actions and reactions over the WebSocket long connection.
   * `onMessage`/`onReaction` run after the SDK's ack window starts — callers must not block
   * them. `onCardAction` MUST return its receipt (a toast) synchronously: the platform
   * treats the card trigger as a request/response, and an empty answer is rejected.
   */
  startEvents({ onMessage, onCardAction, onReaction }) {
    const dispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": (data) => {
        // Return immediately; the platform wants the handler done in ≤3s.
        queueMicrotask(() => {
          try {
            onMessage(data);
          } catch (err) {
            log("event handler error", err);
          }
        });
      },
      "im.message.reaction.created_v1": (data) => {
        queueMicrotask(() => {
          try {
            onReaction?.(data);
          } catch (err) {
            log("reaction handler error", err);
          }
        });
      },
      "card.action.trigger": (data) => {
        try {
          return onCardAction ? onCardAction(data) : { toast: { type: "info", content: "已收到" } };
        } catch (err) {
          log("card action handler error", err);
          return { toast: { type: "error", content: "处理失败" } };
        }
      },
    });
    const ws = new Lark.WSClient({ appId: this.appId, appSecret: this.appSecret, loggerLevel: Lark.LoggerLevel.info });
    ws.start({ eventDispatcher: dispatcher });
    log(`飞书长连接启动中（appId=${this.appId.slice(0, 10)}…）`);
    return ws;
  }
}

/** 4000 chars per message — comfortably under both Feishu's and Telegram's limits. */
export const CHUNK_CHARS = 4000;

/** Splits text into chunks at line boundaries when possible. */
export function chunkText(text, limit = CHUNK_CHARS) {
  const out = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest !== "") out.push(rest);
  return out.length > 0 ? out : [""];
}

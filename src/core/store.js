/**
 * The hub's whole durable state.
 *
 * - `bindings`: id → `{ id, channel, agent, sessionId, cwd, title, createdAt, address }`. A
 *   binding ties one agent session to one place in one channel; `address` is the channel's
 *   own (Feishu thread mode: `{ threadId, rootMessageId }`; shared mode: `{ chatId,
 *   anchorMessageId, shared: true }`). `sessionId` is null until an agent that mints ids on
 *   the first run has run once.
 * - `active`: `<channel>:<chatKey>` → binding id, the shared-mode "current session".
 * - `seen`: recent inbound message ids (platforms redeliver; nothing downstream is idempotent).
 * - `sentTexts`: texts the hub injected into sessions, so an agent stream echoing them back
 *   is not mirrored as an own-side message.
 * - `openCards`: binding id → a streaming card a crash may have left live.
 *
 * v1 state (Feishu + Penguin only: `maps` keyed by threadId) is migrated on load. Writes are
 * atomic (tmp + rename); the file is small enough to rewrite whole.
 */
import fs from "node:fs";
import path from "node:path";
import { paths } from "./paths.js";

const SEEN_MAX = 500;
const SENT_MAX = 80;
const SENT_TTL_MS = 10 * 60 * 1000;

const empty = () => ({ version: 2, bindings: {}, active: {}, seen: [], sentTexts: [], openCards: {} });

/** v1 → v2: every Feishu topic mapping becomes a thread-mode Feishu binding. */
export function migrate(parsed) {
  if (parsed?.version === 2) {
    return {
      version: 2,
      bindings: parsed.bindings && typeof parsed.bindings === "object" ? parsed.bindings : {},
      active: parsed.active && typeof parsed.active === "object" ? parsed.active : {},
      seen: Array.isArray(parsed.seen) ? parsed.seen : [],
      sentTexts: Array.isArray(parsed.sentTexts) ? parsed.sentTexts : [],
      openCards: parsed.openCards && typeof parsed.openCards === "object" ? parsed.openCards : {},
    };
  }
  const out = empty();
  for (const [threadId, m] of Object.entries(parsed?.maps ?? {})) {
    if (!m || typeof m !== "object") continue;
    const id = `feishu:${threadId}`;
    out.bindings[id] = {
      id,
      channel: "feishu",
      agent: m.agent ?? "penguin",
      sessionId: m.sessionId ?? null,
      cwd: m.cwd ?? null,
      title: m.title ?? "会话",
      createdAt: m.createdAt ?? new Date().toISOString(),
      address: { threadId, rootMessageId: m.rootMessageId },
    };
  }
  for (const [threadId, info] of Object.entries(parsed?.openCards ?? {})) out.openCards[`feishu:${threadId}`] = info;
  out.seen = Array.isArray(parsed?.seen) ? parsed.seen : [];
  return out;
}

export class Store {
  constructor(file = paths.state) {
    this.file = file;
    this.data = empty();
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.data = migrate(raw);
      if (raw?.version !== 2) {
        fs.copyFileSync(this.file, `${this.file}.v1-backup`);
        this.save();
      }
    } catch {
      this.data = empty();
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  binding(id) {
    return this.data.bindings[id] ?? null;
  }

  bindings() {
    return Object.values(this.data.bindings);
  }

  find(pred) {
    return this.bindings().find(pred) ?? null;
  }

  bySession(agent, sessionId, channel = null) {
    if (!sessionId) return null;
    return this.find((b) => b.agent === agent && b.sessionId === sessionId && (channel === null || b.channel === channel));
  }

  putBinding(b) {
    this.data.bindings[b.id] = b;
    this.save();
  }

  /** Merges fields into a binding; false when it is unknown. */
  updateBinding(id, fields) {
    const b = this.data.bindings[id];
    if (!b) return false;
    Object.assign(b, fields);
    this.save();
    return true;
  }

  removeBinding(id) {
    if (!(id in this.data.bindings)) return false;
    delete this.data.bindings[id];
    for (const [k, v] of Object.entries(this.data.active)) if (v === id) delete this.data.active[k];
    delete this.data.openCards[id];
    this.save();
    return true;
  }

  active(key) {
    const id = this.data.active[key];
    return id && this.data.bindings[id] ? id : null;
  }

  setActive(key, id) {
    this.data.active[key] = id;
    this.save();
  }

  seenBefore(messageId) {
    return this.data.seen.includes(messageId);
  }

  rememberSeen(messageId) {
    this.data.seen.push(messageId);
    if (this.data.seen.length > SEEN_MAX) this.data.seen.splice(0, this.data.seen.length - SEEN_MAX);
    this.save();
  }

  /** Record a text the hub posted into a binding's session (so its echo is not mirrored). */
  rememberSent(bindingId, text) {
    const now = Date.now();
    this.data.sentTexts.push({ key: bindingId, text, at: now });
    this.data.sentTexts = this.data.sentTexts.filter((s) => now - s.at < SENT_TTL_MS).slice(-SENT_MAX);
    this.save();
  }

  /** Consume one matching record; true when this text is one of ours. */
  consumeSent(bindingId, text) {
    const now = Date.now();
    const i = this.data.sentTexts.findIndex((s) => s.key === bindingId && s.text === text && now - s.at < SENT_TTL_MS);
    if (i < 0) return false;
    this.data.sentTexts.splice(i, 1);
    this.save();
    return true;
  }

  openCards() {
    return this.data.openCards ?? {};
  }

  setOpenCard(bindingId, info) {
    this.data.openCards[bindingId] = info;
    this.save();
  }

  clearOpenCard(bindingId) {
    if (!(bindingId in this.data.openCards)) return;
    delete this.data.openCards[bindingId];
    this.save();
  }
}

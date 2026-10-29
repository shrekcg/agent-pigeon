/**
 * The channel contract: the messaging platform side of the hub (Feishu today; DingTalk, QQ,
 * WeChat later). A channel turns platform events into hub inbound calls, opens conversations
 * for bindings, and renders a binding's agent events through a per-binding view.
 *
 * Streaming process cards, tool approvals, media in/out, reply files and conclusions are
 * baseline behaviour of every channel, not options. The one setting is isolation:
 *   "thread" — every session gets its own conversation (a Feishu topic); the conversation is
 *              the routing key.
 *   "shared" — all sessions talk in one conversation; output is prefixed with the session's
 *              display name, and inbound goes to the quoted session or the active one
 *              (`/ht-use` switches).
 *
 * Inbound handed to the hub: `{ chatKey, messageId, threadKey, quotedMessageId, text, parts,
 * summary }` — `threadKey` is set when the message was posted inside a platform thread.
 */

export class Channel {
  constructor(id, options, hub) {
    this.id = id;
    this.options = options ?? {};
    this.hub = hub;
    this.capabilities = { threads: false, cards: false, streaming: false, buttons: false, reactions: false, media: false };
  }

  get label() {
    return this.id;
  }

  /** "thread" or "shared"; a channel without threads is always shared. */
  get isolation() {
    if (!this.capabilities.threads) return "shared";
    return this.options.isolation === "shared" ? "shared" : "thread";
  }

  /** Agents this channel may talk to (empty list = all enabled agents). */
  allowsAgent(agent) {
    const list = Array.isArray(this.options.allowedAgents) ? this.options.allowedAgents : [];
    return list.length === 0 || list.includes(agent);
  }

  async start() {}

  async stop() {}

  /** `{ ok, reason? }` for the config page. */
  status() {
    return { ok: true };
  }

  /**
   * Opens the platform conversation for a new binding (`{ id, agent, sessionId, title, … }`)
   * and returns the address to store on it. `ctx` is the inbound that asked for it, if any.
   */
  async open() {
    throw new Error(`${this.id} 不支持开会话`);
  }

  /** A view renders one binding's agent events: `{ onEvent(ev), start(), stop() }`. */
  createView() {
    throw new Error(`${this.id} 没有实现视图`);
  }

  /** Which binding an inbound message belongs to (null = none). */
  resolveBinding() {
    return null;
  }

  /** Renders a hub reply (`{ kind: help|list|agents|ok|error|text, … }`) for an inbound. */
  async reply() {}

  /** Tells a binding's conversation it went offline. */
  async closed() {}

  /** Refreshes a binding's header (title / session id changed). */
  async refresh() {}

  /** Sends a question with options into a binding's conversation. */
  async ask() {
    throw new Error(`${this.id} 不支持提问卡`);
  }
}

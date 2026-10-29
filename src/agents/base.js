/**
 * The agent adapter contract. The relay talks to every agent through this one shape, so the
 * Feishu side (topics, run cards, conclusions) never knows which agent is behind a topic.
 *
 * A topic's connection to a session is a *link*: `{ agent, sessionId, cwd, title, emit }`.
 * `sessionId` may start out null for agents whose ids only exist after the first run (the
 * adapter fills it in and emits `session_id`). Adapters report what happens in a session by
 * calling `link.emit(event)` with this small vocabulary:
 *
 *   { type: "run_start" }                              a run began (a card opens)
 *   { type: "thinking" }                               the model is reasoning
 *   { type: "text_start" } / { type: "text_delta", text }   streaming answer text
 *   { type: "tool_call", id, name }                    a tool step opened
 *   { type: "tool_result", id, name }                  that step finished
 *   { type: "message", text }                          one completed assistant message
 *   { type: "user_text", text }                        a user message typed on the agent's own side
 *   { type: "failure", code, message }                 the run's request failed
 *   { type: "stopped" }                                the run was aborted by the user
 *   { type: "run_end" }                                the run is over (the card closes); an
 *                                                      end without a start is a connect snapshot
 *   { type: "session_id", sessionId }                  the agent assigned the session's id
 *   { type: "title", title }                           the session got (or changed) its title
 *   { type: "approval", toolCallId, toolName }         a tool call waits for a decision
 *   { type: "queued", count }                          follow-up queue length changed
 *
 * The Session record adapters return is `{ sessionId, title, cwd, model, updatedAt, archived }`.
 */
import fs from "node:fs";
import path from "node:path";
import { paths } from "../core/paths.js";

export const AGENT_LABELS = {
  penguin: "Penguin",
  codex: "Codex",
  claude: "Claude",
  pi: "Pi",
  grok: "Grok",
  dsh: "DeepSeek",
  hermes: "Hermes",
  grokbot: "GrokBot",
};

export function agentLabel(agent) {
  return AGENT_LABELS[agent] ?? agent;
}

/** Base class: the defaults are "not supported", so each adapter states what it can do. */
export class AgentAdapter {
  constructor(id, options = {}) {
    this.id = id;
    this.options = options;
    /** What the relay may offer for this agent (buttons, commands, sweeps). */
    this.capabilities = { create: false, steer: false, abort: false, approvals: false, sweep: false, mirrorsOwnSide: false };
  }

  get label() {
    return agentLabel(this.id);
  }

  /** Whether the agent is installed and usable on this machine: `{ ok, reason? }`. */
  async available() {
    return { ok: false, reason: "未实现" };
  }

  /** Recent sessions, newest first: `{ includeArchived?, limit? }`. */
  async listSessions() {
    return [];
  }

  /** One session by exact id, or null when the agent does not know it. */
  async getSession(sessionId) {
    const sessions = await this.listSessions({ includeArchived: true, limit: 1000 });
    return sessions.find((s) => s.sessionId === sessionId) ?? null;
  }

  /**
   * A new session for a topic. Agents that can only mint an id by running a turn return a
   * pending record (`sessionId: null`); the first `send()` creates the real session.
   */
  async createSession({ cwd = null, title = null } = {}) {
    if (!this.capabilities.create) throw new Error(`${this.label} 不支持从飞书新建会话`);
    // A fixed directory per agent, so every later run resumes where the session lives
    // (Claude Code, dsh and Pi look sessions up by working directory).
    const dir = cwd ?? this.options.workspace ?? path.join(paths.workspaces, this.id);
    fs.mkdirSync(dir, { recursive: true });
    return { sessionId: null, title, cwd: dir, model: null, updatedAt: null, archived: false };
  }

  /** Begins reporting the link's session (live-stream agents); returns a stop function. */
  attach() {
    return () => {};
  }

  /**
   * Sends a user input. `parts` is `[{type:"text",text} | {type:"image",path,mime} |
   * {type:"file",path,name}]`; `mode` is "steer" (fold into a running turn when the agent can)
   * or "queue". Resolves to `{ steered?, queued?, ahead? }`.
   */
  async send() {
    throw new Error(`${this.label} 不支持发送消息`);
  }

  /** Stops the running turn: `{ running }` says whether something was running. */
  async abort() {
    return { running: false };
  }

  /** Answers a pending approval. */
  async decide() {
    throw new Error(`${this.label} 不支持远程审批`);
  }

  /** Stops everything this adapter runs (process exit). */
  async shutdown() {}
}

export function byUpdatedDesc(a, b) {
  return String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""));
}

export function isoFromMs(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
}

/** Joins the text parts of an input; media parts become path notes the agent can open. */
export function promptOf(parts) {
  const lines = [];
  for (const p of parts ?? []) {
    if (p.type === "text" && typeof p.text === "string") lines.push(p.text);
    else if (p.type === "image" && p.path) lines.push(`（用户从飞书发来一张图片，已保存在：${p.path}）`);
    else if (p.type === "file" && p.path) lines.push(`（用户从飞书发来文件「${p.name ?? "文件"}」，已保存在：${p.path}）`);
  }
  return lines.join("\n\n").trim();
}

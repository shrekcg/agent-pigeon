/**
 * Hermes (Hermes Studio's agent). Sessions are rows of `~/.hermes/state.db` (`sessions`:
 * id, title/display_name, cwd, model, last_activity_at, archived, hidden). Runs go through
 * the agent bridge Studio itself uses: a unix socket (`/tmp/hermes-agent-bridge.sock`, one
 * newline-terminated JSON request and one response per connection) with
 * `chat{session_id,message,workspace}` → `{run_id}`, then `get_output{run_id,cursor,
 * event_cursor}` polled for `{delta, events[], done, result, error}`; `steer`,
 * `interrupt`, `approval_respond{approval_id,choice}` act on a live run.
 *
 * The bridge only exists while Hermes Studio (or its runtime) is up; without it the adapter
 * reports itself unavailable instead of failing a message later.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { log } from "../core/log.js";
import { AgentAdapter, byUpdatedDesc, isoFromMs, promptOf } from "./base.js";

const HERMES_HOME = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
const DEFAULT_SOCKET = "/tmp/hermes-agent-bridge.sock";

function bridgeRequest(socketPath, req, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("Hermes bridge 超时"));
    }, timeoutMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(`${JSON.stringify(req)}\n`));
    sock.on("data", (c) => {
      buf += c;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      clearTimeout(timer);
      sock.end();
      try {
        const resp = JSON.parse(buf.slice(0, i));
        if (resp && resp.ok === false) reject(new Error(String(resp.error ?? "Hermes bridge 请求失败")));
        else resolve(resp);
      } catch (err) {
        reject(err);
      }
    });
    sock.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export class HermesAdapter extends AgentAdapter {
  constructor(options = {}) {
    super("hermes", options);
    this.socket = String(options.socket ?? DEFAULT_SOCKET).replace(/^ipc:\/\//, "");
    this.capabilities = { create: true, steer: true, abort: true, approvals: true, sweep: false, mirrorsOwnSide: false };
    /** threadId → { runId, cursor, eventCursor, timer, queue } */
    this.runs = new Map();
  }

  async available() {
    if (!fs.existsSync(path.join(HERMES_HOME, "state.db"))) return { ok: false, reason: "未安装（没有 ~/.hermes/state.db）" };
    if (!fs.existsSync(this.socket)) return { ok: false, reason: "Hermes 运行时未启动（打开 Hermes Studio 后可用）" };
    try {
      await bridgeRequest(this.socket, { action: "ping" }, 3000);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `Hermes bridge 不通：${String(err?.message ?? err).slice(0, 60)}` };
    }
  }

  #rows(where = "", args = []) {
    let db;
    try {
      db = new DatabaseSync(path.join(HERMES_HOME, "state.db"), { readOnly: true });
      return db
        .prepare(
          `SELECT id, title, display_name, cwd, model, started_at, last_activity_at, archived, hidden, parent_session_id
           FROM sessions ${where} ORDER BY COALESCE(last_activity_at, started_at) DESC LIMIT 200`,
        )
        .all(...args);
    } catch {
      return [];
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }

  #record(r) {
    return {
      sessionId: r.id,
      title: r.display_name || r.title || null,
      cwd: r.cwd || null,
      model: r.model ?? null,
      updatedAt: isoFromMs(Number(r.last_activity_at ?? r.started_at) * 1000),
      archived: Number(r.archived) === 1,
    };
  }

  async listSessions({ includeArchived = false, limit = 40 } = {}) {
    return this.#rows("WHERE parent_session_id IS NULL AND COALESCE(hidden,0) = 0")
      .map((r) => this.#record(r))
      .filter((s) => includeArchived || !s.archived)
      .sort(byUpdatedDesc)
      .slice(0, limit);
  }

  async getSession(sessionId) {
    const r = this.#rows("WHERE id = ?", [sessionId])[0];
    return r ? this.#record(r) : null;
  }

  async createSession({ cwd = null, title = null } = {}) {
    // Hermes mints the id on the bridge's first chat; an id we choose is accepted as-is.
    const sessionId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    return { sessionId, title, cwd: cwd ?? this.options.workspace ?? null, model: null, updatedAt: null, archived: false };
  }

  async send(link, parts, { mode = "steer" } = {}) {
    const run = this.runs.get(link.threadId);
    const text = promptOf(parts);
    if (run?.runId) {
      if (mode === "steer") {
        await bridgeRequest(this.socket, { action: "steer", session_id: link.sessionId, text });
        return { steered: true };
      }
      run.queue.push(text);
      return { queued: true, ahead: run.queue.length - 1 };
    }
    await this.#start(link, text);
    return { started: true };
  }

  async #start(link, text) {
    const resp = await bridgeRequest(this.socket, {
      action: "chat",
      session_id: link.sessionId,
      message: text,
      source: "feishu",
      ...(link.cwd || this.options.workspace ? { workspace: link.cwd ?? this.options.workspace } : {}),
    });
    const entry = this.runs.get(link.threadId) ?? { queue: [] };
    Object.assign(entry, { runId: resp.run_id, cursor: 0, eventCursor: 0, link, sawText: false });
    this.runs.set(link.threadId, entry);
    link.emit({ type: "run_start" });
    this.#poll(link.threadId);
  }

  #poll(threadId) {
    const entry = this.runs.get(threadId);
    if (!entry?.runId) return;
    const tick = async () => {
      let out;
      try {
        out = await bridgeRequest(this.socket, { action: "get_output", run_id: entry.runId, cursor: entry.cursor, event_cursor: entry.eventCursor });
      } catch (err) {
        entry.errors = (entry.errors ?? 0) + 1;
        if (entry.errors > 20) {
          entry.link.emit({ type: "failure", code: "bridge", message: String(err?.message ?? err) });
          this.#finish(threadId);
          return;
        }
        entry.timer = setTimeout(tick, 1500);
        return;
      }
      entry.errors = 0;
      entry.cursor = out.cursor ?? entry.cursor;
      entry.eventCursor = out.event_cursor ?? entry.eventCursor;
      const emit = entry.link.emit;
      for (const ev of out.events ?? []) {
        switch (ev.event) {
          case "reasoning.delta":
          case "thinking.delta":
            emit({ type: "thinking" });
            break;
          case "tool.started":
            emit({ type: "tool_call", id: ev.tool_call_id, name: ev.tool_name });
            break;
          case "tool.completed":
            emit({ type: "tool_result", id: ev.tool_call_id, name: ev.tool_name });
            break;
          case "session.title.updated":
            if (ev.title) emit({ type: "title", title: ev.title });
            break;
          case "approval.requested":
            emit({ type: "approval", toolCallId: ev.approval_id, toolName: ev.command || ev.description || "命令" });
            break;
          default:
            break;
        }
      }
      if (typeof out.delta === "string" && out.delta !== "") {
        if (!entry.sawText) {
          entry.sawText = true;
          emit({ type: "text_start" });
        }
        emit({ type: "text_delta", text: out.delta });
      }
      if (out.done) {
        const final = typeof out.result?.final_response === "string" ? out.result.final_response : out.output;
        if (typeof final === "string" && final.trim() !== "") emit({ type: "message", text: final.trim() });
        if (out.status === "interrupted") emit({ type: "stopped" });
        else if (out.status === "error" || out.error) emit({ type: "failure", code: "hermes", message: out.error ?? null });
        this.#finish(threadId);
        return;
      }
      entry.timer = setTimeout(tick, 400);
    };
    entry.timer = setTimeout(tick, 300);
  }

  #finish(threadId) {
    const entry = this.runs.get(threadId);
    if (!entry) return;
    clearTimeout(entry.timer);
    const link = entry.link;
    entry.runId = null;
    link.emit({ type: "run_end" });
    const next = entry.queue.shift();
    if (next) void this.#start(link, next).catch((err) => log("Hermes 排队消息发送失败", err?.message ?? err));
  }

  async abort(link) {
    const entry = this.runs.get(link.threadId);
    if (!entry?.runId) return { running: false };
    entry.queue = [];
    await bridgeRequest(this.socket, { action: "interrupt", session_id: link.sessionId });
    return { running: true };
  }

  async decide(link, approvalId, decision) {
    await bridgeRequest(this.socket, { action: "approval_respond", approval_id: approvalId, choice: decision === "allow" ? "once" : "deny" });
    return { ok: true };
  }

  async shutdown() {
    for (const entry of this.runs.values()) clearTimeout(entry.timer);
  }
}

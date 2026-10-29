/**
 * Pi coding agent. Sessions are `~/.pi/agent/sessions/--<cwd>--/<ts>_<uuid>.jsonl` (header line
 * `{type:"session", id, cwd}`, then a tree of entries; `session_info.name` titles it). A run is
 * `pi -p --mode json --session <id> …` started in the session's cwd, whose stdout lines are
 * the header, then `agent_start` / `turn_start` / `message_update{assistantMessageEvent:
 * text_start|text_delta{delta}|thinking_*|toolcall_*}` / `message_end{message}` /
 * `tool_execution_start|end{toolCallId,toolName}` / `turn_end` / `agent_end` / `agent_settled`.
 * A failed request is an assistant message with `stopReason:"error"` and `errorMessage`.
 *
 * Pi has no stdin prompt in json mode (stdin is prepended), so the prompt rides as the last
 * argument. Inside a Pi session, shell commands see `PI_SESSION_ID` / `PI_SESSION_FILE`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliAdapter, firstLine, safeJson, tailLines } from "./cli.js";
import { byUpdatedDesc } from "./base.js";

const SESSIONS = process.env.PI_CODING_AGENT_SESSION_DIR || path.join(os.homedir(), ".pi", "agent", "sessions");

export class PiAdapter extends CliAdapter {
  constructor(options = {}) {
    super("pi", options);
  }

  async available() {
    if (!this.binary) return { ok: false, reason: "没找到 pi 命令" };
    return { ok: true };
  }

  #files() {
    const out = [];
    let dirs = [];
    try {
      dirs = fs.readdirSync(SESSIONS, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      return out;
    }
    for (const d of dirs) {
      const dir = path.join(SESSIONS, d.name);
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        const file = path.join(dir, f);
        try {
          out.push({ file, mtimeMs: fs.statSync(file).mtimeMs });
        } catch {
          /* vanished */
        }
      }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  #record({ file, mtimeMs }) {
    const head = safeJson(firstLine(file) ?? "");
    if (!head || head.type !== "session" || !head.id) return null;
    let title = null;
    let firstUser = null;
    let model = null;
    for (const line of tailLines(file, 300 * 1024)) {
      const d = safeJson(line);
      if (!d) continue;
      if (d.type === "session_info" && d.name) title = d.name;
      if (d.type === "model_change" && d.modelId) model = d.modelId;
      if (d.type === "message" && d.message?.role === "assistant" && d.message.model) model = d.message.model;
      if (!firstUser && d.type === "message" && d.message?.role === "user") {
        const c = d.message.content;
        const text = typeof c === "string" ? c : Array.isArray(c) ? c.find((x) => x.type === "text")?.text : null;
        if (text) firstUser = text.replace(/\s+/g, " ").trim().slice(0, 40);
      }
    }
    return {
      sessionId: head.id,
      title: title ?? firstUser,
      cwd: head.cwd ?? null,
      model,
      updatedAt: new Date(mtimeMs).toISOString(),
      archived: false,
    };
  }

  async listSessions({ limit = 40 } = {}) {
    return this.#files()
      .slice(0, limit)
      .map((f) => this.#record(f))
      .filter(Boolean)
      .sort(byUpdatedDesc);
  }

  async getSession(sessionId) {
    for (const f of this.#files()) {
      if (!path.basename(f.file).includes(sessionId)) continue;
      const r = this.#record(f);
      if (r?.sessionId === sessionId) return r;
    }
    return null;
  }

  buildRun(link, prompt, { images }) {
    const args = ["-p", "--mode", "json"];
    if (link.sessionId) args.push("--session", link.sessionId);
    else if (link.title) args.push("--name", link.title);
    // `pi [options] [--] [@files...] [messages...]`: `@path` attaches an image or text file.
    args.push("--", ...images.map((p) => `@${p}`), prompt);
    return { args, stdin: "" };
  }

  parseLine(line, ctx) {
    const d = safeJson(line);
    if (!d) return [];
    switch (d.type) {
      case "session":
        if (d.id) ctx.sessionId = d.id;
        return [];
      case "message_update": {
        const e = d.assistantMessageEvent ?? {};
        if (e.type === "text_start") return [{ type: "text_start" }];
        if (e.type === "text_delta" && typeof e.delta === "string") return [{ type: "text_delta", text: e.delta }];
        if (e.type?.startsWith("thinking")) return [{ type: "thinking" }];
        return [];
      }
      case "message_end": {
        const m = d.message ?? {};
        if (m.role !== "assistant") return [];
        if (m.stopReason === "error") return [{ type: "failure", code: "pi", message: m.errorMessage ?? null }];
        if (m.stopReason === "aborted") return [{ type: "stopped" }];
        const text = (Array.isArray(m.content) ? m.content : [])
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("")
          .trim();
        return text ? [{ type: "message", text }] : [];
      }
      case "tool_execution_start":
        return [{ type: "tool_call", id: d.toolCallId, name: d.toolName }];
      case "tool_execution_end":
        return [{ type: "tool_result", id: d.toolCallId, name: d.toolName }];
      default:
        return [];
    }
  }
}

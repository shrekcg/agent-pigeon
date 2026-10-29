/**
 * Grok CLI. Sessions are `~/.grok/sessions/<url-encoded cwd>/<uuid>/summary.json` (`info.id`,
 * `info.cwd`, `generated_title`, `current_model_id`, `last_active_at`). A run is
 * `grok -p - --resume <id> --cwd <dir> --output-format streaming-json`, whose stdout lines
 * are `{type: text{data} | thought | tool_call{toolCallId,toolName} | tool_call_update{status}
 * | usage | plan | available_commands | end{stopReason,sessionId} | error{message}}`.
 *
 * Inside a Grok session, shell commands see `GROK_SESSION_ID`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliAdapter, safeJson } from "./cli.js";
import { byUpdatedDesc } from "./base.js";

const GROK_HOME = process.env.GROK_HOME || path.join(os.homedir(), ".grok");
const SESSIONS = path.join(GROK_HOME, "sessions");

export class GrokAdapter extends CliAdapter {
  constructor(options = {}) {
    super("grok", options);
  }

  async available() {
    if (!this.binary) return { ok: false, reason: "没找到 grok 命令" };
    return { ok: true };
  }

  #summaries() {
    const out = [];
    let dirs = [];
    try {
      dirs = fs.readdirSync(SESSIONS, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      return out;
    }
    for (const d of dirs) {
      const base = path.join(SESSIONS, d.name);
      for (const s of fs.readdirSync(base, { withFileTypes: true })) {
        if (!s.isDirectory()) continue;
        try {
          const j = JSON.parse(fs.readFileSync(path.join(base, s.name, "summary.json"), "utf8"));
          out.push(j);
        } catch {
          /* not a session */
        }
      }
    }
    return out;
  }

  #record(j) {
    const title = j.generated_title || j.title || j.session_summary || null;
    return {
      sessionId: j.info?.id ?? null,
      title: typeof title === "string" && title.trim() !== "" ? title.trim().slice(0, 60) : null,
      cwd: j.info?.cwd ?? null,
      model: j.current_model_id ?? null,
      updatedAt: j.last_active_at ?? j.updated_at ?? null,
      archived: false,
    };
  }

  async listSessions({ limit = 40 } = {}) {
    return this.#summaries()
      .filter((j) => !j.parent_session_id)
      .map((j) => this.#record(j))
      .filter((s) => s.sessionId)
      .sort(byUpdatedDesc)
      .slice(0, limit);
  }

  async getSession(sessionId) {
    const j = this.#summaries().find((x) => x.info?.id === sessionId);
    return j ? this.#record(j) : null;
  }

  buildRun(link, prompt) {
    const args = ["--prompt-file", "/dev/stdin", "--cwd", this.runCwd(link), "--output-format", "streaming-json"];
    if (this.options.permissionMode) args.push("--permission-mode", this.options.permissionMode);
    else args.push("--always-approve");
    if (link.sessionId) args.push("--resume", link.sessionId);
    return { args, stdin: prompt };
  }

  parseLine(line, ctx) {
    const d = safeJson(line);
    if (!d) return [];
    switch (d.type) {
      case "text":
        if (typeof d.data !== "string") return [];
        if (!ctx.inText) {
          ctx.inText = true;
          ctx.text = d.data;
          return [{ type: "text_start" }, { type: "text_delta", text: d.data }];
        }
        ctx.text += d.data;
        return [{ type: "text_delta", text: d.data }];
      case "thought":
        return [{ type: "thinking" }];
      case "tool_call": {
        const done = this.#flushText(ctx);
        return [...done, { type: "tool_call", id: d.toolCallId, name: d.toolName ?? d.title }];
      }
      case "tool_call_update":
        if (d.status === "completed" || d.status === "failed") return [{ type: "tool_result", id: d.toolCallId }];
        return [];
      case "end": {
        if (d.sessionId) ctx.sessionId = d.sessionId;
        const done = this.#flushText(ctx);
        if (d.stopReason === "cancelled") return [...done, { type: "stopped" }];
        return done;
      }
      case "error":
        return [...this.#flushText(ctx), { type: "failure", code: "grok", message: d.message ?? null }];
      default:
        return [];
    }
  }

  /** Grok streams text without message boundaries: a tool call or the end closes one. */
  #flushText(ctx) {
    if (!ctx.inText) return [];
    ctx.inText = false;
    const text = (ctx.text ?? "").trim();
    ctx.text = "";
    return text ? [{ type: "message", text }] : [];
  }
}

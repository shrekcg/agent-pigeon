/**
 * Claude Code. Sessions are `~/.claude/projects/<cwd with non-alphanumerics as "-">/<uuid>.jsonl`;
 * each line carries `sessionId` and `cwd`, a `custom-title` line names the session. A run is
 * `claude -p --resume <id> --output-format stream-json --verbose --include-partial-messages`,
 * whose stdout is: `system/init{session_id}` → `stream_event{event: message_start |
 * content_block_start{content_block:{type:text|thinking|tool_use}} | content_block_delta{delta:
 * text_delta|thinking_delta} | …}` → `assistant{message}` / `user{message: tool_result}` →
 * `result{subtype, is_error, terminal_reason}`.
 *
 * Inside a Claude Code session, shell commands see `CLAUDE_CODE_SESSION_ID`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliAdapter, firstLine, safeJson, tailLines } from "./cli.js";
import { byUpdatedDesc } from "./base.js";

const PROJECTS = path.join(os.homedir(), ".claude", "projects");

export class ClaudeAdapter extends CliAdapter {
  constructor(options = {}) {
    super("claude", options);
  }

  async available() {
    if (!this.binary) return { ok: false, reason: "没找到 claude 命令" };
    if (!fs.existsSync(PROJECTS)) return { ok: false, reason: "没有 ~/.claude/projects" };
    return { ok: true };
  }

  #files() {
    const out = [];
    let dirs = [];
    try {
      dirs = fs.readdirSync(PROJECTS, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      return out;
    }
    for (const d of dirs) {
      const dir = path.join(PROJECTS, d.name);
      for (const f of fs.readdirSync(dir)) {
        if (!/^[0-9a-f-]{36}\.jsonl$/.test(f)) continue;
        const file = path.join(dir, f);
        try {
          out.push({ file, sessionId: f.slice(0, 36), mtimeMs: fs.statSync(file).mtimeMs });
        } catch {
          /* vanished */
        }
      }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  #record({ file, sessionId, mtimeMs }) {
    let cwd = null;
    let title = null;
    let firstUser = null;
    let model = null;
    const head = safeJson(firstLine(file) ?? "");
    if (head?.cwd) cwd = head.cwd;
    for (const line of tailLines(file, 400 * 1024)) {
      const d = safeJson(line);
      if (!d) continue;
      if (d.type === "custom-title" && d.customTitle) title = d.customTitle;
      else if (d.type === "agent-name" && d.agentName && !title) title = d.agentName;
      if (!cwd && d.cwd) cwd = d.cwd;
      if (d.type === "assistant" && d.message?.model && d.message.model !== "<synthetic>") model = d.message.model;
      if (!firstUser && d.type === "user" && typeof d.message?.content === "string" && !d.isMeta) {
        firstUser = d.message.content.replace(/\s+/g, " ").trim().slice(0, 40);
      }
    }
    return {
      sessionId,
      title: title ?? firstUser,
      cwd,
      model,
      updatedAt: new Date(mtimeMs).toISOString(),
      archived: false,
    };
  }

  async listSessions({ limit = 40 } = {}) {
    return this.#files()
      .slice(0, limit)
      .map((f) => this.#record(f))
      .sort(byUpdatedDesc);
  }

  async getSession(sessionId) {
    const f = this.#files().find((x) => x.sessionId === sessionId);
    return f ? this.#record(f) : null;
  }

  buildRun(link, prompt) {
    const mode = this.options.permissionMode ?? "bypassPermissions";
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", mode];
    if (link.sessionId) args.push("--resume", link.sessionId);
    if (!link.sessionId && link.title) args.push("--name", link.title);
    return { args, stdin: prompt };
  }

  parseLine(line, ctx) {
    const d = safeJson(line);
    if (!d) return [];
    if (d.parent_tool_use_id) return []; // subagent traffic
    if (d.type === "system" && d.subtype === "init") {
      if (d.session_id) ctx.sessionId = d.session_id;
      return [];
    }
    if (d.type === "stream_event") {
      const e = d.event ?? {};
      if (e.type === "content_block_start") {
        const b = e.content_block ?? {};
        ctx.blocks = ctx.blocks ?? new Map();
        ctx.blocks.set(e.index, b.type);
        if (b.type === "text") return [{ type: "text_start" }];
        if (b.type === "thinking" || b.type === "redacted_thinking") return [{ type: "thinking" }];
        if (b.type === "tool_use") return [{ type: "tool_call", id: b.id, name: b.name }];
        return [];
      }
      if (e.type === "content_block_delta") {
        if (e.delta?.type === "text_delta" && typeof e.delta.text === "string") return [{ type: "text_delta", text: e.delta.text }];
        if (e.delta?.type === "thinking_delta") return [{ type: "thinking" }];
      }
      return [];
    }
    if (d.type === "assistant") {
      const text = (d.message?.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("")
        .trim();
      // A synthetic message is the CLI talking ("Not logged in"), not the model: a failure.
      if (d.message?.model === "<synthetic>") return text ? [{ type: "failure", code: "claude", message: text }] : [];
      return text ? [{ type: "message", text }] : [];
    }
    if (d.type === "user") {
      const results = (d.message?.content ?? []).filter?.((c) => c.type === "tool_result") ?? [];
      return results.map((r) => ({ type: "tool_result", id: r.tool_use_id }));
    }
    if (d.type === "result") {
      if (d.is_error || (d.subtype && d.subtype !== "success")) {
        return [{ type: "failure", code: d.terminal_reason ?? d.subtype ?? "error", message: typeof d.result === "string" ? d.result : null }];
      }
      return [];
    }
    return [];
  }
}

/**
 * Codex CLI. Sessions ("threads") are indexed in `~/.codex/state_5.sqlite` (table `threads`:
 * name/title, cwd, model, recency, archived, rollout path); a run is
 * `codex exec [resume <id>] --json …`, whose stdout is the exec event stream:
 * `thread.started{thread_id}` → `turn.started` → `item.started|completed{item:{type:
 * agent_message|reasoning|command_execution|file_change|mcp_tool_call|web_search…}}` →
 * `turn.completed` | `turn.failed{error}` | `error{message}`.
 *
 * Inside a Codex session, shell commands see `CODEX_THREAD_ID`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CliAdapter, safeJson } from "./cli.js";
import { byUpdatedDesc, isoFromMs } from "./base.js";

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");

function openState() {
  const candidates = fs
    .readdirSync(CODEX_HOME)
    .filter((f) => /^state_\d+\.sqlite$/.test(f))
    .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
  if (candidates.length === 0) return null;
  return new DatabaseSync(path.join(CODEX_HOME, candidates[0]), { readOnly: true });
}

const TOOL_ITEMS = new Set(["command_execution", "file_change", "mcp_tool_call", "web_search", "collab_tool_call", "todo_list"]);

function toolName(item) {
  switch (item.type) {
    case "command_execution":
      return `shell ${String(item.command ?? "").replace(/^\/bin\/(ba|z)?sh -lc /, "").slice(0, 40)}`;
    case "file_change":
      return "编辑文件";
    case "mcp_tool_call":
      return [item.server, item.tool].filter(Boolean).join(".") || "mcp";
    case "web_search":
      return "网页搜索";
    case "todo_list":
      return "待办";
    default:
      return item.type;
  }
}

export class CodexAdapter extends CliAdapter {
  constructor(options = {}) {
    super("codex", options);
  }

  async available() {
    if (!this.binary) return { ok: false, reason: "没找到 codex 命令" };
    if (!fs.existsSync(CODEX_HOME)) return { ok: false, reason: "没有 ~/.codex" };
    return { ok: true };
  }

  async listSessions({ includeArchived = false, limit = 60 } = {}) {
    let db;
    try {
      db = openState();
      if (!db) return [];
      const rows = db
        .prepare(
          `SELECT id, name, title, cwd, model, source, updated_at_ms, recency_at_ms, archived
           FROM threads WHERE source NOT LIKE '%subagent%' ${includeArchived ? "" : "AND archived = 0"}
           ORDER BY COALESCE(recency_at_ms, updated_at_ms) DESC LIMIT ?`,
        )
        .all(limit);
      return rows
        .map((r) => ({
          sessionId: r.id,
          title: firstLineOf(r.name) ?? firstLineOf(r.title),
          cwd: r.cwd ?? null,
          model: r.model ?? null,
          updatedAt: isoFromMs(r.recency_at_ms ?? r.updated_at_ms),
          archived: Number(r.archived) === 1,
        }))
        .sort(byUpdatedDesc);
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }

  async getSession(sessionId) {
    let db;
    try {
      db = openState();
      const r = db?.prepare("SELECT id, name, title, cwd, model, updated_at_ms, recency_at_ms, archived FROM threads WHERE id = ?").get(sessionId);
      if (!r) return null;
      return {
        sessionId: r.id,
        title: firstLineOf(r.name) ?? firstLineOf(r.title),
        cwd: r.cwd ?? null,
        model: r.model ?? null,
        updatedAt: isoFromMs(r.recency_at_ms ?? r.updated_at_ms),
        archived: Number(r.archived) === 1,
      };
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }

  buildRun(link, prompt, { images }) {
    const imageArgs = images.flatMap((p) => ["-i", p]);
    const perm = this.options.permission === "sandbox" ? [] : ["--dangerously-bypass-approvals-and-sandbox"];
    // The prompt goes in on stdin ("-"): long Chinese text and leading dashes stay intact.
    if (link.sessionId) {
      return { args: ["exec", "resume", link.sessionId, "--json", "--skip-git-repo-check", ...perm, ...imageArgs, "-"], stdin: prompt };
    }
    return { args: ["exec", "--json", "--skip-git-repo-check", "-C", this.runCwd(link), ...perm, ...imageArgs, "-"], stdin: prompt };
  }

  parseLine(line, ctx) {
    const ev = safeJson(line);
    if (!ev) return [];
    switch (ev.type) {
      case "thread.started":
        if (ev.thread_id) ctx.sessionId = ev.thread_id;
        return [];
      case "item.started": {
        const item = ev.item ?? {};
        if (item.type === "reasoning") return [{ type: "thinking" }];
        if (TOOL_ITEMS.has(item.type)) return [{ type: "tool_call", id: item.id, name: toolName(item) }];
        return [];
      }
      case "item.updated":
        return ev.item?.type === "reasoning" ? [{ type: "thinking" }] : [];
      case "item.completed": {
        const item = ev.item ?? {};
        if (item.type === "agent_message" && typeof item.text === "string" && item.text.trim() !== "") {
          return [{ type: "message", text: item.text }];
        }
        if (item.type === "reasoning") return [{ type: "thinking" }];
        if (TOOL_ITEMS.has(item.type)) {
          // Codex sometimes completes an item it never started: open and close the step.
          return [
            { type: "tool_call", id: item.id, name: toolName(item) },
            { type: "tool_result", id: item.id, name: toolName(item) },
          ];
        }
        return [];
      }
      case "turn.failed":
        return [{ type: "failure", code: "turn_failed", message: ev.error?.message ?? null }];
      case "error":
        return [{ type: "failure", code: "error", message: ev.message ?? null }];
      default:
        return [];
    }
  }

  exitFailure(code, stderrTail) {
    const lines = stderrTail.split("\n").filter((l) => l.trim() !== "" && !/Reading additional input from stdin/.test(l));
    return { code: `exit ${code}`, message: lines.slice(-3).join(" ").slice(-300) || null };
  }
}

function firstLineOf(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  const line = text.trim().split("\n")[0].replace(/^\*\*[^*]+\*\*[:：]?\s*/, "").trim();
  return line === "" ? null : line.slice(0, 60);
}

/**
 * DeepSeek Harness. Sessions are indexed per working directory in
 * `~/.dsh/session-flow/index-<encoded cwd>.json` (`sessions{id:{title, cwd, createdAt,
 * lastEventTime, parentSession}}`); archived ids are `global.archivedSessionIds` in
 * `~/.dsh/storages/workspace.json`. A run is `dsh --profile headless --json [--session-id
 * <id>] -` started in the session's cwd (adoption is cwd-scoped), whose stdout lines are
 * `session{sessionId}` → `status{phase: turn_start|step_start|step_end|turn_end}` →
 * `thinking{text}` / `text{text}` / `tool_call{callId,tool}` / `tool_result{callId,status}` →
 * `final{text}` | `error{message}`. Text arrives per committed step, not per token.
 *
 * Inside a dsh session, shell commands see `DSH_SESSION_ID`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliAdapter, safeJson } from "./cli.js";
import { byUpdatedDesc, isoFromMs } from "./base.js";

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export class DshAdapter extends CliAdapter {
  constructor(options = {}) {
    super("dsh", options);
  }

  async available() {
    if (!this.binary) return { ok: false, reason: "没找到 dsh 命令" };
    if (!fs.existsSync(path.join(DSH_HOME, "profiles", "headless"))) return { ok: false, reason: "没有 headless profile" };
    return { ok: true };
  }

  /**
   * The desktop app's per-cwd indexes (`session-flow/`) plus the projection cache
   * (`storages/session_projcache/sessions/<id>.json`, which also holds headless sessions the
   * app never indexed). The index wins where both know a session.
   */
  #all() {
    const archived = new Set(readJson(path.join(DSH_HOME, "storages", "workspace.json"))?.global?.archivedSessionIds ?? []);
    const dir = path.join(DSH_HOME, "session-flow");
    const out = [];
    const known = new Set();
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => /^index-.*\.json$/.test(f));
    } catch {
      /* no desktop index */
    }
    for (const f of files) {
      const sessions = readJson(path.join(dir, f))?.sessions ?? {};
      for (const s of Object.values(sessions)) {
        if (!s?.id || s.parentSession || Number(s.delegationDepth) > 0 || s.empty === true) continue;
        out.push({
          sessionId: s.id,
          title: typeof s.title === "string" && s.title.trim() !== "" ? s.title.trim().slice(0, 60) : (s.firstTask ?? "").slice(0, 40) || null,
          cwd: s.cwd ?? null,
          model: null,
          updatedAt: isoFromMs(s.lastEventTime ?? s.fileMtimeMs ?? s.createdAt),
          archived: archived.has(s.id),
        });
        known.add(s.id);
      }
    }
    const cache = path.join(DSH_HOME, "storages", "session_projcache", "sessions");
    let cached = [];
    try {
      cached = fs.readdirSync(cache).filter((f) => /^session-.*\.json$/.test(f));
    } catch {
      /* no cache */
    }
    for (const f of cached) {
      const id = f.slice(0, -5);
      if (known.has(id)) continue;
      const file = path.join(cache, f);
      const rec = readJson(file)?.record;
      if (!rec?.identity?.cwd || rec.rows?.subagent?.val?.parent) continue;
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(file).mtimeMs;
      } catch {
        /* vanished */
      }
      const title = rec.rows?.title?.val ?? rec.rows?.titleInput?.val?.first?.text ?? null;
      out.push({
        sessionId: id,
        title: typeof title === "string" && title.trim() !== "" ? title.trim().slice(0, 60) : null,
        cwd: rec.identity.cwd,
        model: null,
        updatedAt: isoFromMs(mtimeMs),
        archived: archived.has(id),
      });
    }
    return out.sort(byUpdatedDesc);
  }

  async listSessions({ includeArchived = false, limit = 40 } = {}) {
    return this.#all()
      .filter((s) => includeArchived || !s.archived)
      .slice(0, limit);
  }

  async getSession(sessionId) {
    return this.#all().find((s) => s.sessionId === sessionId) ?? null;
  }

  buildRun(link, prompt) {
    const args = ["--profile", "headless", "--json"];
    if (link.sessionId) args.push("--session-id", link.sessionId);
    args.push("-");
    return { args, stdin: prompt };
  }

  parseLine(line, ctx) {
    const d = safeJson(line);
    if (!d) return [];
    switch (d.type) {
      case "session":
        if (d.sessionId) ctx.sessionId = d.sessionId;
        return [];
      case "thinking":
        return [{ type: "thinking" }];
      case "text":
        return typeof d.text === "string" && d.text.trim() !== "" ? [{ type: "message", text: d.text }] : [];
      case "tool_call":
        return [{ type: "tool_call", id: d.callId, name: d.tool }];
      case "tool_result":
        return [{ type: "tool_result", id: d.callId }];
      case "status":
        if (d.phase === "turn_end" && d.reason?.kind && d.reason.kind !== "completed") {
          if (d.reason.kind === "cancelled" || d.reason.kind === "aborted") return [{ type: "stopped" }];
          return [{ type: "failure", code: d.reason.kind, message: d.reason.message ?? null }];
        }
        return [];
      case "error":
        return [{ type: "failure", code: "dsh", message: d.message ?? null }];
      default:
        return [];
    }
  }

  exitFailure(code, stderrTail) {
    const m = /dsh: ([\w-]+): (.+)/.exec(stderrTail.split("\n").filter(Boolean).slice(-1)[0] ?? "");
    return m ? { code: m[1], message: m[2].slice(0, 300) } : { code: `exit ${code}`, message: stderrTail.slice(-300) || null };
  }
}

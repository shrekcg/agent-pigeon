/**
 * PenguinHarness: a local HTTP API. Discovery through the data root's `server.lock` +
 * `api-token` (the same pair the `penguin` CLI uses); sessions are listed and created per
 * project/agent; input goes in as a task (`queueIfBusy`) or a steer; every linked session's
 * SSE stream is mirrored, so runs started in the Penguin web UI show up in Feishu too.
 */
import fs from "node:fs";
import { paths } from "../core/paths.js";
import { log } from "../core/log.js";
import { AgentAdapter, byUpdatedDesc } from "./base.js";

function readLock() {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.serverLock, "utf8"));
    if (typeof parsed.port === "number" && Number.isInteger(parsed.port)) return parsed;
  } catch {
    /* no live server */
  }
  return null;
}

function readToken() {
  try {
    const v = fs.readFileSync(paths.apiToken, "utf8").trim();
    return v === "" ? null : v;
  } catch {
    return null;
  }
}

/** Splits an SSE byte stream into { event, data } frames. */
export async function* sseFrames(body) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let sep;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const frame = { event: null, data: null };
      const dataLines = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) frame.event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      if (dataLines.length > 0) frame.data = dataLines.join("\n");
      if (frame.data !== null) yield frame;
    }
  }
}

/**
 * Harness-internal marker blocks. The engine and the server wrap their own notices in
 * `[tag]…[/tag]` (or `<tag>…</tag>`), and those arrive on the stream as role=user texts —
 * mirroring them verbatim fills the topic with machinery instead of the human's words.
 * Three kinds: notices that only ever carry harness text (dropped whole), the mid-run
 * message wrapper (opened up, it is the human's own words), and origin blocks that prefix a
 * real message (dropped, whatever follows them kept).
 */
const MIRROR_HIDDEN_TAGS = [
  "turn_aborted", // interrupted-turn transcript resent by the engine
  "turn_retried", // reconnect retry carrying a failed attempt's partial output
  "context_summary", // compaction summary injected as the new context
  "summary", // compaction summary the model is asked to write
  "org_trigger", // organization-scheduler trigger (company mode)
  "developer_instructions", // AGENTS.md wrapper
  "background_task_done", // "a background task finished" notice addressed to the model
];
const MIRROR_WRAPPED_TAGS = ["user_steering"]; // a message sent mid-run: show what it said
const MIRROR_STRIPPED_TAGS = [
  "use_skills", // skills block the web composer prefixes to a message
  "handoff_from", // /agent handoff origin block
  "model_switch_from", // /model switch origin block
  "scheduled_task", // scheduler trigger, followed by the prompt the user wrote
];

function escapeTag(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripMarkerBlocks(text, tag) {
  const t = escapeTag(tag);
  return text
    .replace(new RegExp(`\\[${t}\\][\\s\\S]*?\\[/${t}\\]`, "g"), "")
    .replace(new RegExp(`\\[/?${t}\\]`, "g"), "")
    .replace(new RegExp(`<${t}>[\\s\\S]*?</${t}>`, "g"), "")
    .replace(new RegExp(`</?${t}>`, "g"), "");
}

function startsWithMarkerBlock(text, tag) {
  const t = escapeTag(tag);
  return new RegExp(`^\\s*(\\[${t}\\]|<${t}>)`).test(text);
}

/** Like stripMarkerBlocks, but a wrapped block is opened rather than dropped. */
function unwrapMarkerBlocks(text, tag) {
  const t = escapeTag(tag);
  return text
    .replace(new RegExp(`\\[${t}\\]([\\s\\S]*?)\\[/${t}\\]`, "g"), "$1")
    .replace(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, "g"), "$1")
    .replace(new RegExp(`\\[/?${t}\\]`, "g"), "")
    .replace(new RegExp(`</?${t}>`, "g"), "");
}

/**
 * The user-role text a session actually showed a human: `null` when the message is harness
 * machinery that must never appear in the chat, the bare message for a marked-up wrapper
 * like `[user_steering]…[/user_steering]`, and plain user text unchanged.
 */
export function sanitizeMirroredUserText(text) {
  if (typeof text !== "string") return null;
  let out = text;
  for (const tag of MIRROR_HIDDEN_TAGS) {
    if (startsWithMarkerBlock(out, tag)) return null;
    out = stripMarkerBlocks(out, tag);
  }
  for (const tag of MIRROR_WRAPPED_TAGS) out = unwrapMarkerBlocks(out, tag);
  for (const tag of MIRROR_STRIPPED_TAGS) out = stripMarkerBlocks(out, tag);
  const trimmed = out.trim();
  return trimmed === "" ? null : trimmed;
}

export class PenguinAdapter extends AgentAdapter {
  constructor(options = {}) {
    super("penguin", options);
    this.projectId = options.projectId ?? "default_project";
    this.agentId = options.agentId ?? "default_agent";
    this.workspace = options.workspace ?? null;
    this.base = null;
    this.token = null;
    this.capabilities = { create: true, steer: true, abort: true, approvals: true, sweep: true, mirrorsOwnSide: true };
  }

  resolve(force = false) {
    if (force || this.base === null || this.token === null) {
      const lock = readLock();
      const token = readToken();
      if (!lock) throw new Error("PenguinHarness 服务未运行（没有 server.lock）");
      if (!token) throw new Error("读不到 api-token");
      this.base = `http://localhost:${lock.port}`;
      this.token = token;
    }
    return { base: this.base, token: this.token };
  }

  async available() {
    if (!fs.existsSync(paths.penguinRoot)) return { ok: false, reason: "未安装（没有 ~/.penguin/data）" };
    if (!readLock()) return { ok: true, reason: "已安装，桌面端未运行" };
    return { ok: true };
  }

  async call(method, path, body) {
    const { data } = await this.callWithStatus(method, path, body);
    return data;
  }

  /** Like call(), but keeps the HTTP status (some routes answer by status: 202 vs 204). */
  async callWithStatus(method, path, body) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { base, token } = this.resolve(attempt === 1);
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401 && attempt === 0) {
        lastError = new Error("API token 已失效，重读中");
        continue;
      }
      const text = await res.text();
      let parsed = null;
      try {
        parsed = text === "" ? null : JSON.parse(text);
      } catch {
        /* non-JSON error body */
      }
      if (!res.ok) {
        const code = parsed?.error?.code ?? res.status;
        const message = parsed?.error?.message ?? text.slice(0, 200);
        const err = new Error(`Penguin API ${res.status} ${code}: ${message}`);
        err.code = code;
        err.status = res.status;
        throw err;
      }
      return { status: res.status, data: parsed };
    }
    throw lastError ?? new Error("无法连接 PenguinHarness 服务");
  }

  #record(s) {
    return {
      sessionId: s.sessionId,
      title: s.title ?? null,
      cwd: s.workspace ?? null,
      model: s.modelId ?? null,
      updatedAt: s.lastActiveAt ?? s.updatedAt ?? null,
      archived: s.archived === true,
    };
  }

  async listSessions({ includeArchived = false } = {}) {
    const data = await this.call("GET", `/api/projects/${this.projectId}/agents/${this.agentId}/sessions`);
    return (data?.sessions ?? [])
      .filter((s) => includeArchived || !s.archived)
      .map((s) => this.#record(s))
      .sort(byUpdatedDesc);
  }

  async createSession({ cwd = null, title = null } = {}) {
    const workspace = cwd ?? this.workspace;
    const post = async (ws) => {
      const body = { client: "web" };
      if (ws) body.workspace = ws;
      const data = await this.call("POST", `/api/projects/${this.projectId}/agents/${this.agentId}/sessions`, body);
      const session = data?.session ?? data;
      if (!session?.sessionId) throw new Error(`创建 Session 的响应异常: ${JSON.stringify(data).slice(0, 200)}`);
      return session;
    };
    let session;
    try {
      session = await post(workspace);
    } catch (err) {
      if (!workspace) throw err;
      log("固定工作区不可用，改用临时工作区", workspace, err?.message ?? err);
      session = await post(null);
    }
    const info = await this.getSession(session.sessionId).catch(() => null);
    return info ?? { ...this.#record(session), title };
  }

  async send(link, parts, { mode = "steer" } = {}) {
    const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n\n");
    const onlyText = parts.every((p) => p.type === "text");
    if (mode === "steer" && onlyText && text !== "") {
      try {
        await this.call("POST", `/api/sessions/${link.sessionId}/steer`, { text });
        return { steered: true };
      } catch (err) {
        // Nothing is running: the steer is refused (409 not_running) — send it as a task.
        if (err?.code !== "not_running" && err?.status !== 409) throw err;
      }
    }
    const input = await Promise.all(parts.map((p) => toPenguinPart(p)));
    const res = await this.call("POST", `/api/sessions/${link.sessionId}/tasks`, { input, queueIfBusy: true });
    return { queued: res?.queued === true };
  }

  async abort(link) {
    const { status } = await this.callWithStatus("POST", `/api/sessions/${link.sessionId}/abort`);
    return { running: status === 202 };
  }

  async decide(link, toolCallId, decision) {
    try {
      await this.call("POST", `/api/sessions/${link.sessionId}/approvals/${toolCallId}`, { decision });
      return { ok: true };
    } catch (err) {
      if (String(err?.code ?? "").includes("approval_not_found") || String(err?.message ?? "").includes("approval_not_found")) {
        return { stale: true };
      }
      throw err;
    }
  }

  /** Mirrors the session's SSE stream into run events until the returned stop is called. */
  attach(link) {
    const abort = new AbortController();
    const state = { inCompaction: false };
    void this.#stream(link.sessionId, (frame) => this.#onFrame(link, state, frame), abort.signal);
    return () => abort.abort();
  }

  #onFrame(link, state, frame) {
    let data;
    try {
      data = JSON.parse(frame.data);
    } catch {
      return;
    }
    const emit = link.emit;
    if (frame.event === "server_event") {
      if (data.type === "task_state" && typeof data.state === "string") {
        if (typeof data.queued === "number") emit({ type: "queued", count: data.queued });
        if (data.state === "running") emit({ type: "run_start" });
        else if (data.state === "idle") emit({ type: "run_end" });
      } else if (data.type === "session_title" && typeof data.title === "string" && data.title !== "") {
        if (!data.sessionId || data.sessionId === link.sessionId) emit({ type: "title", title: data.title });
      } else if (data.type === "approval_request") {
        const call = data.toolCall?.payload ?? {};
        emit({ type: "approval", toolCallId: call.tool_call_id, toolName: call.name });
      }
      return;
    }
    const payload = data?.payload;
    if (!payload) return;
    if (data.type === "event_msg") {
      if (payload.type === "compaction_begin") state.inCompaction = true;
      else if (payload.type === "compaction_end") state.inCompaction = false;
      else if (payload.type === "request_end") {
        if (payload.status === "completed") return;
        if (payload.error_code === "aborted" || payload.status === "aborted") emit({ type: "stopped" });
        else emit({ type: "failure", code: payload.error_code ?? payload.status ?? "failed", message: payload.error_message ?? null });
      }
      return;
    }
    if (data.type !== "model_msg" || state.inCompaction) return;
    if (data.origin !== undefined && String(data.origin).length > 0) return; // subagent output

    if (payload.type === "partial_thinking" && payload.role === "assistant") {
      emit({ type: "thinking" });
      return;
    }
    if (payload.type === "tool_call") {
      emit({ type: "tool_call", id: payload.tool_call_id, name: payload.name });
      return;
    }
    if (payload.type === "tool_call_output") {
      emit({ type: "tool_result", id: payload.tool_call_id, name: payload.name });
      return;
    }
    if (payload.type === "partial_text" && payload.role === "assistant") {
      if (payload.event_type === "start") emit({ type: "text_start" });
      else if (payload.event_type === "delta" && typeof payload.text === "string") emit({ type: "text_delta", text: payload.text });
      return;
    }
    if (payload.type !== "text" || typeof payload.text !== "string" || payload.text.trim() === "") return;
    if (payload.role === "assistant") emit({ type: "message", text: payload.text });
    else if (payload.role === "user") {
      const shown = sanitizeMirroredUserText(payload.text);
      if (shown !== null) emit({ type: "user_text", text: shown });
    }
  }

  /**
   * A session's live SSE stream, reconnecting with backoff until aborted. Errors are
   * reported and retried, never thrown out.
   */
  async #stream(sessionId, onFrame, abortSignal) {
    const backoff = [1000, 2000, 5000, 10000, 20000, 30000];
    let attempt = 0;
    while (!abortSignal.aborted) {
      try {
        const { base, token } = this.resolve();
        const res = await fetch(`${base}/api/sessions/${sessionId}/stream`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: abortSignal,
        });
        if (res.status === 401) {
          this.resolve(true);
          throw new Error("stream 401");
        }
        if (res.status === 404) {
          log("会话已不存在，停止镜像", sessionId);
          return;
        }
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        attempt = 0;
        for await (const frame of sseFrames(res.body)) {
          if (abortSignal.aborted) return;
          try {
            onFrame(frame);
          } catch (err) {
            log("mirror frame handler error", sessionId, err);
          }
        }
        throw new Error("stream ended");
      } catch (err) {
        if (abortSignal.aborted) return;
        const wait = backoff[Math.min(attempt, backoff.length - 1)];
        attempt += 1;
        // A stopped desktop app is the normal state for hours: log the first few, then quiet.
        if (attempt <= 3 || attempt % 60 === 0) log("penguin 镜像重连", sessionId, `in ${wait}ms:`, err?.message ?? err);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
}

/** Relay input parts → Penguin task input (media go in as data URLs, as the web composer does). */
async function toPenguinPart(p) {
  if (p.type === "text") return { type: "text", text: p.text };
  const buf = await fs.promises.readFile(p.path);
  if (p.type === "image") return { type: "image_url", imageUrl: `data:${p.mime ?? "image/png"};base64,${buf.toString("base64")}` };
  return { type: "file", fileName: p.name ?? "file.bin", dataUrl: `data:${p.mime ?? "application/octet-stream"};base64,${buf.toString("base64")}` };
}

/**
 * The engine's local surface, 127.0.0.1 only:
 *
 *   - the UI server: the app's window (a WKWebView) loads its pages from here; port in
 *     `ui.port` (fixed preferred port, falls back to a free one);
 *   - the control API under `/api/*`, the same on both ports; its port is also written to
 *     `admin.port` for the CLI the agent skills call.
 *
 * Writes need the `X-AP-Admin: 1` header. A custom header cannot be sent cross-site without a
 * CORS preflight (never answered here), so no web page in a browser can drive this API.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { paths } from "../core/paths.js";
import { log } from "../core/log.js";
import { readRawConfig, writeRawConfig } from "../core/config.js";
import { VERSION } from "../core/version.js";
import { CHANNELS } from "../channels/index.js";
import { AGENT_IDS } from "../agents/index.js";
import { agentLabel } from "../agents/base.js";
import { displayTitle } from "../core/format.js";
import { skillStatus, installSkill, uninstallSkill } from "../skills/install.js";

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };

function readBody(req) {
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", (c) => {
      buf += c;
      if (buf.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      if (buf === "") return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function listen(server, port) {
  return new Promise((resolve) => {
    server.once("error", () => resolve(null));
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
}

export async function startAdmin(hub) {
  const handler = (req, res) => void handle(hub, req, res).catch((err) => send(res, 500, { error: String(err?.message ?? err) }));
  const server = http.createServer(handler);
  // A fixed port keeps the window's origin (and its local storage) stable across restarts.
  const port = (await listen(server, Number(hub.cfg.uiPort) || 47821)) ?? (await listen(http.createServer(handler), 0));
  fs.writeFileSync(paths.uiPort, String(port));
  fs.writeFileSync(paths.adminPort, String(port));
  log(`本地服务 http://127.0.0.1:${port}/`);
  return { port };
}

function send(res, code, value) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

function serveStatic(url, res) {
  const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const file = path.resolve(paths.web, rel);
  if (!file.startsWith(path.resolve(paths.web) + path.sep)) return false;
  let body;
  try {
    body = fs.readFileSync(file);
  } catch {
    return false;
  }
  res.writeHead(200, { "Content-Type": `${TYPES[path.extname(file)] ?? "application/octet-stream"}; charset=utf-8`, "Cache-Control": "no-store" });
  res.end(body);
  return true;
}

async function handle(hub, req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  if (!url.pathname.startsWith("/api/")) {
    if (req.method === "GET" && serveStatic(url, res)) return;
    send(res, 404, { error: "not found" });
    return;
  }
  if (req.method !== "GET" && req.headers["x-ap-admin"] !== "1" && req.headers["x-ht-admin"] !== "1") {
    send(res, 403, { error: "missing X-AP-Admin header" });
    return;
  }
  const body = req.method === "GET" ? {} : await readBody(req);
  switch (`${req.method} ${url.pathname.slice(4)}`) {
    case "GET /overview":
      return send(res, 200, await overview(hub));
    case "POST /settings":
      return send(res, 200, applySettings(hub, body));
    case "POST /restart":
      send(res, 200, { ok: true });
      log("界面请求重启引擎");
      // The app restarts its child when it exits with code 75 (EX_TEMPFAIL).
      setTimeout(() => void hub.shutdown("重启").finally(() => process.exit(75)), 200);
      return undefined;
    case "GET /sessions": {
      const agent = url.searchParams.get("agent") ?? hub.cfg.defaultAgent;
      const adapter = hub.agents.get(agent);
      if (!adapter) return send(res, 404, { error: `Agent「${agent}」未启用` });
      const sessions = await adapter.listSessions({ limit: 40 });
      return send(res, 200, { agent, sessions: sessions.map((s) => ({ ...s, binding: hub.store.bySession(agent, s.sessionId)?.id ?? null })) });
    }
    case "POST /open":
      return send(res, ...(await openSession(hub, body)));
    case "POST /close": {
      const b = findBinding(hub, body);
      if (!b) return send(res, 404, { error: "没有找到这个绑定" });
      await hub.unbind(b.id, { reason: body.reason ?? "手动下线" });
      return send(res, 200, { ok: true });
    }
    case "POST /ask": {
      const b = findBinding(hub, body);
      const question = String(body.question ?? "").trim();
      if (!b || question === "") return send(res, b ? 400 : 409, { error: b ? "缺少 question" : "该会话还没有接入任何渠道" });
      const options = Array.isArray(body.options) ? body.options.map(String).filter(Boolean) : [];
      const out = await hub.channels.get(b.channel).ask(b, { question, options, questionId: `q${Date.now().toString(36)}` });
      return send(res, 200, { ok: true, ...out, bindingId: b.id });
    }
    case "POST /pause":
      hub.setPaused(true);
      return send(res, 200, { paused: true });
    case "POST /resume":
      hub.setPaused(false);
      return send(res, 200, { paused: false });
    case "POST /skills/install":
      return send(res, 200, { result: installSkill(body.agent ?? "all") });
    case "POST /skills/uninstall":
      return send(res, 200, { result: uninstallSkill(body.agent ?? "all") });
    case "GET /logs": {
      let lines = [];
      try {
        lines = fs.readFileSync(paths.logFile, "utf8").trim().split("\n").slice(-200);
      } catch {
        /* none yet */
      }
      return send(res, 200, { lines });
    }
    case "POST /_debug/event": {
      const channel = hub.channels.get(body.channel ?? "feishu");
      if (!channel?.debugEvent) return send(res, 400, { error: "no such channel" });
      return send(res, 200, { ok: true, ...(await channel.debugEvent(String(body.kind ?? ""), body.payload ?? {})) });
    }
    default:
      return send(res, 404, { error: "unknown endpoint" });
  }
}

function findBinding(hub, body) {
  if (body.bindingId) return hub.store.binding(body.bindingId);
  const agent = body.agent ?? "penguin";
  return body.sessionId ? hub.store.bySession(agent, String(body.sessionId), body.channel ?? null) : null;
}

/** `ht open`: bind an agent session (the caller's own, usually) to a channel. */
async function openSession(hub, body) {
  const agent = String(body.agent ?? "penguin");
  const adapter = hub.agents.get(agent);
  if (!adapter) return [404, { error: `Agent「${agent}」未启用` }];
  const channel = hub.channels.get(body.channel ?? "feishu");
  if (!channel || channel.status().ok === false) return [503, { error: `渠道不可用：${channel?.status().reason ?? body.channel}` }];
  let sessionId = String(body.sessionId ?? "").trim();
  if (!sessionId || sessionId.startsWith("$")) return [400, { error: "缺少 sessionId（当前环境里没有这个 Agent 的会话 ID 变量）" }];
  if (sessionId === "latest" || sessionId === "最近") {
    const newest = (await adapter.listSessions({ limit: 1 }))[0];
    if (!newest) return [404, { error: `${adapter.label} 里还没有会话` }];
    sessionId = newest.sessionId;
  }
  let session = await adapter.getSession(sessionId).catch(() => null);
  // A session not written to disk yet (a brand-new conversation) is still bindable: the
  // caller knows its id and working directory.
  if (!session) session = { sessionId, title: null, cwd: body.cwd ?? null, model: null };
  // The caller's own folder wins when it exists: a session file records the folder the
  // session started in, which a moved or forked session no longer runs in.
  if (body.cwd && fs.existsSync(body.cwd)) session.cwd = body.cwd;
  const title = typeof body.title === "string" && body.title.trim() !== "" ? body.title.trim() : session.title ?? `会话 ${sessionId.slice(-8)}`;
  const { binding, already } = await hub.bind(channel, { agent, session, title });
  return [200, { bindingId: binding.id, title: binding.title, display: displayTitle(agent, binding.title), already, channel: channel.label }];
}

async function overview(hub) {
  const agents = await hub.agentRows();
  const raw = readRawConfig();
  const channels = Object.entries(CHANNELS).map(([id, spec]) => {
    const live = hub.channels.get(id);
    const opts = raw.channels?.[id] ?? {};
    return {
      id,
      label: spec.label,
      implemented: Boolean(spec.make),
      enabled: Boolean(live),
      perSession: (live?.isolation ?? opts.isolation ?? "thread") !== "shared",
      status: live?.status() ?? (spec.make ? { ok: false, reason: "已关闭" } : { ok: false, reason: "即将支持" }),
      bindings: hub.store.bindings().filter((b) => b.channel === id).length,
    };
  });
  const skills = skillStatus();
  return {
    version: VERSION,
    paused: hub.isPaused(),
    startedAt: hub.startedAt.toISOString(),
    defaultAgent: hub.cfg.defaultAgent,
    dataDir: paths.appHome,
    agents: AGENT_IDS.map((id) => {
      const row = agents.find((a) => a.id === id);
      const skill = skills.find((s) => s.agent === id);
      return {
        id,
        label: agentLabel(id),
        enabled: Boolean(row),
        ok: row?.ok ?? false,
        reason: row ? row.reason : "已关闭",
        capabilities: row?.capabilities ?? {},
        bindings: row?.topics ?? 0,
        skill: skill ? { installable: skill.files.some((f) => f.rootExists), installed: skill.installed, current: skill.current } : null,
      };
    }),
    channels,
    bindings: hub.store
      .bindings()
      .map((b) => ({
        id: b.id,
        channel: b.channel,
        agent: b.agent,
        agentLabel: agentLabel(b.agent),
        title: b.title,
        display: displayTitle(b.agent, b.title),
        sessionId: b.sessionId,
        cwd: b.cwd,
        createdAt: b.createdAt,
        running: hub.views.get(b.id)?.taskState === "running",
      }))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
  };
}

/**
 * The window's settings: `{ channel?: {id, enabled?, perSession?}, agent?: {id, enabled?},
 * defaultAgent? }`. Writes config.json; a change the running engine cannot take live asks
 * for a restart.
 */
function applySettings(hub, patch) {
  const raw = readRawConfig();
  let restart = false;
  if (typeof patch.defaultAgent === "string" && AGENT_IDS.includes(patch.defaultAgent)) {
    raw.defaultAgent = patch.defaultAgent;
    hub.cfg.defaultAgent = patch.defaultAgent;
  }
  const ch = patch.channel;
  if (ch && CHANNELS[ch.id]?.make) {
    const cur = ((raw.channels ??= {})[ch.id] ??= {});
    if (typeof ch.enabled === "boolean" && ch.enabled !== (cur.enabled !== false)) {
      cur.enabled = ch.enabled;
      restart = true;
    }
    if (typeof ch.perSession === "boolean") {
      cur.isolation = ch.perSession ? "thread" : "shared";
      const live = hub.channels.get(ch.id);
      if (live) live.options.isolation = cur.isolation; // new bindings follow at once
    }
  }
  const ag = patch.agent;
  if (ag && AGENT_IDS.includes(ag.id) && typeof ag.enabled === "boolean") {
    const cur = ((raw.agents ??= {})[ag.id] ??= {});
    if (ag.enabled !== (cur.enabled !== false)) {
      cur.enabled = ag.enabled;
      restart = true;
    }
  }
  writeRawConfig(raw);
  return { ok: true, restart };
}

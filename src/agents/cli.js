/**
 * The shared shape of CLI agents (Codex, Claude Code, Grok, DeepSeek Harness, Pi): one run =
 * one child process that resumes the session headlessly and prints JSON lines. The adapter
 * owns the run's lifecycle — run_start when the process starts, run_end when it exits — and
 * turns each line into run events through `parseLine`.
 *
 * Input that arrives while a run is going is queued and sent as the next run (these CLIs have
 * no mid-turn steer); "停" kills the process group. Runs the user starts in the agent's own
 * UI are not mirrored: the CLI has no stream to follow them on.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "../core/log.js";
import { paths } from "../core/paths.js";
import { AgentAdapter, promptOf } from "./base.js";

/**
 * Agents spawned from the relay must not inherit the environment of whatever launched the
 * relay (an agent's own session variables would make the child think it is nested inside
 * that agent — Claude Code refuses to log in that way). A small allow-list is passed on.
 */
export function cleanEnv(extra = {}) {
  const keep = ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM", "SSH_AUTH_SOCK", "__CF_USER_TEXT_ENCODING"];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  const home = env.HOME ?? os.homedir();
  env.PATH = [
    path.join(home, ".grok", "bin"),
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
  env.LANG = env.LANG ?? "zh_CN.UTF-8";
  return { ...env, ...extra };
}

/** Finds an executable on the clean PATH (or the configured absolute path). */
export function findBinary(name, configured = null) {
  if (configured && fs.existsSync(configured)) return configured;
  for (const dir of cleanEnv().PATH.split(":")) {
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

/** Splits a byte stream into lines on "\n" only (Pi warns that U+2028 must not split). */
export function lineSplitter(onLine) {
  let buf = "";
  return {
    push(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        if (line.trim() !== "") onLine(line);
      }
    },
    end() {
      if (buf.trim() !== "") onLine(buf);
      buf = "";
    },
  };
}

export class CliAdapter extends AgentAdapter {
  constructor(id, options = {}) {
    super(id, options);
    this.binaryName = id;
    this.capabilities = { create: true, steer: false, abort: true, approvals: false, sweep: false, mirrorsOwnSide: false };
    /** key → { child, queue: parts[][], link, stopped } */
    this.runs = new Map();
    this.runTimeoutMs = (Number(options.runTimeoutMinutes) || 60) * 60_000;
  }

  get binary() {
    return findBinary(this.binaryName, this.options.binary ?? null);
  }

  async available() {
    return this.binary ? { ok: true } : { ok: false, reason: `没找到 ${this.binaryName} 命令` };
  }

  /** The working directory a run starts in: the session's own, else the configured default. */
  runCwd(link) {
    // A session's own folder is used only while it exists: a project folder that was moved
    // or renamed must not come back empty. The resume still finds the session by its id.
    if (link.cwd && fs.existsSync(link.cwd)) return link.cwd;
    for (const c of [this.options.workspace, path.join(paths.workspaces, this.id)]) {
      if (!c) continue;
      try {
        fs.mkdirSync(c, { recursive: true });
        return c;
      } catch {
        /* next */
      }
    }
    return os.homedir();
  }

  /** Subclasses: `{ args, stdin? }` for one run of `prompt` (with `link.sessionId` null = new). */
  buildRun() {
    throw new Error("buildRun not implemented");
  }

  /**
   * Subclasses: one stdout line → zero or more run events. `ctx` is per-run scratch space;
   * setting `ctx.sessionId` reports the id a new session got.
   */
  parseLine() {
    return [];
  }

  /** Subclasses: the run's failure, when the process exited without reporting one. */
  exitFailure(code, stderrTail) {
    return { code: `exit ${code}`, message: stderrTail.slice(-300) || null };
  }

  key(link) {
    return link.threadId;
  }

  isRunning(link) {
    return this.runs.get(this.key(link))?.child != null;
  }

  async send(link, parts) {
    const k = this.key(link);
    const run = this.runs.get(k);
    if (run?.child) {
      run.queue.push(parts);
      return { queued: true, ahead: run.queue.length - 1 };
    }
    this.#start(link, parts);
    return { started: true };
  }

  async abort(link) {
    const run = this.runs.get(this.key(link));
    if (!run?.child) return { running: false };
    run.stopped = true;
    run.queue = [];
    killTree(run.child);
    return { running: true };
  }

  #start(link, parts) {
    const k = this.key(link);
    const prompt = promptOf(parts);
    const images = parts.filter((p) => p.type === "image" && p.path).map((p) => p.path);
    const { args, stdin, env } = this.buildRun(link, prompt, { images });
    const cwd = this.runCwd(link);
    const entry = this.runs.get(k) ?? { queue: [], link };
    entry.link = link;
    entry.stopped = false;
    const ctx = { sessionId: null, failure: null, sawText: false };
    const stderr = [];
    let child;
    try {
      child = spawn(this.binary, args, { cwd, env: cleanEnv(env), stdio: ["pipe", "pipe", "pipe"], detached: true });
    } catch (err) {
      link.emit({ type: "run_start" });
      link.emit({ type: "failure", code: "spawn", message: String(err?.message ?? err) });
      link.emit({ type: "run_end" });
      return;
    }
    entry.child = child;
    this.runs.set(k, entry);
    log(`${this.id} 运行开始`, link.threadId, link.sessionId ?? "(新会话)", `cwd=${cwd}`);
    link.emit({ type: "run_start" });

    const out = lineSplitter((line) => {
      let events;
      try {
        events = this.parseLine(line, ctx, link);
      } catch (err) {
        log(`${this.id} 输出解析失败`, String(err?.message ?? err), line.slice(0, 160));
        return;
      }
      if (ctx.sessionId && ctx.sessionId !== link.sessionId) {
        link.emit({ type: "session_id", sessionId: ctx.sessionId });
      }
      for (const ev of events ?? []) {
        if (ev.type === "message" || ev.type === "text_delta") ctx.sawText = true;
        if (ev.type === "failure") ctx.failure = ev;
        link.emit(ev);
      }
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => {
      stderr.push(c);
      if (stderr.length > 200) stderr.splice(0, stderr.length - 200);
    });
    if (stdin !== undefined && stdin !== null) child.stdin.end(stdin);
    else child.stdin.end();

    const timer = setTimeout(() => {
      log(`${this.id} 运行超时，终止`, link.threadId);
      ctx.failure = { type: "failure", code: "timeout", message: `超过 ${Math.round(this.runTimeoutMs / 60000)} 分钟` };
      link.emit(ctx.failure);
      killTree(child);
    }, this.runTimeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    child.on("error", (err) => {
      log(`${this.id} 进程错误`, err?.message ?? err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      out.end();
      entry.child = null;
      if (entry.stopped) link.emit({ type: "stopped" });
      else if (code !== 0 && !ctx.failure) {
        const f = this.exitFailure(code ?? signal, stderr.join(""));
        if (f) link.emit({ type: "failure", ...f });
      }
      log(`${this.id} 运行结束`, link.threadId, `code=${code ?? signal}`);
      link.emit({ type: "run_end" });
      const next = entry.queue.shift();
      if (next) {
        // The link may have learned its session id during this run: send the next on it.
        setTimeout(() => this.#start(entry.link, next), 50);
      }
    });
  }

  async shutdown() {
    for (const run of this.runs.values()) {
      if (run.child) {
        run.stopped = true;
        killTree(run.child);
      }
    }
  }
}

function killTree(child) {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* gone */
    }
  }
  const hard = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }, 4000);
  if (typeof hard.unref === "function") hard.unref();
}

/** Reads the first line of a (possibly large) file without loading all of it. */
export function firstLine(file, maxBytes = 256 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    const s = buf.subarray(0, n).toString("utf8");
    const i = s.indexOf("\n");
    return i >= 0 ? s.slice(0, i) : s;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Reads the last `maxBytes` of a file as lines (the first, partial one dropped). */
export function tailLines(file, maxBytes = 512 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines.filter((l) => l.trim() !== "");
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function safeJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

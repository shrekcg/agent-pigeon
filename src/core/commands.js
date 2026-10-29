/**
 * Pure text helpers of the relay: the `/ht` command parser, the `/pd` queue prefix, stop-intent
 * detection, reply-file path extraction, the run-edge classifier and session lookup. No I/O,
 * so the tests import them directly.
 */
import { normalizeAgentId } from "../agents/index.js";
import { handleOf } from "./format.js";

/**
 * Classifies an `idle` run edge. A stream connection opens with a snapshot of the session's
 * state (Penguin sends `task_state idle` immediately), so an `idle` that no `running`
 * preceded is that snapshot — not a run that just ended. Treating it as a run end reposts
 * the previous run's conclusion and files as if they were fresh, which is exactly how an
 * old answer resurfaces in the topic after a reconnect. `runSeen` is set on `running` and
 * consumed here, so every genuine run end is classified once.
 */
export function idleEdge(entry) {
  if (entry.runSeen !== true) return "snapshot";
  entry.runSeen = false;
  return "run-end";
}

/**
 * /ht family (an optional `@agent` right after the verb picks the agent):
 *   /ht  /ht@codex                 new topic (new session)
 *   /ht〈标题〉 /ht@claude《标题》    new topic with that title
 *   /ht <ID前缀|最近>  /ht@pi 最近   attach an existing session
 *   /ht-list  /ht-list@codex       session list
 *   /ht-agents                     which agents are usable
 *   /ht-help                       help
 *   /ht-cn〈新名字〉                 rename (in-topic: this topic)
 *   /ht-cn〈ID前缀〉〈新名字〉        rename another topic from the main timeline
 *   /ht-close [〈ID前缀〉]           take a topic offline
 *   /ht-use 〈ID前缀〉               shared isolation: where un-quoted messages go
 */
export function parseCommand(rawText) {
  let text = String(rawText).trim();
  if (text.startsWith("／")) text = `/${text.slice(1)}`;
  if (!/^\/ht/i.test(text)) return null;
  let rest = text.slice(3); // after "/ht"
  const norm = rest.toLowerCase();
  const takeAgent = (s) => {
    const m = /^[@＠]([A-Za-z][\w-]*)/.exec(s);
    if (!m) return { agent: undefined, rest: s };
    return { agent: normalizeAgentId(m[1]) ?? `?${m[1]}`, rest: s.slice(m[0].length) };
  };
  if (norm.startsWith("-agents")) return { kind: "agents" };
  if (norm.startsWith("-list")) {
    const { agent } = takeAgent(rest.slice(5).trim());
    const bare = rest.slice(5).trim();
    return { kind: "list", agent: agent ?? (bare !== "" ? normalizeAgentId(bare) ?? `?${bare}` : undefined) };
  }
  if (norm.startsWith("-help")) return { kind: "help" };
  if (norm.startsWith("-use")) {
    const segments = bracketSegments(rest.slice(4));
    const arg = (segments[0] ?? rest.slice(4)).trim();
    return { kind: "use", target: arg === "" ? undefined : arg };
  }
  if (norm.startsWith("-close")) {
    const segments = bracketSegments(rest.slice(6));
    const arg = (segments[0] ?? rest.slice(6)).trim();
    return { kind: "close", target: arg === "" ? undefined : arg };
  }
  if (norm.startsWith("-cn")) {
    const segments = bracketSegments(rest.slice(3));
    if (segments.length >= 2) return { kind: "rename", target: segments[0], name: segments[1] };
    if (segments.length === 1) return { kind: "rename", name: segments[0] };
    return { kind: "rename", name: rest.slice(3).trim() || undefined };
  }
  if (rest.startsWith("-")) return { kind: "help" };
  const picked = takeAgent(rest);
  rest = picked.rest;
  const segments = bracketSegments(rest);
  if (segments.length >= 1) return { kind: "new", agent: picked.agent, name: segments[0] };
  const arg = rest.trim();
  if (arg === "") return { kind: "new", agent: picked.agent };
  return { kind: "attach", agent: picked.agent, target: arg };
}

/**
 * `/pd …` (排队) asks for the queued path instead of the default 插话; a bare `/pd` with
 * nothing after it is an ordinary message. Media carries no text and always queues.
 */
export function splitQueuePrefix(text) {
  if (typeof text !== "string") return { queue: true, text };
  const m = text.match(/^[/／]pd(?:\s+([\s\S]*))?\s*$/i);
  if (!m) return { queue: false, text };
  const rest = (m[1] ?? "").trim();
  if (rest === "") return { queue: false, text };
  return { queue: true, text: rest };
}

function bracketSegments(text) {
  const out = [];
  // 〈标题〉 / 《标题》 / <标题> / ＜标题＞ — the user's fingers decide which one they type.
  const re = /[〈《<＜]([^〉》>＞]+)[〉》>＞]/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1].trim());
  return out.filter((s) => s !== "");
}

/**
 * Stop intent, adapted from the official plugin's abort detection: exact trigger words
 * (any language's obvious ones) plus a few distinctive Chinese phrases — the phrases only
 * count in SHORT messages, so ordinary prose can never trip them.
 */
const STOP_EXACT = new Set(["stop", "esc", "abort", "halt", "wait", "exit", "interrupt", "停止", "停", "中断", "中止", "终止", "别说了", "打住"]);
const STOP_PHRASES = ["中断", "中止", "终止", "停止", "停下", "停一下", "打住", "收手", "别聊", "别说了", "不要继续"];

export function isStopIntent(text) {
  const raw = String(text ?? "").trim().toLowerCase();
  if (raw === "") return false;
  const normalized = raw.replace(/[.!?…,，。;；:：'")\]}]+$/u, "").trim();
  if (normalized === "/stop") return true;
  if (STOP_EXACT.has(normalized)) return true;
  if (normalized.length <= 12 && STOP_PHRASES.some((p) => normalized.includes(p))) return true;
  return false;
}

/**
 * Path-like tokens in a reply (absolute or `~/`, ending in an extension) — the file-follow
 * set. Backticked paths may contain spaces (`/tmp/输出 2026.pdf`); bare ones end at
 * whitespace.
 */
export function extractFilePaths(text) {
  const out = [];
  const add = (token) => {
    const t = token.replace(/[.,;:!?]+$/u, "");
    if (!/\.[A-Za-z0-9]{1,8}$/.test(t)) return;
    if (!out.includes(t)) out.push(t);
  };
  const quoted = /`((?:~\/|\/)[^`\n]+)`/g;
  let m;
  while ((m = quoted.exec(text)) !== null) add(m[1].trim());
  // Markdown links: `[label](/abs/path%20with%20spaces.md)` — models write paths this way.
  const linked = /\]\(((?:~\/|\/)[^)\s]+)\)/g;
  while ((m = linked.exec(text)) !== null) {
    try {
      add(decodeURIComponent(m[1]));
    } catch {
      add(m[1]);
    }
  }
  // …and a link's label is often the path itself, spaces included.
  const labels = /\[((?:~\/|\/)[^\]\n]+)\]\(/g;
  while ((m = labels.exec(text)) !== null) add(m[1].trim());
  const plain = text.replace(/\[[^\]\n]*\]\([^)\n]*\)/g, " ");
  const bare = /(?:^|[\s（(【"'[])((?:~\/|\/)[^\s"'`<>()[\]{}，。；：、）】]+)/g;
  while ((m = bare.exec(plain)) !== null) {
    if (out.some((p) => p.startsWith(m[1]) && p !== m[1])) continue; // the start of a quoted one
    add(m[1]);
  }
  return out;
}

/** Finds one session among `sessions` by exact id, prefix, short handle, title, or "最近". */
export function resolveSession(sessions, target) {
  if (!target) return null;
  const t = String(target).trim();
  if (t === "最近" || t.toLowerCase() === "latest") {
    return [...sessions].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0] ?? null;
  }
  const exact = sessions.find((s) => s.sessionId === t);
  if (exact) return exact;
  const prefix = sessions.filter((s) => s.sessionId.startsWith(t) || s.sessionId.replace(/^session-/, "").startsWith(t));
  if (prefix.length === 1) return prefix[0];
  const suffix = sessions.filter((s) => s.sessionId.endsWith(t) || handleOf(s.sessionId) === t.toLowerCase());
  if (suffix.length === 1) return suffix[0];
  const byTitle = sessions.filter((s) => (s.title ?? "").includes(t));
  if (byTitle.length === 1) return byTitle[0];
  return null;
}

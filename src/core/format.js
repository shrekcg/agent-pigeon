/**
 * Channel-neutral text helpers: the short session handle people type, and the display name
 * a conversation gets in any channel — `[Codex] 会话标题`, so where a conversation came from
 * reads straight off a topic list, a chat name or a message prefix.
 */
import { agentLabel } from "../agents/base.js";

/** A short, typeable handle for a session id (the last 8 hex digits for every id shape seen). */
export function handleOf(sessionId) {
  const s = String(sessionId ?? "");
  if (s === "") return "待生成";
  const m = /([0-9a-f]{8})$/i.exec(s.replace(/-/g, ""));
  return m ? m[1].toLowerCase() : s.slice(-8);
}

export function displayTitle(agent, title) {
  return `[${agentLabel(agent)}] ${title ?? "新会话"}`;
}

export function truncate(text, n) {
  const s = String(text ?? "");
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export function compactPath(p) {
  return String(p).replace(/^\/Users\/[^/]+/, "~");
}

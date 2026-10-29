/**
 * Reads a topic's latest messages straight from Feishu and prints the visible text of each
 * (plain messages and card JSON alike) — what the chat really shows, not what the relay
 * intended. Run with: node tools/topicdump.js <thread_id> [count]
 */
import { loadConfig } from "../src/core/config.js";
import { Feishu } from "../src/channels/feishu/client.js";

const threadId = process.argv[2];
if (!threadId) {
  console.error("usage: node tools/topicdump.js <thread_id> [count]");
  process.exit(2);
}
const count = Math.min(Math.max(Number(process.argv[3] ?? 10), 1), 50);

/** Every `text` / `content` / `title` string inside a card payload, in document order. */
function visibleText(node, out = []) {
  if (typeof node === "string") return out;
  if (Array.isArray(node)) {
    for (const item of node) visibleText(item, out);
    return out;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if ((key === "text" || key === "content" || key === "title") && typeof value === "string") {
        if (value.trim() !== "") out.push(value.trim());
      } else visibleText(value, out);
    }
  }
  return out;
}

const cfg = loadConfig();
const feishu = new Feishu(cfg.channels.feishu);
const res = await feishu.call(
  "GET",
  `/open-apis/im/v1/messages?container_id_type=thread&container_id=${threadId}&sort_type=ByCreateTimeDesc&page_size=${count}`,
);
const items = (res?.items ?? []).slice().reverse();
console.log(`topic ${threadId} · ${items.length} 条（旧 → 新）`);
for (const item of items) {
  const at = new Date(Number(item.create_time)).toLocaleTimeString("zh-CN", { hour12: false });
  let body = item.body?.content ?? "";
  try {
    const parsed = JSON.parse(body);
    const text = visibleText(parsed).join(" | ");
    body = text === "" ? JSON.stringify(parsed).slice(0, 200) : text;
  } catch {
    /* keep the raw string */
  }
  body = body.replace(/\s*\n\s*/g, " ⏎ ");
  if (body.length > 400) body = `${body.slice(0, 400)}…`;
  console.log(`[${at}] ${item.msg_type} ${item.message_id}: ${body}`);
}

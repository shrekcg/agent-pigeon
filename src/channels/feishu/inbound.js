/**
 * Feishu inbound: an `im.message.receive_v1` event → the hub's channel-neutral inbound
 * `{ chatKey, messageId, threadKey, quotedMessageId, text, parts, summary }`. Attachments
 * are downloaded into the inbox and handed on as file paths (every agent can read a file;
 * not every agent takes base64).
 */
import fs from "node:fs";
import path from "node:path";
import { paths } from "../../core/paths.js";
import { log } from "../../core/log.js";

export function textOf(msg) {
  if (msg.message_type === "text") {
    try {
      const parsed = JSON.parse(msg.content ?? "{}");
      return typeof parsed.text === "string" ? parsed.text.replace(/@_user_\d+\s*/g, "").trim() : null;
    } catch {
      return null;
    }
  }
  if (msg.message_type === "post") {
    // Rich text: keep its plain text runs (people paste formatted text from elsewhere).
    try {
      const parsed = JSON.parse(msg.content ?? "{}");
      const body = parsed.content ?? parsed.zh_cn?.content ?? parsed.en_us?.content ?? [];
      const lines = body.map((row) => row.filter((n) => n.tag === "text" || n.tag === "a").map((n) => n.text ?? "").join(""));
      const text = [parsed.title, ...lines].filter(Boolean).join("\n").trim();
      return text === "" ? null : text;
    } catch {
      return null;
    }
  }
  return null;
}

function safeName(name) {
  return String(name ?? "file").replace(/[/\\:\0]/g, "_").slice(0, 120) || "file";
}

const EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };

/**
 * Downloads an image/file message into the inbox. Returns `{ parts, summary }`, or
 * `{ notice }` when the message cannot be handed on (the caller says so in the chat).
 */
export async function inboundMedia(feishu, msg) {
  if (msg.message_type !== "image" && msg.message_type !== "file") {
    return { notice: "目前支持文本、图片和文件消息；语音、视频与表情暂不支持。" };
  }
  try {
    const parsed = JSON.parse(msg.content ?? "{}");
    const dir = path.join(paths.inbox, new Date().toISOString().slice(0, 10));
    fs.mkdirSync(dir, { recursive: true });
    if (msg.message_type === "image") {
      if (!parsed.image_key) return { notice: "图片没能取到。" };
      const { buffer, mime } = await feishu.downloadResource(msg.message_id, parsed.image_key, "image");
      if (buffer.length > 20 * 1024 * 1024) return { notice: "图片超过 20MB，未发送给会话。" };
      const file = path.join(dir, `${msg.message_id}${EXT[mime] ?? ".png"}`);
      fs.writeFileSync(file, buffer);
      return { parts: [{ type: "image", path: file, mime }], summary: "（图片）" };
    }
    if (!parsed.file_key) return { notice: "文件没能取到。" };
    const name = safeName(parsed.file_name ?? "file.bin");
    const { buffer, mime } = await feishu.downloadResource(msg.message_id, parsed.file_key, "file");
    if (buffer.length > 100 * 1024 * 1024) return { notice: `文件「${name}」超过 100MB，未发送给会话。` };
    const file = path.join(dir, `${msg.message_id}-${name}`);
    fs.writeFileSync(file, buffer);
    return { parts: [{ type: "file", path: file, name, mime }], summary: `（文件：${name}）` };
  } catch (err) {
    log("附件处理失败", msg.message_id, err?.message ?? err);
    return { notice: `附件没能取到：${String(err?.message ?? err).slice(0, 140)}` };
  }
}

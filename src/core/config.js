/**
 * Configuration of the engine: `config.json` in the data directory, edited by hand or
 * through the app window. Shape (every field optional):
 *
 *   {
 *     "defaultAgent": "penguin",
 *     "channels": {
 *       "feishu": { "enabled": true, "isolation": "thread"|"shared", "chatId": "oc_…",
 *                   "appId": "…", "appSecret": "…", "baseDomain": "…",
 *                   "allowedAgents": [] }
 *     },
 *     "agents": {
 *       "codex": { "enabled": true, "workspace": "~/…", "permission": "bypass"|"sandbox",
 *                  "permissionMode": "…", "binary": "/abs/path", "runTimeoutMinutes": 60 },
 *       "penguin": { "projectId": "…", "agentId": "…", "workspace": "…" }, …
 *     }
 *   }
 *
 * v1 kept Feishu's chatId/appId and Penguin's workspace at the top level; those still apply.
 * Feishu credentials are normally NOT stored here: they come from PenguinHarness's own
 * database (its feishu messaging binding), so nothing is configured twice. Secrets never
 * leave this module except to the Feishu client.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { paths } from "./paths.js";

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function expandHome(p) {
  return typeof p === "string" && p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

export function readRawConfig() {
  return readJson(paths.config) ?? {};
}

/** Writes the raw config atomically (the config page's save). */
export function writeRawConfig(raw) {
  fs.mkdirSync(path.dirname(paths.config), { recursive: true });
  const tmp = `${paths.config}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
  fs.renameSync(tmp, paths.config);
}

/** The effective config: raw file + v1 fallbacks + Feishu credentials from Penguin's DB. */
export function loadConfig() {
  const raw = readRawConfig();
  const channels = raw.channels && typeof raw.channels === "object" ? structuredClone(raw.channels) : {};
  const agents = raw.agents && typeof raw.agents === "object" ? structuredClone(raw.agents) : {};

  const feishu = (channels.feishu = channels.feishu ?? {});
  feishu.enabled = feishu.enabled !== false;
  feishu.chatId = nonEmpty(feishu.chatId) ?? nonEmpty(raw.chatId);
  feishu.appId = nonEmpty(feishu.appId) ?? nonEmpty(raw.appId);
  feishu.appSecret = nonEmpty(feishu.appSecret) ?? nonEmpty(raw.appSecret);
  feishu.baseDomain = nonEmpty(feishu.baseDomain) ?? nonEmpty(raw.baseDomain) ?? "https://open.feishu.cn";
  feishu.credentialSource = feishu.appId ? "config.json" : null;
  if (!feishu.appId || !feishu.appSecret) {
    const fromDb = readFeishuFromPenguinDb();
    if (fromDb) {
      feishu.appId = fromDb.appId;
      feishu.appSecret = fromDb.appSecret;
      feishu.baseDomain = fromDb.baseDomain || feishu.baseDomain;
      feishu.chatId = feishu.chatId || fromDb.chatId;
      feishu.credentialSource = "PenguinHarness 数据库（现有飞书绑定）";
    }
  }

  agents.penguin = {
    projectId: raw.projectId ?? process.env.PENGUIN_PROJECT_ID ?? "default_project",
    agentId: raw.agentId ?? process.env.PENGUIN_AGENT_ID ?? "default_agent",
    workspace: nonEmpty(raw.workspace),
    ...(agents.penguin ?? {}),
  };
  for (const a of Object.values(agents)) if (a && typeof a.workspace === "string") a.workspace = expandHome(a.workspace);

  return {
    defaultAgent: nonEmpty(raw.defaultAgent) ?? "penguin",
    channels,
    agents,
    uiPort: Number(raw.uiPort) || 47821,
  };
}

/** Reads the stored Feishu binding: credentials + the last chat the bot heard from. */
function readFeishuFromPenguinDb() {
  let db;
  try {
    db = new DatabaseSync(paths.penguinDb, { readOnly: true });
  } catch {
    return null;
  }
  try {
    const row = db
      .prepare("SELECT config_json, last_chat_id FROM messaging_bindings WHERE channel = 'feishu' ORDER BY updated_at DESC LIMIT 1")
      .get();
    if (!row || !row.config_json) return null;
    const parsed = JSON.parse(row.config_json);
    if (!parsed.appId || !parsed.appSecret) return null;
    return { appId: parsed.appId, appSecret: parsed.appSecret, baseDomain: parsed.baseDomain ?? null, chatId: row.last_chat_id ?? null };
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

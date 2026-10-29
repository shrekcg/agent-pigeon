/**
 * Where things live.
 *
 * Two ways to run: from the checkout (`node src/main.js serve`) or from the Mac app, where
 * the engine is one compiled binary at `Agent 信鸽.app/Contents/MacOS/agent-pigeon-engine` and its
 * web UI and skill template sit in `Contents/Resources`. Data always lives outside the code:
 * `~/Library/Application Support/AgentPigeon` (override: `AP_HOME`, or v1's `HT_HOME`).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const home = os.homedir();

/** The `.app` the engine runs from, or null when it runs from a checkout. */
function appBundle() {
  const m = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(process.execPath);
  return m ? m[1] : null;
}

export const bundle = appBundle();

/** Checkout root (dev) — skill template and web UI live under it. */
const checkout = bundle ? null : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const resourcesRoot = bundle ? path.join(bundle, "Contents", "Resources") : checkout;

const LEGACY_HOME = path.join(home, "Library", "Application Support", "FeishuTopicRelay");
/** v0.3 shipped as "Agent 桥" with this data directory. */
const BRIDGE_HOME = path.join(home, "Library", "Application Support", "AgentBridge");

export const appHome = process.env.AP_HOME || process.env.HT_HOME || path.join(home, "Library", "Application Support", "AgentPigeon");

export const penguinRoot = process.env.PENGUIN_HOME && process.env.PENGUIN_HOME !== "" ? process.env.PENGUIN_HOME : path.join(home, ".penguin", "data");

/** How a skill (or a person) runs the control CLI: the app's engine binary, or node + src/main.js. */
export const htCommand = bundle ? `"${process.execPath}" ht` : `node "${path.join(checkout, "src", "main.js")}" ht`;

export const paths = {
  home,
  appHome,
  bundle,
  resourcesRoot,
  legacyHome: LEGACY_HOME,
  config: path.join(appHome, "config.json"),
  state: path.join(appHome, "state.json"),
  paused: path.join(appHome, "PAUSED"),
  adminPort: path.join(appHome, "admin.port"),
  uiPort: path.join(appHome, "ui.port"),
  pidFile: path.join(appHome, "engine.pid"),
  logs: path.join(appHome, "logs"),
  logFile: path.join(appHome, "logs", "engine.log"),
  /** Attachments received from a channel, handed to agents as local files. */
  inbox: path.join(appHome, "inbox"),
  /** Default working directories for sessions created from a channel. */
  workspaces: path.join(appHome, "workspaces"),
  penguinRoot,
  penguinDb: path.join(penguinRoot, "web.db"),
  serverLock: path.join(penguinRoot, "server.lock"),
  apiToken: path.join(penguinRoot, "api-token"),
  /** The v1 launchd job; the app replaces it (see core/legacy.js). */
  legacyPlist: path.join(home, "Library", "LaunchAgents", "com.wcg.feishu-ht-relay.plist"),
  legacyLabel: "com.wcg.feishu-ht-relay",
  web: path.join(resourcesRoot, bundle ? "web" : path.join("app", "web")),
  skillTemplate: path.join(resourcesRoot, bundle ? "skill" : "skill/feishu-topic", "SKILL.md"),
};

/**
 * First run of the app on a machine that ran v1: carry config + topic links over, so the
 * user's existing Feishu topics keep working. Logs and caches stay behind.
 */
export function migrateLegacyHome() {
  if (process.env.AP_HOME || process.env.HT_HOME) return null;
  if (fs.existsSync(path.join(appHome, "state.json"))) return null;
  // The newest earlier home wins: "Agent 桥" (v0.3) over the v1 relay.
  const from = [BRIDGE_HOME, LEGACY_HOME].find((d) => fs.existsSync(path.join(d, "state.json")));
  if (!from) return null;
  fs.mkdirSync(appHome, { recursive: true });
  for (const f of ["config.json", "state.json", "PAUSED"]) {
    const src = path.join(from, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(appHome, f));
  }
  // Sessions created from a channel run in workspaces/<agent>; their recorded cwd points
  // there, so the folder moves with the data (a copy would fork the agents' history).
  const ws = path.join(from, "workspaces");
  if (from === BRIDGE_HOME && fs.existsSync(ws) && !fs.existsSync(path.join(appHome, "workspaces"))) {
    fs.renameSync(ws, path.join(appHome, "workspaces"));
  }
  return from;
}

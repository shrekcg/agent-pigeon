/**
 * The engine: agents below, channels above, the hub in between, and the local API the app's
 * window and the agent skills talk to.
 *
 *   channels (Feishu now; DingTalk / QQ / WeChat coming)
 *        ↕  inbound / views
 *   hub — bindings (channel place ↔ agent session), routing, commands
 *        ↕  link.emit(run events) / send · abort · decide
 *   agents (Penguin, Codex, Claude, Grok, DeepSeek, Pi, Hermes)
 *
 * One engine per user: a pid file guards against a second copy (two engines would both hold
 * the Feishu long connection and answer every message twice).
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { paths, migrateLegacyHome } from "./core/paths.js";
import { log } from "./core/log.js";
import { loadConfig } from "./core/config.js";
import { VERSION } from "./core/version.js";
import { buildAgents } from "./agents/index.js";
import { buildChannels } from "./channels/index.js";
import { Hub } from "./hub/hub.js";
import { startAdmin } from "./api/server.js";
import { refreshInstalledSkills } from "./skills/install.js";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function takeLock() {
  fs.mkdirSync(paths.appHome, { recursive: true });
  try {
    const pid = Number(fs.readFileSync(paths.pidFile, "utf8"));
    if (pid && pid !== process.pid && alive(pid)) throw new Error(`已有一个引擎在运行（pid ${pid}）`);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
  fs.writeFileSync(paths.pidFile, String(process.pid));
}

/** v1 ran as its own launchd job holding the same Feishu connection: retire it. */
function retireLegacyService() {
  if (!fs.existsSync(paths.legacyPlist)) return;
  try {
    execFileSync("launchctl", ["bootout", `gui/${process.getuid()}`, paths.legacyPlist], { stdio: "ignore" });
  } catch {
    /* not loaded */
  }
  const parked = `${paths.legacyPlist}.retired`;
  try {
    fs.renameSync(paths.legacyPlist, parked);
    log("已停用旧版常驻服务", paths.legacyLabel, `→ ${parked}`);
  } catch (err) {
    log("停用旧版常驻服务失败", err?.message ?? err);
  }
}

export async function serve() {
  // Only the installed app takes over the machine (the v1 service, skills in every agent);
  // a checkout run with AP_HOME is a sandbox. The v1 service stops before its state is copied.
  const owner = Boolean(paths.bundle) && !process.env.AP_HOME;
  if (owner) retireLegacyService();
  const migratedFrom = migrateLegacyHome();
  if (migratedFrom) log("已从旧版数据目录迁入配置与话题", migratedFrom);
  takeLock();
  const cfg = loadConfig();
  const agents = buildAgents(cfg);
  const hub = new Hub({ cfg, agents });
  for (const ch of buildChannels(cfg, hub)) hub.addChannel(ch);
  await startAdmin(hub);
  await hub.start();
  // A new app version ships a new skill template: keep installed copies current.
  if (owner) try {
    const n = refreshInstalledSkills();
    if (n > 0) log("已更新各 Agent 里的 Skill", n, "份");
  } catch (err) {
    log("更新 Skill 失败", err?.message ?? err);
  }
  const rows = await hub.agentRows();
  log(
    `引擎已启动 v${VERSION} · 渠道=${[...hub.channels.values()].map((c) => `${c.label}(${c.isolation})`).join(",") || "无"} · Agent=${rows
      .map((r) => `${r.id}${r.ok ? "" : "×"}`)
      .join(",")} · 绑定=${hub.store.bindings().length} 个 · 暂停=${hub.isPaused()}`,
  );

  let stopping = false;
  const stop = (why) => {
    if (stopping) return;
    stopping = true;
    log(`引擎退出（${why}）`);
    const guard = setTimeout(() => process.exit(0), 4000);
    if (typeof guard.unref === "function") guard.unref();
    // Close what is open before dying: cards left "live" keep their 停止 button forever.
    void hub.shutdown("退出").finally(() => {
      try {
        if (Number(fs.readFileSync(paths.pidFile, "utf8")) === process.pid) fs.rmSync(paths.pidFile, { force: true });
      } catch {
        /* gone */
      }
      process.exit(0);
    });
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => stop(sig));
  // The app keeps our stdin open; when the app goes away (crash, force quit) stdin closes.
  if (process.env.AP_PARENT_WATCH === "1") {
    process.stdin.on("end", () => stop("App 已退出"));
    process.stdin.resume();
  }
  return hub;
}

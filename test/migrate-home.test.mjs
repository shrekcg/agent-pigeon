/**
 * Data-home migration: the first run of "Agent 信鸽" carries the topics over from the
 * "Agent 桥" home (v0.3), else from the v1 relay home; an existing home is never touched.
 * Runs in a throwaway HOME, so the real Library is not read or written.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(home) {
  const code = `import { migrateLegacyHome, appHome } from ${JSON.stringify(path.join(root, "src/core/paths.js"))};
    console.log(JSON.stringify({ from: migrateLegacyHome(), appHome }));`;
  const env = { ...process.env, HOME: home };
  delete env.AP_HOME;
  delete env.HT_HOME;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code], { env, encoding: "utf8" }));
}

function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "ap-home-"));
  fs.mkdirSync(path.join(h, "Library", "Application Support"), { recursive: true });
  return h;
}

const support = (h, ...p) => path.join(h, "Library", "Application Support", ...p);

test("Agent 桥 home wins over the v1 home, workspaces move along", () => {
  const h = home();
  fs.mkdirSync(support(h, "AgentBridge", "workspaces", "codex"), { recursive: true });
  fs.writeFileSync(support(h, "AgentBridge", "state.json"), '{"version":2,"bindings":{"a":{}}}');
  fs.writeFileSync(support(h, "AgentBridge", "config.json"), '{"chatId":"oc_x"}');
  fs.mkdirSync(support(h, "FeishuTopicRelay"), { recursive: true });
  fs.writeFileSync(support(h, "FeishuTopicRelay", "state.json"), '{"maps":{}}');
  const r = run(h);
  assert.equal(r.from, support(h, "AgentBridge"));
  assert.equal(r.appHome, support(h, "AgentPigeon"));
  assert.equal(fs.readFileSync(support(h, "AgentPigeon", "state.json"), "utf8"), '{"version":2,"bindings":{"a":{}}}');
  assert.ok(fs.existsSync(support(h, "AgentPigeon", "config.json")));
  assert.ok(fs.existsSync(support(h, "AgentPigeon", "workspaces", "codex")));
  assert.ok(!fs.existsSync(support(h, "AgentBridge", "workspaces")));
  assert.ok(fs.existsSync(support(h, "AgentBridge", "state.json")), "the old home stays as a backup");
});

test("v1 home is used when there is no Agent 桥 home", () => {
  const h = home();
  fs.mkdirSync(support(h, "FeishuTopicRelay"), { recursive: true });
  fs.writeFileSync(support(h, "FeishuTopicRelay", "state.json"), '{"maps":{}}');
  assert.equal(run(h).from, support(h, "FeishuTopicRelay"));
  assert.ok(fs.existsSync(support(h, "AgentPigeon", "state.json")));
});

test("an existing Agent 信鸽 home is left alone", () => {
  const h = home();
  fs.mkdirSync(support(h, "AgentPigeon"), { recursive: true });
  fs.writeFileSync(support(h, "AgentPigeon", "state.json"), "{}");
  fs.mkdirSync(support(h, "AgentBridge"), { recursive: true });
  fs.writeFileSync(support(h, "AgentBridge", "state.json"), '{"x":1}');
  assert.equal(run(h).from, null);
  assert.equal(fs.readFileSync(support(h, "AgentPigeon", "state.json"), "utf8"), "{}");
});

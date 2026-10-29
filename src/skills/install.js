/**
 * The "plugin" half of the bridge: one skill template (skill/feishu-topic/SKILL.md) rendered
 * per agent and written into that agent's own skills directory, so saying “把这个对话接入飞书”
 * in any agent runs `ht open` with that agent's session id.
 *
 * Installed copies carry a marker line; uninstall removes only files with the marker, and a
 * pre-existing hand-written skill of the same name is backed up once before it is replaced.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { paths, htCommand } from "../core/paths.js";

const MARKER = "<!-- installed-by: agent-pigeon -->";
// Markers of earlier releases ("Agent 桥" v0.3, the v0.2 relay), so their copies are upgraded.
const OLD_MARKERS = ["<!-- installed-by: agent-bridge -->", "<!-- installed-by: feishu-agent-bridge -->"];
const NAME = "feishu-topic";
const home = os.homedir();

const CLI_NOTE = (label) =>
  `- 这是 ${label} 的命令行会话：飞书里发的消息会以“无界面续跑”的方式进入同一个会话（每条一轮）。在 ${label} 自己窗口里打的字不会出现在飞书；两边不要同时对同一个会话说话。`;

/** Per agent: where its skills live and how a shell inside it names the current session. */
export const SKILL_TARGETS = {
  penguin: {
    dirs: () => {
      const root = path.join(paths.penguinRoot, "default_project", "agents");
      try {
        return fs
          .readdirSync(root, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => path.join(root, d.name, "agent_state", "skills"));
      } catch {
        return [];
      }
    },
    session: "$PENGUIN_SESSION_ID",
    note: "- PenguinHarness 会话：网页端里跑的每一轮也会实时镜像到飞书话题；运行中在飞书发言默认“插话”，`/pd 内容` 排队。",
  },
  codex: { dirs: () => [path.join(home, ".codex", "skills")], session: "$CODEX_THREAD_ID", note: CLI_NOTE("Codex") },
  claude: { dirs: () => [path.join(home, ".claude", "skills")], session: "$CLAUDE_CODE_SESSION_ID", note: CLI_NOTE("Claude Code") },
  grok: { dirs: () => [path.join(home, ".grok", "skills")], session: "$GROK_SESSION_ID", note: CLI_NOTE("Grok") },
  dsh: { dirs: () => [path.join(home, ".dsh", "skills")], session: "$DSH_SESSION_ID", note: CLI_NOTE("DeepSeek Harness") },
  pi: { dirs: () => [path.join(home, ".pi", "agent", "skills")], session: "$PI_SESSION_ID", note: CLI_NOTE("Pi") },
  hermes: {
    dirs: () => [path.join(home, ".hermes", "skills")],
    session: "latest",
    note: "- Hermes 没有把会话 ID 暴露给命令行，`latest` 表示“Hermes 最近活跃的会话”，接入前确认就是当前这个对话。Hermes 的运行时需要 Hermes Studio 开着。",
  },
};

function render(agent) {
  const t = SKILL_TARGETS[agent];
  const tpl = fs.readFileSync(paths.skillTemplate, "utf8");
  const body = tpl
    .replaceAll("{{HT}}", htCommand)
    .replaceAll("{{AGENT}}", agent)
    .replaceAll("{{SESSION_EXPR}}", t.session)
    .replaceAll("{{SESSION_NOTE}}", t.note ?? "");
  // The marker goes after the frontmatter: loaders want `---` on the first line.
  return body.replace(/^(---\n[\s\S]*?\n---\n)/, `$1${MARKER}\n`);
}

function fileFor(dir) {
  return path.join(dir, NAME, "SKILL.md");
}

function isOurs(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return text.includes(MARKER) || OLD_MARKERS.some((m) => text.includes(m));
  } catch {
    return false;
  }
}

export function skillStatus() {
  const out = [];
  for (const [agent, t] of Object.entries(SKILL_TARGETS)) {
    const dirs = t.dirs();
    const files = dirs.map((d) => {
      const f = fileFor(d);
      const exists = fs.existsSync(f);
      let current = false;
      if (exists && isOurs(f)) {
        try {
          current = fs.readFileSync(f, "utf8") === render(agent);
        } catch {
          current = false;
        }
      }
      return { path: f, exists, ours: exists && isOurs(f), current, rootExists: fs.existsSync(path.dirname(d)) };
    });
    out.push({ agent, files, installed: files.length > 0 && files.every((f) => f.ours), current: files.length > 0 && files.every((f) => f.current) });
  }
  return out;
}

export function installSkill(which = "all") {
  const agents = which === "all" ? Object.keys(SKILL_TARGETS) : [which];
  const results = [];
  for (const agent of agents) {
    const t = SKILL_TARGETS[agent];
    if (!t) {
      results.push({ agent, ok: false, reason: "未知 Agent" });
      continue;
    }
    for (const dir of t.dirs()) {
      // Only install where the agent is actually present (its config root exists).
      if (!fs.existsSync(path.dirname(dir))) {
        results.push({ agent, path: dir, ok: false, reason: "这个 Agent 没有安装" });
        continue;
      }
      const file = fileFor(dir);
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (fs.existsSync(file) && !isOurs(file)) {
          const backup = `${file}.bak-before-bridge`;
          if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
        }
        fs.writeFileSync(file, render(agent));
        results.push({ agent, path: file, ok: true });
      } catch (err) {
        results.push({ agent, path: file, ok: false, reason: String(err?.message ?? err) });
      }
    }
  }
  return results;
}

export function uninstallSkill(which = "all") {
  const agents = which === "all" ? Object.keys(SKILL_TARGETS) : [which];
  const results = [];
  for (const agent of agents) {
    for (const dir of SKILL_TARGETS[agent]?.dirs() ?? []) {
      const file = fileFor(dir);
      if (!isOurs(file)) continue;
      fs.rmSync(file, { force: true });
      const backup = `${file}.bak-before-bridge`;
      if (fs.existsSync(backup)) fs.renameSync(backup, file);
      else {
        try {
          fs.rmdirSync(path.dirname(file));
        } catch {
          /* not empty */
        }
      }
      results.push({ agent, path: file, ok: true });
    }
  }
  return results;
}

/** Rewrites every installed copy that differs from the current template; returns how many. */
export function refreshInstalledSkills() {
  let n = 0;
  for (const s of skillStatus()) {
    if (!s.files.some((f) => f.ours && !f.current)) continue;
    n += installSkill(s.agent).filter((r) => r.ok).length;
  }
  return n;
}

/**
 * The control CLI — what every agent's `feishu-topic` skill and a person in a terminal run.
 * It only talks to a running engine through its local admin API (`admin.port`); starting
 * and stopping the engine is the app's job.
 *
 *   ht open  --agent <id> --session <会话ID> [--title <标题>] [--cwd <目录>] [--channel feishu]
 *   ht ask   --agent <id> --session <会话ID> --question "问题" [--options "A|B"]
 *   ht close --agent <id> --session <会话ID>
 *   ht list  [--agent <id>]
 *   ht agents | status | pause | resume | ui
 *   ht skills [install|uninstall|status] [--agent <id>|all]
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { paths } from "../core/paths.js";

const NOT_RUNNING = "Agent 信鸽没有在运行：打开「Agent 信鸽」App（菜单栏图标）后再试。";

const USAGE = `用法（ht）：
  ht open  --agent <id> --session <会话ID> [--title 标题] [--cwd 目录]   把会话接入飞书
  ht ask   --agent <id> --session <会话ID> --question "问题" [--options "A|B|C"]
  ht close --agent <id> --session <会话ID>                              断开
  ht list  [--agent <id>]                                             某个 Agent 的会话
  ht agents                                                           本机各 Agent 是否可用
  ht skills [install|uninstall|status] [--agent <id>|all]             「接入飞书」Skill
  ht status | pause | resume | ui
Agent：penguin codex claude grok dsh pi hermes（不写 --agent 时按当前环境变量推断）`;

export async function runHt(argv) {
  const cmd = argv[0] ?? "help";
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const out = (text) => {
    if (text) console.log(text);
    return 0;
  };
  const fail = (text) => {
    console.error(text);
    return 1;
  };

  /** The agent this command is about: `--agent`, else inferred from the caller's environment. */
  const agentAndSession = () => {
    const env = process.env;
    const known = [
      ["penguin", env.PENGUIN_SESSION_ID],
      ["codex", env.CODEX_THREAD_ID],
      ["claude", env.CLAUDE_CODE_SESSION_ID],
      ["grok", env.GROK_SESSION_ID],
      ["dsh", env.DSH_SESSION_ID],
      ["pi", env.PI_SESSION_ID],
    ];
    const agent = flag("agent") ?? known.find(([, v]) => v)?.[0] ?? "penguin";
    const session = flag("session") ?? known.find(([a]) => a === agent)?.[1] ?? null;
    return { agent, session };
  };

  const admin = async (method, path, body) => {
    let port;
    try {
      port = Number(fs.readFileSync(paths.adminPort, "utf8").trim());
    } catch {
      return null;
    }
    if (!Number.isInteger(port) || port <= 0) return null;
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { "Content-Type": "application/json", "X-AP-Admin": "1" },
        signal: AbortSignal.timeout(20_000),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      return { status: res.status, data: text === "" ? null : JSON.parse(text) };
    } catch {
      return null;
    }
  };

  switch (cmd) {
    case "open": {
      const { agent, session } = agentAndSession();
      if (!session) return fail(`缺少 --session（当前环境里也没有 ${agent} 的会话 ID 变量）`);
      const r = await admin("POST", "/api/open", { agent, sessionId: session, title: flag("title"), cwd: flag("cwd") ?? process.cwd(), channel: flag("channel") ?? "feishu" });
      if (r === null) return fail(NOT_RUNNING);
      if (r.status !== 200) return fail(`失败：${r.data?.error ?? r.status}`);
      if (r.data.already) return out(`已经接过了：「${r.data.display}」（${r.data.channel}）`);
      return out(`已接入${r.data.channel}：「${r.data.display}」，去${r.data.channel}里看看吧。`);
    }
    case "ask": {
      const { agent, session } = agentAndSession();
      const question = flag("question");
      if (!session || !question) return fail('缺少参数：ht ask --agent <id> --session <会话ID> --question "问题" [--options "A|B|C"]');
      const options = (flag("options") ?? "").split("|").map((s) => s.trim()).filter(Boolean);
      const r = await admin("POST", "/api/ask", { agent, sessionId: session, question, options });
      if (r === null) return fail(NOT_RUNNING);
      if (r.status !== 200) return fail(`失败：${r.data?.error ?? r.status}`);
      return out("已发出提问卡；回答会作为新消息进入会话。");
    }
    case "close": {
      const { agent, session } = agentAndSession();
      if (!session) return fail("缺少 --session");
      const r = await admin("POST", "/api/close", { agent, sessionId: session });
      if (r === null) return fail(NOT_RUNNING);
      if (r.status !== 200) return fail(`失败：${r.data?.error ?? r.status}`);
      return out("已断开。");
    }
    case "list": {
      const agent = flag("agent") ?? agentAndSession().agent;
      const r = await admin("GET", `/api/sessions?agent=${encodeURIComponent(agent)}`);
      if (r === null) return fail(NOT_RUNNING);
      if (r.status !== 200) return fail(`失败：${r.data?.error ?? r.status}`);
      const sessions = r.data.sessions ?? [];
      console.log(`${agent} 会话 ${sessions.length} 个（* = 已接入）：`);
      for (const s of sessions.slice(0, 30)) console.log(`  ${s.binding ? "*" : "-"} ${s.title ?? "(未命名)"}  ${s.sessionId}`);
      return 0;
    }
    case "agents": {
      const r = await admin("GET", "/api/overview");
      if (r === null) return fail(NOT_RUNNING);
      for (const a of r.data.agents) console.log(`  ${a.ok ? "[可用]" : "[不可用]"} ${a.id.padEnd(8)} ${a.ok ? `已接入 ${a.bindings} 个` : a.reason ?? ""}`);
      return 0;
    }
    case "skills": {
      const action = argv[1] && !argv[1].startsWith("--") ? argv[1] : "status";
      const which = flag("agent") ?? "all";
      // Works with the engine stopped too: the installer is plain file writes.
      const { skillStatus, installSkill, uninstallSkill } = await import("../skills/install.js");
      if (action === "install" || action === "uninstall") {
        const results = action === "install" ? installSkill(which) : uninstallSkill(which);
        for (const r of results) console.log(`  ${r.ok ? "[ok]" : "[--]"} ${r.agent.padEnd(8)} ${r.path ?? ""}${r.ok ? "" : `（${r.reason}）`}`);
        return out(results.length === 0 ? "没有需要处理的。" : "");
      }
      for (const s of skillStatus()) {
        const present = s.files.some((f) => f.rootExists);
        console.log(`  ${s.agent.padEnd(8)} ${present ? (s.current ? "已安装" : s.installed ? "有更新" : "未安装") : "本机没有这个 Agent"}`);
      }
      return 0;
    }
    case "ui": {
      let port = null;
      try {
        port = Number(fs.readFileSync(paths.uiPort, "utf8").trim());
      } catch {
        /* not running */
      }
      if (!port) return fail(NOT_RUNNING);
      const url = `http://127.0.0.1:${port}/`;
      try {
        execFileSync("open", [url]);
      } catch {
        /* not macOS */
      }
      return out(url);
    }
    case "pause":
    case "resume": {
      const r = await admin("POST", `/api/${cmd}`);
      if (r === null) return fail(NOT_RUNNING);
      return out(cmd === "pause" ? "已暂停转发（指令仍可用）。" : "已恢复转发。");
    }
    case "status": {
      const live = await admin("GET", "/api/overview");
      console.log("Agent 信鸽");
      if (!live?.data) {
        console.log("  引擎：未运行");
        return 0;
      }
      const d = live.data;
      console.log(`  引擎：运行中（v${d.version}，启动于 ${d.startedAt}）`);
      console.log(`  转发：${d.paused ? "已暂停" : "正常"}    已接入会话：${d.bindings.length} 个`);
      console.log(`  渠道：${d.channels.filter((c) => c.enabled).map((c) => `${c.label}${c.status?.ok ? "" : "（异常）"}`).join("、") || "无"}`);
      console.log(`  Agent：${d.agents.map((a) => `${a.id}${a.ok ? "" : "×"}`).join(" ")}`);
      return 0;
    }
    default:
      return out(USAGE);
  }
}

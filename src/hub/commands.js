/**
 * `/ht` command execution: the channel-neutral half of every command. Parsing lives in
 * core/commands.js; rendering is the channel's `reply()`.
 */
import { log } from "../core/log.js";
import { resolveSession } from "../core/commands.js";
import { displayTitle, handleOf } from "../core/format.js";
import { agentLabel } from "../agents/base.js";

const DEFAULT_TITLE = "新会话";

function pickAgent(hub, channel, requested) {
  if (requested && requested.startsWith("?")) throw new Error(`不认识的 Agent：${requested.slice(1)}（发 /ht-agents 看可用的）`);
  const id = requested ?? channel.options.defaultAgent ?? hub.cfg.defaultAgent;
  const adapter = hub.agents.get(id);
  if (!adapter) throw new Error(`Agent「${id}」没有启用（本地配置页可打开）`);
  if (!channel.allowsAgent(id)) throw new Error(`这个渠道没有放行 Agent「${agentLabel(id)}」`);
  return { id, adapter };
}

/** The binding a command run in this place refers to (in a topic, or the active one). */
function hereBinding(hub, channel, inbound) {
  return channel.resolveBinding(inbound);
}

async function findByTarget(hub, target) {
  // An id prefix / handle / title, searched across every agent that has bindings.
  const bindings = hub.store.bindings();
  const t = String(target).trim();
  const direct = bindings.filter((b) => b.sessionId && (b.sessionId.startsWith(t) || handleOf(b.sessionId) === t.toLowerCase() || (b.title ?? "").includes(t)));
  return direct.length === 1 ? direct[0] : null;
}

export async function runCommand(hub, channel, cmd, inbound) {
  try {
    switch (cmd.kind) {
      case "help":
        return await channel.reply(inbound, { kind: "help", agents: await hub.agentRows(), defaultAgent: channel.options.defaultAgent ?? hub.cfg.defaultAgent });
      case "agents":
        return await channel.reply(inbound, { kind: "agents", rows: await hub.agentRows() });
      case "list": {
        const { id, adapter } = pickAgent(hub, channel, cmd.agent);
        const sessions = await adapter.listSessions({ limit: 30 });
        return await channel.reply(inbound, { kind: "list", agent: id, sessions, bindings: hub.store.bindings() });
      }
      case "new":
        return await newSession(hub, channel, cmd, inbound);
      case "attach":
        return await attach(hub, channel, cmd, inbound);
      case "rename":
        return await rename(hub, channel, cmd, inbound);
      case "close":
        return await close(hub, channel, cmd, inbound);
      case "use":
        return await use(hub, channel, cmd, inbound);
      default:
        return await channel.reply(inbound, { kind: "help", agents: await hub.agentRows(), defaultAgent: hub.cfg.defaultAgent });
    }
  } catch (err) {
    log("指令执行失败", cmd.kind, err?.message ?? err);
    await channel.reply(inbound, { kind: "error", text: String(err?.message ?? err) }).catch(() => {});
    return undefined;
  }
}

/** New session + its place; an unbound topic's first message rides in as `firstInput`. */
async function newSession(hub, channel, cmd, inbound) {
  if (inbound.threadKey && channel.resolveBinding(inbound) && !cmd.firstInput) {
    throw new Error("这个话题已经连着一个会话了。新开请回主对话发 /ht。");
  }
  const { id, adapter } = pickAgent(hub, channel, cmd.agent);
  const st = await adapter.available();
  if (!st.ok) throw new Error(`${adapter.label} 现在不可用：${st.reason ?? "未知原因"}`);
  const session = await adapter.createSession({ title: cmd.name ?? null });
  const title = cmd.name ?? session.title ?? DEFAULT_TITLE;
  const { binding } = await hub.bind(channel, { agent: id, session, title, ctx: inbound });
  if (cmd.firstInput) {
    await hub.send(binding.id, cmd.firstInput.parts, { mode: "queue", summary: cmd.firstInput.summary });
  }
  if (!inbound.threadKey && !cmd.firstInput) {
    await channel.reply(inbound, {
      kind: "text",
      text: `已开好「${displayTitle(id, title)}」${binding.sessionId ? `（会话 ${handleOf(binding.sessionId)}）` : "，发第一句话后生成会话"}。`,
      bindingId: binding.id,
    });
  }
  return binding;
}

async function attach(hub, channel, cmd, inbound) {
  const { id, adapter } = pickAgent(hub, channel, cmd.agent);
  const sessions = await adapter.listSessions({ limit: 200 });
  const session = resolveSession(sessions, cmd.target);
  if (!session) {
    throw new Error(
      [
        `在 ${adapter.label} 里找不到会话：${cmd.target}`,
        "",
        `· 看 ID：\`/ht-list@${id}\``,
        `· 想**新建**：用括号包住标题，例如 \`/ht@${id}〈文件测试〉\``,
      ].join("\n"),
    );
  }
  if (inbound.threadKey && channel.resolveBinding(inbound)) throw new Error("这个话题已经绑定了会话。");
  const title = session.title ?? `会话 ${handleOf(session.sessionId)}`;
  const { binding, already } = await hub.bind(channel, { agent: id, session, title, ctx: inbound });
  await channel.reply(inbound, {
    kind: "text",
    text: already ? `已经接过了：「${displayTitle(id, binding.title)}」。` : `已为「${displayTitle(id, title)}」开好${channel.isolation === "shared" ? "会话" : "话题"}。`,
    bindingId: binding.id,
  });
  return binding;
}

async function rename(hub, channel, cmd, inbound) {
  let b = hereBinding(hub, channel, inbound);
  if (cmd.target) b = (await findByTarget(hub, cmd.target)) ?? b;
  if (!b || !cmd.name) throw new Error("没找到要改的会话。在话题内发 /ht-cn〈新名字〉，或在主对话发 /ht-cn〈ID前缀〉〈新名字〉。");
  hub.store.updateBinding(b.id, { title: cmd.name });
  hub.link(b.id);
  await channel.refresh(hub.store.binding(b.id));
  if (!inbound.threadKey) await channel.reply(inbound, { kind: "text", text: `已改名为「${cmd.name}」。`, bindingId: b.id });
  return b;
}

async function close(hub, channel, cmd, inbound) {
  let b = cmd.target ? await findByTarget(hub, cmd.target) : hereBinding(hub, channel, inbound);
  if (!b && !cmd.target) b = hereBinding(hub, channel, inbound);
  if (!b) throw new Error("没找到要下线的会话。在话题内发 /ht-close，或在主对话发 /ht-close〈ID前缀〉。");
  const title = displayTitle(b.agent, b.title);
  await hub.unbind(b.id, { reason: "手动下线", notify: true });
  if (!inbound.threadKey) await channel.reply(inbound, { kind: "text", text: `已下线「${title}」。` });
  return b;
}

/** Shared isolation: picks which binding un-quoted messages go to. */
async function use(hub, channel, cmd, inbound) {
  const b = cmd.target ? await findByTarget(hub, cmd.target) : null;
  if (!b || b.channel !== channel.id) throw new Error("没找到这个会话。`/ht-use〈ID前缀〉` 只能切到本渠道已接入的会话。");
  hub.store.setActive(`${channel.id}:${inbound.chatKey}`, b.id);
  await channel.reply(inbound, { kind: "text", text: `接下来的消息发给「${displayTitle(b.agent, b.title)}」。`, bindingId: b.id });
  return b;
}

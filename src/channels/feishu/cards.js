/**
 * Card builders (classic card JSON). The 名片 is the topic's root message: its first line is
 * what the Feishu topic list shows as the topic's name — `[Codex] 会话标题` — so the agent a
 * topic belongs to reads straight off the list. The card body carries the session's identity,
 * so the anchor doubles as the index entry in the main timeline.
 */
import { chunkText } from "./client.js";
import { agentLabel } from "../../agents/base.js";
import { handleOf, displayTitle, truncate, compactPath } from "../../core/format.js";

export { handleOf, truncate };

const MODEL = "blue";

/** A classic-card header with an icon from Feishu's own icon set (no emoji). */
function header(title, { icon = null, template = MODEL } = {}) {
  return {
    template,
    title: { tag: "plain_text", content: title },
    ...(icon ? { ud_icon: { tag: "standard_icon", token: icon } } : {}),
  };
}

/** The topic's visible name: agent tag + session title. */
export const topicTitle = displayTitle;

export function nameCard({ agent, title, sessionId, model, workspace, status }) {
  const lines = [
    `**Agent**：${escapeMd(agentLabel(agent))}`,
    `**会话**：${sessionId ? escapeMd(sessionId) : "（首条消息后生成）"}`,
    ...(model ? [`**模型**：${escapeMd(model)}`] : []),
    ...(workspace ? [`**目录**：${escapeMd(compactPath(workspace))}`] : []),
    `**状态**：${status ?? "已接入"}`,
  ];
  return {
    config: { wide_screen_mode: true },
    header: header(topicTitle(agent, title), { icon: "pin_outlined", template: MODEL }),
    elements: [
      { tag: "div", text: { tag: "lark_md", content: lines.join("\n") } },
      { tag: "hr" },
      { tag: "note", elements: [{ tag: "plain_text", content: "在本话题内发言即可与这个会话对话；改标题发 /ht-cn 〈新名字〉。" }] },
    ],
  };
}

/**
 * The conclusion of one run, on its own: no header, no session title, no machinery — just the
 * answer, posted below the question so it reads in order. The process card above it keeps the
 * tool calls and the analysis, folded away.
 */
export function conclusionCard(text, label = null) {
  const body = text.length > 18000 ? `${text.slice(0, 18000)}\n\n…（过长已截断，完整内容见原 Agent 会话）` : text;
  return {
    config: { wide_screen_mode: true },
    // Shared isolation: one chat carries many sessions, so the answer says whose it is.
    ...(label ? { header: header(label, { icon: "chat-news_outlined", template: "wathet" }) } : {}),
    elements: [{ tag: "div", text: { tag: "lark_md", content: body } }],
  };
}

export function helpCard({ agents = [], defaultAgent = "penguin", isolation = "thread" } = {}) {
  const usable = agents.filter((a) => a.ok).map((a) => `\`${a.id}\``);
  const where = isolation === "shared" ? "会话" : "话题";
  const content = [
    `**/ht**　新建会话 + 开${where}（默认 Agent：${agentLabel(defaultAgent)}；想命名：\`/ht〈标题〉\`）`,
    "**/ht@codex**　用指定 Agent 新建（`/ht@claude〈标题〉` 同理）",
    `**/ht 〈ID前缀〉** 或 **/ht@codex 最近**　给已有会话开${where}`,
    "**/ht-list** 或 **/ht-list@codex**　会话列表（含接入状态）",
    "**/ht-agents**　本机各 Agent 的接入状态",
    ...(isolation === "shared" ? ["**/ht-use 〈ID前缀〉**　切换当前对话的会话（回复某条消息也会发给它的会话）"] : []),
    `**/ht-cn〈新名字〉**　改本${where}标题`,
    `**/ht-close**　下线本${where}；主对话可 \`/ht-close〈ID前缀〉\``,
    "",
    `${where}内发言 = 直接对话；运行中默认插话（支持的 Agent），\`/pd …\` 排队；发「停」中断。`,
    usable.length > 0 ? `可用 Agent：${usable.join(" ")}` : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
  return {
    config: { wide_screen_mode: true },
    header: header("Agent 信鸽 · 指令", { icon: "list_outlined", template: MODEL }),
    elements: [{ tag: "div", text: { tag: "lark_md", content } }],
  };
}

export function agentsCard(rows) {
  const lines = rows.map(
    (r) =>
      `${r.ok ? "<font color='green'>可用</font>" : "<font color='grey'>不可用</font>"}　**${escapeMd(agentLabel(r.id))}** \`${r.id}\`　${r.ok ? `已接入 ${r.topics} 个` : escapeMd(r.reason ?? "")}`,
  );
  return {
    config: { wide_screen_mode: true },
    header: header("本机 Agent", { icon: "computer_outlined", template: MODEL }),
    elements: [{ tag: "div", text: { tag: "lark_md", content: lines.join("\n") || "（没有配置 Agent）" } }],
  };
}

export function listCard({ agent, sessions, maps }) {
  const bySession = new Map(maps.filter((m) => m.agent === agent).map((m) => [m.sessionId, m]));
  const ordered = [...sessions].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const rows = ordered.slice(0, 30).map((s) => {
    const m = bySession.get(s.sessionId);
    const name = m?.title ?? s.title ?? "(未命名)";
    const topic = m ? "已开话题" : "未开";
    const active = shortTime(s.updatedAt);
    return `• **${escapeMd(truncate(name, 24))}**　\`${handleOf(s.sessionId)}\`　${topic}${active ? `　${active}` : ""}`;
  });
  const content = rows.length > 0 ? rows.join("\n") : "（还没有会话）";
  return {
    config: { wide_screen_mode: true },
    header: header(`${agentLabel(agent)} 会话（${ordered.length} 个）`, { icon: "history_outlined", template: MODEL }),
    elements: [
      { tag: "div", text: { tag: "lark_md", content } },
      { tag: "hr" },
      {
        tag: "note",
        elements: [{ tag: "plain_text", content: `开话题：/ht@${agent} 〈ID前缀〉；新建：/ht@${agent}〈标题〉。` }],
      },
    ],
  };
}

export function noticeCard(title, lines, template = "grey", icon = "info_outlined") {
  return {
    config: { wide_screen_mode: true },
    header: header(title, { icon, template }),
    elements: [{ tag: "div", text: { tag: "lark_md", content: lines.join("\n") } }],
  };
}

export function errorCard(text) {
  return noticeCard("出错了", [text], "red", "warning_outlined");
}

/** The approval notice: the two buttons call back over the app's long connection. */
export function approvalCard({ toolName, toolCallId, bindingId, detail = null }) {
  return {
    config: { wide_screen_mode: true },
    header: header("有工具调用等待审批", { icon: "approval_outlined", template: "orange" }),
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `**工具**：${escapeMd(toolName ?? "未知")}${detail ? `\n${escapeMd(truncate(detail, 300))}` : ""}\n直接在下面选「允许」或「拒绝」（也可以在原 Agent 里处理）。`,
        },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "允许" },
            type: "primary",
            value: { action: "approve", bindingId, toolCallId, toolName },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "拒绝" },
            type: "danger",
            value: { action: "deny", bindingId, toolCallId, toolName },
          },
        ],
      },
    ],
  };
}

/** The approval card after a decision: buttons replaced by the outcome. */
export function approvalDecidedCard({ decision, toolName }) {
  return {
    config: { wide_screen_mode: true },
    header: header(decision === "allow" ? "已允许" : "已拒绝", {
      icon: decision === "allow" ? "succeed_filled" : "close_filled",
      template: decision === "allow" ? "green" : "red",
    }),
    elements: [
      { tag: "div", text: { tag: "lark_md", content: `工具：${escapeMd(toolName ?? "未知")}\n已处理，不会再重复提醒。` } },
    ],
  };
}

/** A duplicate/stale approval card: the tool call behind it was already decided (or expired). */
export function approvalGoneCard({ toolName }) {
  return {
    config: { wide_screen_mode: true },
    header: header("该审批已处理过", { icon: "done_outlined", template: "grey" }),
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: `工具：${escapeMd(toolName ?? "未知")}\n这条审批此前已批准/拒绝或已失效，无需再操作。` },
      },
    ],
  };
}

/**
 * The ask card (classic card 1.0 — its `action` container and `form` are still supported,
 * unlike card 2.0): options become buttons, otherwise a text input with a submit button.
 * Answers arrive as `card.action.trigger` on the same long connection.
 */
export function askCard({ question, options, bindingId, questionId }) {
  const elements = [{ tag: "div", text: { tag: "lark_md", content: escapeMd(question) } }];
  if (Array.isArray(options) && options.length > 0) {
    elements.push({
      tag: "action",
      actions: options.slice(0, 6).map((opt) => ({
        tag: "button",
        text: { tag: "plain_text", content: truncate(String(opt), 40) },
        type: "default",
        value: { action: "answer", bindingId, questionId, answer: String(opt) },
      })),
    });
  } else {
    elements.push({
      tag: "form",
      // Classic cards require a non-empty form name (code 11310 otherwise).
      name: "ask_form",
      elements: [
        { tag: "input", name: "answer", placeholder: { tag: "plain_text", content: "输入你的回答…" } },
        {
          tag: "button",
          action_type: "form_submit",
          name: "submit",
          type: "primary",
          text: { tag: "plain_text", content: "提交" },
          value: { action: "answer", bindingId, questionId },
        },
      ],
    });
  }
  return {
    config: { wide_screen_mode: true },
    header: header("需要你确认", { icon: "chat-news_outlined", template: "turquoise" }),
    elements,
  };
}

/** The ask card after it was answered. */
export function askAnsweredCard({ question, answer }) {
  return {
    config: { wide_screen_mode: true },
    header: header("已回答", { icon: "succeed_filled", template: "green" }),
    elements: [
      { tag: "div", text: { tag: "lark_md", content: `**问题**：${escapeMd(question)}\n**回答**：${escapeMd(answer)}` } },
    ],
  };
}

/** Mirroring a long assistant reply: one text message per chunk. */
export function mirrorChunks(text) {
  return chunkText(text, 3800);
}

export function escapeMd(text) {
  return String(text).replace(/([*_`~[\]])/g, "\\$1");
}

function shortTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return sameDay ? `今天 ${hh}:${mm}` : `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

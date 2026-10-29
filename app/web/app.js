// Agent 信鸽 — the window's script. Plain DOM, no build step; talks to the engine's same-origin
// API. Inside the app, the native shell sets `window.AP_NATIVE` and offers `webkit.messageHandlers.ap`.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const native = window.webkit?.messageHandlers?.ab ?? null;
if (native) document.body.classList.add("native");

// Logos: brand marks from LobeHub Icons (MIT), magpie (MIT), simple-icons (CC0), Ant Design
// Icons (MIT) and Feishu's own app icon. `mono` ones are single-colour and follow dark mode.
const LOGOS = {
  penguin: { src: "icons/penguin.svg", bleed: true },
  codex: { src: "icons/codex.svg", bleed: true },
  claude: { src: "icons/claude.svg" },
  grok: { src: "icons/grok.svg", mono: true },
  dsh: { src: "icons/dsh.svg" },
  pi: { src: "icons/pi.svg", mono: true },
  hermes: { src: "icons/hermes.svg", mono: true },
  grokbot: { src: "icons/grokbot.svg", mono: true },
  feishu: { src: "icons/feishu.png", bleed: true },
  dingtalk: { src: "icons/dingtalk.svg" },
  qq: { src: "icons/qq.svg" },
  wechat: { src: "icons/wechat.svg" },
};

const AGENT_NOTES = {
  penguin: "本地 HTTP API · 网页端的运行也会实时同步",
  codex: "命令行续跑（codex exec resume）",
  claude: "命令行续跑（claude -p --resume）",
  grok: "命令行续跑（grok --resume）",
  dsh: "命令行续跑（dsh headless）",
  pi: "命令行续跑（pi --session）",
  hermes: "Hermes Studio 的 agent bridge",
  grokbot: "智能体运行在云端，本机没有可调用的接口",
};

const CAPS = [
  ["mirrorsOwnSide", "双向实时"],
  ["steer", "运行中插话"],
  ["approvals", "远程审批"],
  ["abort", "可中断"],
  ["create", "可新建"],
];

function logo(id, size = "") {
  const l = LOGOS[id];
  if (!l) return `<span class="logo ${size}"></span>`;
  const style = l.bleed ? ' style="background:none"' : "";
  const imgStyle = l.bleed ? ' style="width:100%;height:100%"' : "";
  return `<span class="logo ${size}"${style}><img src="${l.src}" alt=""${imgStyle} class="${l.mono ? "mono" : ""}"></span>`;
}

async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-AP-Admin": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("show"), 2200);
}

function switchEl(on, attrs = "") {
  return `<button class="switch" role="switch" aria-checked="${on ? "true" : "false"}" ${attrs}></button>`;
}

function ago(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const m = Math.round((Date.now() - d.getTime()) / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

let data = null;
let view = ["overview", "channels", "agents", "sessions", "settings"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "overview";
let restartPending = false;

const VIEWS = {
  overview: { title: "概览", render: renderOverview },
  channels: { title: "渠道", render: renderChannels },
  agents: { title: "Agent", render: renderAgents },
  sessions: { title: "会话", render: renderSessions },
  settings: { title: "设置", render: renderSettings },
};

function restartBanner() {
  return restartPending
    ? `<div class="banner"><span>改动需要重启引擎才生效。</span><button class="btn" data-act="restart">立即重启</button></div>`
    : "";
}

function renderOverview() {
  const ch = data.channels.find((c) => c.id === "feishu");
  const usable = data.agents.filter((a) => a.ok);
  const running = data.bindings.filter((b) => b.running).length;
  return `
    ${restartBanner()}
    <div class="hero">
      <div class="stat"><b>${data.bindings.length}</b><span>已接入会话</span></div>
      <div class="stat"><b>${usable.length}<span style="font-size:14px;color:var(--muted)"> / ${data.agents.length}</span></b><span>可用 Agent</span></div>
      <div class="stat"><b>${running}</b><span>正在运行</span></div>
    </div>
    <div class="section">
      <h2>工作方式</h2>
      <div class="flow">
        <div class="col">
          <div class="logos">${data.channels.map((c) => logo(c.id)).join("")}</div>
          <div class="hint">消息渠道</div>
        </div>
        <div class="arrow">⇄</div>
        <div class="col mid"><b>Agent 信鸽</b><div class="hint">${ch?.perSession ? "一个会话一个话题" : "所有会话进同一个对话"}</div></div>
        <div class="arrow">⇄</div>
        <div class="col">
          <div class="logos">${data.agents.filter((a) => a.id !== "grokbot").map((a) => logo(a.id)).join("")}</div>
          <div class="hint">本机 Agent</div>
        </div>
      </div>
    </div>
    <div class="section">
      <h2>怎么接入</h2>
      <div class="list">
        <div class="row"><div class="who"><div class="name">在任意 Agent 里说「把这个对话接入飞书」</div><div class="sub">需先在「Agent」页给它装上 Skill；话题标题形如 [Codex] 会话标题</div></div></div>
        <div class="row"><div class="who"><div class="name">在飞书里给机器人发 <span class="mono">/ht@codex〈标题〉</span></div><div class="sub">新建会话；<span class="mono">/ht@claude 最近</span> 接入已有会话，<span class="mono">/ht-help</span> 看全部指令</div></div></div>
      </div>
    </div>
    ${data.bindings.length ? `<div class="section"><h2>最近接入</h2><div class="list">${data.bindings.slice(0, 5).map(bindingRow).join("")}</div></div>` : ""}
  `;
}

function renderChannels() {
  const rows = data.channels
    .map((c) => {
      if (!c.implemented) {
        return `<div class="row dim">${logo(c.id)}<div class="who"><div class="name"><span>${esc(c.label)}</span></div><div class="sub">即将支持</div></div><div class="end"><span class="tag">即将支持</span></div></div>`;
      }
      const st = c.status ?? {};
      const state = !c.enabled ? `<span class="tag">已关闭</span>` : st.ok ? `<span class="tag ok">已连接</span>` : `<span class="tag bad">异常</span>`;
      return `
        <div class="row">${logo(c.id)}
          <div class="who"><div class="name"><span>${esc(c.label)}</span>${state}</div><div class="sub">${esc(st.ok ? st.detail ?? "" : st.reason ?? "")}</div></div>
          <div class="end">${switchEl(c.enabled, `data-ch-enabled="${c.id}" aria-label="启用${esc(c.label)}"`)}</div>
        </div>
        ${
          c.enabled
            ? `<div class="row"><span class="logo" style="background:none"></span>
                <div class="who"><div class="name"><span>按会话隔离</span></div><div class="sub">${c.perSession ? "开：每个会话一个飞书话题，标题带 Agent 来源" : "关：所有会话进同一个对话，消息带会话名；回复哪条就发给哪个会话，或用 /ht-use 切换"}</div></div>
                <div class="end">${switchEl(c.perSession, `data-ch-iso="${c.id}" aria-label="按会话隔离"`)}</div>
              </div>`
            : ""
        }`;
    })
    .join("");
  return `
    ${restartBanner()}
    <div class="section"><div class="list">${rows}</div>
    <p class="hint">流式过程卡、工具审批卡、收发图片与文件、结论卡是每个渠道的基础能力，不需要开关。切换隔离方式只影响之后新开的会话。</p></div>`;
}

function renderAgents() {
  const rows = data.agents
    .map((a) => {
      const caps = CAPS.filter(([k]) => a.capabilities?.[k]).map(([, l]) => `<span class="tag">${l}</span>`).join("");
      const state = !a.enabled ? `<span class="tag">已关闭</span>` : a.ok ? `<span class="tag ok">可用</span>` : `<span class="tag warn">不可用</span>`;
      const sub = a.ok ? AGENT_NOTES[a.id] ?? "" : a.reason ?? AGENT_NOTES[a.id] ?? "";
      const skill = a.skill?.installable
        ? a.skill.installed
          ? `<button class="btn ghost" data-skill-un="${a.id}" title="卸载 Skill">已装 Skill</button>`
          : `<button class="btn" data-skill="${a.id}">安装 Skill</button>`
        : "";
      const supported = a.id !== "grokbot";
      return `
        <div class="row ${a.enabled ? "" : "dim"}">${logo(a.id, "lg")}
          <div class="who">
            <div class="name"><span>${esc(a.label)}</span>${state}${a.bindings ? `<span class="tag accent">${a.bindings} 个会话</span>` : ""}</div>
            <div class="sub">${esc(sub)}</div>
            ${caps && a.enabled ? `<div class="caps">${caps}</div>` : ""}
          </div>
          <div class="end">${a.enabled && supported ? skill : ""}${supported ? switchEl(a.enabled, `data-agent="${a.id}" aria-label="启用${esc(a.label)}"`) : ""}</div>
        </div>`;
    })
    .join("");
  const def = data.agents.filter((a) => a.enabled && a.id !== "grokbot");
  return `
    ${restartBanner()}
    <div class="section"><div class="list">${rows}</div>
      <p class="hint">Skill 装进对应 Agent 的 skills 目录后，在那个 Agent 里说「把这个对话接入飞书」即可一行命令接入。命令行类 Agent 只同步从渠道发起的轮次。</p>
    </div>
    <div class="section"><h2>默认 Agent</h2>
      <div class="list"><div class="row"><div class="who"><div class="name"><span>在飞书里发 /ht 新建会话时使用</span></div></div>
        <div class="end"><select class="btn" id="defaultAgent">${def.map((a) => `<option value="${a.id}" ${a.id === data.defaultAgent ? "selected" : ""}>${esc(a.label)}</option>`).join("")}</select></div>
      </div></div>
    </div>`;
}

function bindingRow(b) {
  return `
    <div class="row">${logo(b.agent)}
      <div class="who">
        <div class="name"><span>${esc(b.display)}</span>${b.running ? `<span class="dot-run" title="运行中"></span>` : ""}</div>
        <div class="sub"><span class="mono">${esc(b.sessionId ?? "首条消息后生成")}</span>${b.cwd ? ` · ${esc(b.cwd.replace(/^\/Users\/[^/]+/, "~"))}` : ""}</div>
      </div>
      <div class="end"><span class="hint">${ago(b.createdAt)}</span><button class="btn ghost danger" data-close="${esc(b.id)}">下线</button></div>
    </div>`;
}

function renderSessions() {
  if (data.bindings.length === 0) {
    return `<div class="list"><div class="empty"><b>还没有接入的会话</b>在任一 Agent 里说「把这个对话接入飞书」，或在飞书里给机器人发 /ht。</div></div>`;
  }
  return `<div class="section"><div class="list">${data.bindings.map(bindingRow).join("")}</div>
    <p class="hint">下线后渠道里会留一条说明，原 Agent 会话不受影响；在那个话题里再发消息会新建一个会话。</p></div>`;
}

function renderSettings() {
  return `
    ${restartBanner()}
    <div class="section"><h2>通用</h2><div class="list">
      <div class="row"><div class="who"><div class="name"><span>登录时启动</span></div><div class="sub">开机后在菜单栏常驻，飞书消息随时能送到 Agent</div></div>
        <div class="end">${native ? switchEl(window.AP_NATIVE?.loginItem === true, 'data-native="loginItem"') : `<span class="hint">仅 App 内可用</span>`}</div></div>
      <div class="row"><div class="who"><div class="name"><span>暂停转发</span></div><div class="sub">暂停期间渠道消息不送进会话，指令仍可用</div></div>
        <div class="end">${switchEl(data.paused, 'data-pause="1"')}</div></div>
    </div></div>
    <div class="section"><h2>引擎</h2><div class="list">
      <div class="row"><div class="who"><div class="name"><span>版本</span></div><div class="sub">v${esc(data.version)} · 启动于 ${esc(new Date(data.startedAt).toLocaleString())}</div></div>
        <div class="end"><button class="btn" data-act="restart">重启引擎</button></div></div>
      <div class="row"><div class="who"><div class="name"><span>数据目录</span></div><div class="sub mono">${esc(data.dataDir)}</div></div>
        <div class="end">${native ? `<button class="btn" data-native-open="data">在访达中显示</button>` : ""}</div></div>
    </div></div>
    <div class="section"><h2>日志</h2><div class="list"><div class="log" id="log">加载中…</div></div></div>`;
}

async function loadLogs() {
  const el = $("#log");
  if (!el) return;
  try {
    const { lines } = await api("GET", "/logs");
    el.textContent = lines.slice(-80).join("\n") || "（暂无）";
    el.scrollTop = el.scrollHeight;
  } catch (err) {
    el.textContent = err.message;
  }
}

function render() {
  for (const b of document.querySelectorAll("[data-view]")) b.classList.toggle("on", b.dataset.view === view);
  $("#title").textContent = VIEWS[view].title;
  $("#page").innerHTML = VIEWS[view].render();
  const p = $("#pauseBtn");
  p.hidden = false;
  p.textContent = data.paused ? "恢复转发" : "暂停转发";
  if (view === "settings") void loadLogs();
}

function setEngine(state, text) {
  const e = $("#engine");
  e.className = `engine ${state}`;
  e.querySelector("span").textContent = text;
}

async function load() {
  try {
    data = await api("GET", "/overview");
    setEngine(data.paused ? "paused" : "ok", data.paused ? "转发已暂停" : `引擎运行中 · v${data.version}`);
    render();
  } catch {
    setEngine("down", "引擎未运行");
  }
}

async function settings(patch) {
  const r = await api("POST", "/settings", patch);
  if (r.restart) restartPending = true;
  await load();
}

document.addEventListener("click", async (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  try {
    if (t.dataset.view) {
      view = t.dataset.view;
      render();
    } else if (t.dataset.chEnabled) {
      await settings({ channel: { id: t.dataset.chEnabled, enabled: t.getAttribute("aria-checked") !== "true" } });
    } else if (t.dataset.chIso) {
      await settings({ channel: { id: t.dataset.chIso, perSession: t.getAttribute("aria-checked") !== "true" } });
      toast("已保存，之后新开的会话按新方式隔离");
    } else if (t.dataset.agent) {
      await settings({ agent: { id: t.dataset.agent, enabled: t.getAttribute("aria-checked") !== "true" } });
    } else if (t.dataset.skill) {
      const r = await api("POST", "/skills/install", { agent: t.dataset.skill });
      toast(r.result.some((x) => x.ok) ? "已安装 Skill" : "安装失败");
      await load();
    } else if (t.dataset.skillUn) {
      if (!confirm("卸载这个 Agent 里的「接入飞书」Skill？")) return;
      await api("POST", "/skills/uninstall", { agent: t.dataset.skillUn });
      toast("已卸载");
      await load();
    } else if (t.dataset.close) {
      const b = data.bindings.find((x) => x.id === t.dataset.close);
      if (!confirm(`下线「${b?.display ?? "会话"}」？渠道里会留一条说明，原会话不受影响。`)) return;
      await api("POST", "/close", { bindingId: t.dataset.close });
      toast("已下线");
      await load();
    } else if (t.dataset.pause || t.id === "pauseBtn") {
      await api("POST", data.paused ? "/resume" : "/pause");
      await load();
    } else if (t.dataset.act === "restart") {
      await api("POST", "/restart");
      restartPending = false;
      setEngine("down", "正在重启…");
      toast("正在重启引擎…");
      setTimeout(load, 2500);
      setTimeout(load, 5000);
    } else if (t.dataset.native) {
      native?.postMessage({ action: t.dataset.native, value: t.getAttribute("aria-checked") !== "true" });
    } else if (t.dataset.nativeOpen) {
      native?.postMessage({ action: "reveal", value: t.dataset.nativeOpen });
    }
  } catch (err) {
    toast(`失败：${err.message}`);
  }
});

document.addEventListener("change", async (e) => {
  if (e.target.id === "defaultAgent") {
    await settings({ defaultAgent: e.target.value });
    toast("已设为默认 Agent");
  }
});

// Drag regions move the window in the app (WKWebView keeps mouse events from the window).
document.addEventListener("mousedown", (e) => {
  if (!native || e.button !== 0 || e.detail > 1) return;
  const zone = e.target.closest("[data-drag]");
  if (!zone || e.target.closest("button, a, input, select, textarea")) return;
  native.postMessage({ action: "drag" });
});

// The native shell calls this after it changed something it owns (login item).
window.apNativeChanged = (state) => {
  window.AP_NATIVE = { ...(window.AP_NATIVE ?? {}), ...state };
  if (data) render();
};

void load();
setInterval(() => {
  if (!document.hidden) void load();
}, 5000);

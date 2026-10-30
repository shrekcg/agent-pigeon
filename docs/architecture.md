# 技术架构

本文是总览。各子系统的契约和细节见 [subsystems/](subsystems/README.md)，关键设计的取舍见 [decisions/](decisions/README.md)。

## 分层

```
┌──────────────────────── Mac App（app/macos） ────────────────────────┐
│  菜单栏 · 窗口（WKWebView 显示 app/web） · 登录项 · 托管引擎子进程        │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ 127.0.0.1:47821（界面 + /api）
┌──────────────────────── 引擎（src/，Bun 编译成单个二进制） ─────────────┐
│  渠道  src/channels    飞书（长连接 + REST + CardKit）· 钉钉/QQ/微信占位  │
│           ↕ inbound / view                                           │
│  中枢  src/hub         绑定 · 路由 · /ht 指令 · 去重 · 巡检             │
│           ↕ link.emit(运行事件) / send · abort · decide               │
│  Agent src/agents      Penguin(HTTP+SSE) · Claude/Codex/Grok/DSH/Pi    │
│                        （无界面续跑 + JSON 流）· Hermes(Unix socket)    │
│  API   src/api         控制台和 ht 命令背后的本地接口                  │
│  Skill src/skills      把 feishu-topic 装进各 Agent                   │
└──────────────────────────────────────────────────────────────────────┘
数据：~/Library/Application Support/AgentPigeon（config、state、logs、inbox、workspaces）
```

## 核心概念

| 概念 | 含义 | 详见 |
| --- | --- | --- |
| 绑定 binding | 渠道里的一个位置（话题或名片）和某个 Agent 的一个会话 | [hub.md](subsystems/hub.md) |
| 运行事件 | Agent 适配器和渠道视图之间唯一的契约：`run_start … run_end` 等 15 种 | [agents.md](subsystems/agents.md) |
| link | 适配器手里的那个绑定对象，会话 ID 回写后适配器能看到 | [agents.md](subsystems/agents.md) |
| 视图 view | 渠道为每个绑定建的渲染器：过程卡、结论卡、回传文件 | [feishu-cards.md](subsystems/feishu-cards.md) |
| 隔离方式 | `thread`（一个会话一个话题）或 `shared`（所有会话进同一个对话） | [feishu-channel.md](subsystems/feishu-channel.md) |

## 两条主路径

**渠道到 Agent**（用户在话题里发一条消息）：

```
飞书 im.message.receive_v1 → FeishuChannel#onMessage（过滤 chat、附件落盘）
→ Hub.inbound（去重 → 指令？→ resolveBinding → 停止意图 / 插话或排队）
→ adapter.send(link, parts, { mode })
```

**Agent 到渠道**（会话在跑）：

```
适配器（SSE 帧 / 子进程 stdout 每一行 / bridge 轮询）→ link.emit(运行事件)
→ Hub#onAgentEvent（回写会话 ID、跟随标题、过滤回显）
→ FeishuView.onEvent（run_start 建卡 → 逐字推送 → run_end 等静默后收尾 → 结论卡 → 回传文件）
```

## 进程与生命周期

- 外壳启动引擎（`agent-pigeon-engine serve`）。引擎拿 pid 锁，从旧版目录迁移数据，读配置，建 Agent 和渠道，起本地 API，再恢复所有绑定。
- 引擎退出码 75 表示请求重启。崩溃后外壳会退避重启，一分钟内超过 5 次就停止。
- 引擎收到 SIGTERM，或者 App 退出导致 stdin 关闭时，会先把所有运行中的卡片收尾成静态卡再退出。

## 代码规模（v0.3.0）

约 7600 行，大头是这几块：

| 部分 | 行数 |
| --- | --- |
| 飞书渠道 | 约 2000 |
| Agent 适配器 | 约 1500 |
| 中枢 | 约 650 |
| 外壳 Swift | 约 400 |
| 控制台界面 | 约 600 |
| 测试 | 约 500，共 31 个用例 |

## 安全边界

见 [SECURITY.md](../SECURITY.md)：

- 只处理配置里那一个对话的消息；
- 本地 API 只监听 127.0.0.1，写操作要带自定义请求头；
- 凭据只从配置文件或 PenguinHarness 数据库里读，不写到别处；
- Agent 默认无人值守运行，可以按 Agent 收紧权限。

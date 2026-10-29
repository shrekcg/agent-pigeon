# 架构说明

本文写给想读代码、加 Agent 或加渠道的人。怎么用见仓库根目录的 README。

## 分层

```
渠道（src/channels）  飞书已实现；钉钉、QQ、微信在规划中
      ↕  inbound(消息) / view(渲染一个绑定的事件)
中枢（src/hub）       绑定 = 渠道里的一个位置 ↔ 某个 Agent 的一个会话；路由、/ht 指令、去重、巡检
      ↕  link.emit(运行事件) / send · abort · decide
Agent（src/agents）   Penguin · Codex · Claude · Grok · DeepSeek · Pi · Hermes
```

**绑定**（binding）是核心概念，结构为 `{ id, channel, agent, sessionId, cwd, title, address }`：

- `address` 由渠道自己定义。飞书话题模式是 `{ threadId, rootMessageId }`，共享模式是 `{ anchorMessageId, shared: true }`。
- `sessionId` 在命令行类 Agent 跑完第一轮之前是 `null`，由 Agent 输出里带回的 id 回写。

**运行事件**是 Agent 适配器和渠道之间唯一的契约：

```
run_start · thinking · text_start · text_delta · tool_call · tool_result · message
failure · stopped · run_end · session_id · title · approval · queued · user_text
```

完整说明见 `src/agents/base.js` 的头注释。

## Mac App

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 外壳 | `app/macos` | Swift 写的菜单栏 App（`LSUIElement`）。托管引擎子进程，崩溃后退避重启，退出码 75 表示「请求重启」。用 WKWebView 加载界面，用 SMAppService 管理登录项。 |
| 引擎 | `src/main.js` | 用 `bun build --compile` 编成单个二进制 `Contents/MacOS/agent-pigeon-engine`。子命令 `serve` 运行引擎，`ht …` 是给 Skill 调用的控制命令。 |
| 界面 | `app/web` | 纯 HTML/CSS/JS，由引擎在 `127.0.0.1:47821` 提供；写操作必须带 `X-AP-Admin: 1` 请求头。 |
| 数据 | `~/Library/Application Support/AgentPigeon` | `config.json`、`state.json`、`logs/`、`inbox/`（渠道收到的附件）、`workspaces/<agent>`（从渠道新建的会话默认在这里运行）。 |

打包脚本 `scripts/build-app.sh` 生成 `.app` 和 DMG。`scripts/bundle-engine.mjs` 负责改写依赖里的 `__dirname`：bundler 默认把它写死成构建机上的绝对路径，引擎运行时会去读那个路径，可能触发 macOS 的文件夹访问授权，导致进程卡在启动阶段。

## 各 Agent 的接入方式

| Agent | 调用方式 | 会话 ID 环境变量 | 会话列表来源 |
| --- | --- | --- | --- |
| PenguinHarness | 本地 HTTP API + SSE 镜像（`server.lock` + `api-token`） | `PENGUIN_SESSION_ID` | API |
| Codex | `codex exec [resume <id>] --json -`（提示词走 stdin） | `CODEX_THREAD_ID` | `~/.codex/state_*.sqlite` 的 `threads` 表 |
| Claude Code | `claude -p --resume <id> --output-format stream-json --verbose --include-partial-messages` | `CLAUDE_CODE_SESSION_ID` | `~/.claude/projects/*/<id>.jsonl` |
| Grok | `grok --prompt-file /dev/stdin --resume <id> --output-format streaming-json` | `GROK_SESSION_ID` | `~/.grok/sessions/*/<id>/summary.json` |
| DeepSeek Harness | `dsh --profile headless --json [--session-id <id>] -`（在会话的 cwd 下运行） | `DSH_SESSION_ID` | `~/.dsh/session-flow/index-*.json` 和 `storages/session_projcache` |
| Pi | `pi -p --mode json --session <id> -- [@图片] 提示词`（在会话的 cwd 下运行） | `PI_SESSION_ID` | `~/.pi/agent/sessions/*/*.jsonl` |
| Hermes | Hermes Studio 的 agent bridge（`/tmp/hermes-agent-bridge.sock`：`chat` + 轮询 `get_output`） | 无（Skill 用 `latest`） | `~/.hermes/state.db` |

命令行类 Agent 共享 `src/agents/cli.js`：

- 每轮起一个子进程，进程启动发 `run_start`，退出发 `run_end`。
- 运行中收到的消息排队，等本轮结束后作为下一轮发出；「停」会结束整个进程组。
- 子进程只继承一个干净的环境，不带中继自己的会话变量。否则嵌套运行的 Claude Code 会被拒绝登录。
- 默认无人值守：Codex 跳过审批和沙箱，Claude 用 `bypassPermissions`，Grok 用 `--always-approve`。可在 `config.json` 的 `agents.<id>` 里修改。

**加一个 Agent**：
1. 写一个适配器，继承 `AgentAdapter` 或 `CliAdapter`，实现 `listSessions / getSession / buildRun / parseLine`。
2. 在 `src/agents/index.js` 登记。
3. 在 `src/skills/install.js` 里写上它的 skills 目录和会话 ID 变量。

## 渠道与隔离

| 隔离方式 | 行为 | 路由 |
| --- | --- | --- |
| `thread`（按会话隔离，默认） | 每个会话一个飞书话题，名片首行是 `[Agent] 标题` | 话题的 thread_id |
| `shared` | 所有会话进机器人单聊；每条输出带 `【[Agent] 标题】` 前缀，结论卡带会话名表头 | 优先看引用的是哪个会话的消息；没有引用就发给当前会话（`/ht-use` 切换，新开的会话自动成为当前会话） |

流式过程卡、工具审批卡、收发图片和文件、结论卡是每个渠道的基础能力，不设开关。

**加一个渠道**：在 `src/channels/<id>/` 下实现 `Channel` 契约（`start / open / createView / resolveBinding / reply / refresh / closed / ask`），在 `src/channels/index.js` 里给它的 `make` 赋值即可。

## Skill

模板在 `skill/feishu-topic/SKILL.md`。安装时按 Agent 填入 `--agent` 和会话 ID 变量，写进各 Agent 自己的 skills 目录：

- Claude Code：`~/.claude/skills`
- Codex：`~/.codex/skills`
- Grok：`~/.grok/skills`
- DeepSeek Harness：`~/.dsh/skills`
- Pi：`~/.pi/agent/skills`
- Hermes：`~/.hermes/skills`
- PenguinHarness：每个 agent 的 `agent_state/skills`

安装时如果目标位置已有手写的同名 Skill，先备份成 `SKILL.md.bak-before-bridge`。卸载只删带安装标记的文件。App 升级后，引擎启动时会自动更新已安装的副本。

## 状态与迁移

`state.json` 包含 `bindings / active / seen / sentTexts / openCards`。`src/core/paths.js` 的 `migrateLegacyHome()` 负责数据迁移：首次启动时，如果数据目录还不存在，就从旧版数据目录迁入配置和绑定，`src/core/store.js` 再把 v1 的状态格式升级成 v2。

## 开发

```bash
npm ci
npm test          # 适配器解析、状态迁移、指令解析、中枢路由、运行边界
npm run dev       # 用 ./.dev-data 作为数据目录启动引擎，浏览器打开 http://127.0.0.1:47821/
```

不接飞书也能自测：调用 `POST /api/_debug/event`（带 `X-AP-Admin: 1`）可以合成一条飞书消息。`tools/topicdump.js <thread_id>` 能读出飞书话题里实际显示的内容。

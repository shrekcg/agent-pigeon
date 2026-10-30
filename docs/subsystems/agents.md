# Agent 适配器

源码：`src/agents/base.js`（契约）、`src/agents/cli.js`（命令行类 Agent 的公共实现）、每个 Agent 一个文件、`src/agents/index.js`（注册表）。

## 契约

适配器只做两件事：把 Agent 的原生协议翻译成统一的**运行事件**，再接收中枢下发的 `send / abort / decide`。适配器不知道渠道是什么。

一个绑定在适配器那里叫 **link**，结构是 `{ bindingId, agent, sessionId, cwd, title, emit }`。中枢每次都交给适配器**同一个 link 对象**，所以会话 ID 回写之后，适配器随时读到的都是最新值。

| 方法 | 作用 |
| --- | --- |
| `available()` | 返回 `{ ok, reason? }`，给控制台和 `/ht-agents` 用 |
| `listSessions({ includeArchived, limit })`、`getSession(id)` | 会话记录 `{ sessionId, title, cwd, model, updatedAt, archived }` |
| `createSession({ cwd, title })` | 新建会话。命令行类 Agent 返回 `sessionId: null`，第一轮跑完再回写 |
| `attach(link)` | 有实时流的 Agent 在这里开始镜像，返回一个停止函数 |
| `send(link, parts, { mode })` | `parts` 是文本、图片路径、文件路径；`mode` 为 `steer` 或 `queue`；返回 `{ steered?, queued?, ahead? }` |
| `abort(link)`、`decide(link, toolCallId, decision)` | 停止当前运行、审批 |
| `capabilities` | `create / steer / abort / approvals / sweep / mirrorsOwnSide`，控制台据此显示能力标签 |

运行事件：

```
run_start  thinking  text_start  text_delta  tool_call  tool_result  message
failure    stopped   run_end     session_id  title      approval     queued  user_text
```

## 命令行类 Agent（`cli.js`）

Claude Code、Codex、Grok、DeepSeek、Pi 都是这一类。

- **一轮一个进程**：`buildRun(link, prompt)` 返回参数和 stdin；子进程启动发 `run_start`，退出发 `run_end`；stdout 按行交给 `parseLine` 解析成运行事件。
- **只按 `\n` 切分输出**：Pi 的文档特别提醒，不要用 Node 的 readline，它也会在 U+2028 处切开。
- **干净环境**：子进程只继承 HOME、USER、SHELL、LANG、TMPDIR 等少数变量，PATH 用固定的安全列表。原因是中继自己可能跑在某个 Agent 的会话里（例如开发时），子进程继承了 `CLAUDECODE`、`CLAUDE_CODE_*` 这些变量后，Claude Code 会被拒绝登录，返回「Not logged in」。
- **排队**：运行中再收到消息就放进队列，等本轮结束后用同一个 link 发出下一轮，此时会话 ID 已经回写。
- **停止**：用 `detached: true` 启动子进程，停止时对整个进程组发 SIGTERM，4 秒后发 SIGKILL。
- **超时**：默认 60 分钟，`agents.<id>.runTimeoutMinutes` 可以改。
- **工作目录**：
  - 会话记录的目录还在，就用它；
  - 否则用 `agents.<id>.workspace`；
  - 再否则用 `数据目录/workspaces/<agent>`。
  - **会话目录不存在时绝不去创建**：项目文件夹改名后，原位置不能长出一个空文件夹。续跑按会话 ID 查找会话，不依赖目录（Claude Code 已实测）。
- **只同步渠道发起的轮次**：命令行没有可订阅的流，用户在 Agent 自己窗口里打的字，信鸽看不到。

## 各 Agent 的要点

| Agent | 调用 | 输出 | 会话 ID 变量 | 会话列表 |
| --- | --- | --- | --- | --- |
| Claude Code | `claude -p --resume <id> --output-format stream-json --verbose --include-partial-messages --permission-mode <m>`，提示词走 stdin | `system/init`、`stream_event`（content_block_*）、`assistant`、`user`（tool_result）、`result` | `CLAUDE_CODE_SESSION_ID` | `~/.claude/projects/*/<id>.jsonl`，标题取 `custom-title` |
| Codex | `codex exec [resume <id>] --json --skip-git-repo-check [--dangerously-bypass-approvals-and-sandbox] -` | `thread.started`、`item.started` / `item.completed`（agent_message、reasoning、command_execution…）、`turn.failed` | `CODEX_THREAD_ID` | `~/.codex/state_*.sqlite` 的 `threads` 表（只读打开） |
| Grok | `grok --prompt-file /dev/stdin --resume <id> --cwd <dir> --output-format streaming-json --always-approve` | `text{data}`（逐字，没有消息边界）、`thought`、`tool_call`、`tool_call_update`、`end{sessionId}` | `GROK_SESSION_ID` | `~/.grok/sessions/<cwd>/<id>/summary.json` |
| DeepSeek Harness | `dsh --profile headless --json [--session-id <id>] -`，在会话目录下运行 | `session`、`status`、`thinking`、`text`（按步骤提交）、`tool_call`、`tool_result`、`final` | `DSH_SESSION_ID` | `~/.dsh/session-flow/index-*.json` 加 `storages/session_projcache`（headless 会话只出现在后者） |
| Pi | `pi -p --mode json --session <id> -- [@图片…] 提示词`，在会话目录下运行 | 首行是会话头，之后是 `message_update`（text_delta…）、`message_end`、`tool_execution_*` | `PI_SESSION_ID` | `~/.pi/agent/sessions/*/*.jsonl` |

两点要注意：
- **Grok** 的文字没有消息边界，适配器在遇到工具调用或 `end` 时把累积的文字收成一条 `message`。
- **Claude Code** 的 `model: "<synthetic>"` 消息是命令行自己发出的提示（比如没登录），要当失败处理，不能当回答。

## 有本地服务的 Agent

- **PenguinHarness**（`penguin.js`）：
  - 端口取自 `~/.penguin/data/server.lock`，token 取自 `api-token`，地址必须写 `http://localhost:<port>`。新版会拒绝 `127.0.0.1`，返回 401。
  - 输入走 `POST /api/sessions/:id/tasks`（`queueIfBusy`）或 `/steer`，输出用 `GET /api/sessions/:id/stream`（SSE）镜像。所以 Penguin 网页端里发起的轮次也会同步到渠道。
  - 用户消息先过 `sanitizeMirroredUserText`，去掉 harness 自己加的 `[tag]…[/tag]` 包装。
- **Hermes**（`hermes.js`）：
  - 走 Hermes Studio 的 agent bridge：Unix socket `/tmp/hermes-agent-bridge.sock`，一行 JSON 请求换一行 JSON 回复。
  - 流程是 `chat` 拿到 run_id，然后轮询 `get_output`，支持 `steer`、`interrupt`、`approval_respond`。
  - Studio 没开时 bridge 不存在，`available()` 会返回不可用。
- **GrokBot**：Cursor 的「Sand」应用，智能体跑在远端网关，本机没有 API，只登记为不可用。

## 加一个 Agent

1. 新建 `src/agents/<id>.js`：命令行类继承 `CliAdapter`，实现 `listSessions`、`getSession`、`buildRun`、`parseLine`；有本地服务的继承 `AgentAdapter`。
2. 在 `src/agents/index.js` 的 `FACTORIES` 里登记，需要的话再在 `ALIASES` 里加上 `/ht@` 的别名。
3. 在 `src/skills/install.js` 的 `SKILL_TARGETS` 里写上 skills 目录和会话 ID 变量。
4. 在 `src/core/format.js`、`agents/base.js` 的 `AGENT_LABELS` 里写上显示名；在 `app/web/icons/` 放真实标志，登记进 `app/web/app.js` 的 `LOGOS`。
5. 用真实命令行录一段输出写进 `test/adapters.test.mjs`。

## 验证

```bash
npm test
```

`test/adapters.test.mjs` 用 2026-10-29 实录的各家输出测解析。

真机冒烟：在控制台「Agent」页看状态。在飞书里 `/ht@<id>〈测试〉` 跑一轮，再发一句让它回忆上一轮的内容，确认续跑的是同一个会话。

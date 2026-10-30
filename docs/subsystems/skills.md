# Skill

源码：`src/skills/install.js`、模板 `skill/feishu-topic/SKILL.md`。

## 作用

每个 Agent 里装一个名为 `feishu-topic` 的 Skill。用户在那个 Agent 里说「把这个对话接入飞书」时，Agent 会执行：

```bash
"<App>/Contents/MacOS/agent-pigeon-engine" ht open --agent <id> --session "$<会话ID变量>" --cwd "$PWD" --title "<标题>"
```

渲染模板时填入四样东西：`{{HT}}`（命令前缀）、`{{AGENT}}`、`{{SESSION_EXPR}}`（会话 ID 环境变量），以及 `{{SESSION_NOTE}}`（这个 Agent 的注意事项）。

命令前缀分两种情况：
- 从 App 里运行时，是 App 内二进制的绝对路径加 `ht`；
- 从源码运行时，是 `node <checkout>/src/main.js ht`。

## 安装位置

| Agent | 目录 | 会话 ID |
| --- | --- | --- |
| Claude Code | `~/.claude/skills/feishu-topic/` | `$CLAUDE_CODE_SESSION_ID` |
| Codex | `~/.codex/skills/feishu-topic/` | `$CODEX_THREAD_ID` |
| Grok | `~/.grok/skills/feishu-topic/` | `$GROK_SESSION_ID` |
| DeepSeek Harness | `~/.dsh/skills/feishu-topic/` | `$DSH_SESSION_ID` |
| Pi | `~/.pi/agent/skills/feishu-topic/` | `$PI_SESSION_ID` |
| Hermes | `~/.hermes/skills/feishu-topic/` | `latest`（Hermes 不暴露会话 ID，接入的是最近活跃的会话） |
| PenguinHarness | 每个 agent 的 `agent_state/skills/feishu-topic/` | `$PENGUIN_SESSION_ID` |

会话 ID 变量都在 2026-10-29 实测过：让各个 Agent 自己执行 `env | grep`。

只有某个 Agent 的配置根目录存在，才会往那里装。

## 安装标记、备份与升级

- 装进去的文件在 frontmatter 后面带一行标记：`<!-- installed-by: agent-pigeon -->`。以前版本的标记 `agent-bridge`、`feishu-agent-bridge` 也认作自己装的，`OLD_MARKERS` 里列着。
- 目标位置已经有一个**不是自己装的**同名 Skill 时，先备份成 `SKILL.md.bak-before-bridge`，只备份一次。
- 卸载只删带标记的文件；有备份就还原，没有备份就把空目录也删掉。
- **自动升级**：App 每次启动都会调用 `refreshInstalledSkills()`，把内容和当前模板不一致的副本重写一遍。所以 App 升级或改名后，各 Agent 里的命令路径会自动跟着变。
- 开发模式（设置了 `AP_HOME`，或者不是从 `.app` 里运行）不会改写已安装的 Skill。

## 改模板时要注意

- frontmatter 必须在文件第一行，各家加载器都依赖这一点，标记行只能插在 frontmatter 后面。
- `description` 决定 Agent 什么时候调用这个 Skill。改它会影响各个 Agent 的触发行为。
- 改完重新安装（控制台「Agent」页，或者 `ht skills install`），然后到对应 Agent 里实际说一次「把这个对话接入飞书」验证。

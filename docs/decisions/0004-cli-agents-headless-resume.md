# 0004 命令行类 Agent 用无界面续跑接入

- 状态：已采纳（2026-10-29）

## 背景

Claude Code、Codex、Grok、DeepSeek Harness、Pi 都没有可以订阅的会话流，但它们都支持「以无界面模式续跑某个会话，并输出 JSON 流」。

## 决策

渠道里每来一条消息，就起一个子进程，以无界面模式续跑同一个会话一轮：

- `claude -p --resume`
- `codex exec resume --json`
- `grok --resume --output-format streaming-json`
- `dsh --profile headless --json --session-id`
- `pi -p --mode json --session`

把它的输出解析成运行事件；进程退出就算一轮结束。

## 后果

- **只同步渠道发起的轮次**：用户在 Agent 自己窗口里打的字，信鸽看不到。这一点写进了 Skill 的提示、README 和控制台。
- **不能运行中插话**：这些命令行都不支持，运行中收到的消息排队，到下一轮再发。
- **同一个会话不要两边同时写**，否则两个进程会同时续跑同一个会话。
- **子进程必须用干净的环境启动**，见 [agents.md](../subsystems/agents.md)。
- 以后如果要同步 Agent 自己窗口里的轮次，可以增量读取各家的会话文件（已列进 [status.md](../status.md) 的待办）。

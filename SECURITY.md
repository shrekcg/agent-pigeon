# 安全

Agent 信鸽会让本机 Agent 执行来自飞书的指令。这些 Agent 默认在无人值守模式下运行，可以读写文件、执行命令。

- 只把机器人加到你自己的单聊里。引擎只处理配置里那一个 `chatId` 的消息，其他会话的消息一律忽略。
- 本地 API 只监听 `127.0.0.1`，写操作必须带自定义请求头，浏览器里的网页没法跨站调用。
- 飞书应用凭据默认从 PenguinHarness 的数据库里读取，不会写进日志。
- 每个 Agent 的权限模式可以在 `config.json` 的 `agents.<id>` 里收紧（例如 Codex 设 `"permission": "sandbox"`）。

发现安全问题请不要公开提 Issue，请通过 GitHub 的 [Security Advisories](https://github.com/shrekcg/agent-pigeon/security/advisories/new) 私下报告。

# 配置、数据目录与迁移

源码：`src/core/paths.js`、`src/core/config.js`、`src/core/store.js`。

## 数据目录

默认是 `~/Library/Application Support/AgentPigeon`。可以用环境变量 `AP_HOME` 覆盖，v1 的 `HT_HOME` 也认。

| 文件 | 内容 |
| --- | --- |
| `config.json` | 用户配置（见下文） |
| `state.json` | 绑定和运行状态（见 [hub.md](hub.md)） |
| `ui.port`、`admin.port` | 本地服务端口 |
| `engine.pid` | 防止同时跑两个引擎：两个引擎会同时占用飞书长连接，每条消息都回两遍 |
| `PAUSED` | 文件存在就表示暂停转发 |
| `logs/engine.log` | 引擎日志，启动时超过 5MB 就轮转 |
| `engine.stdout.log` | 外壳收集的引擎标准输出 |
| `inbox/<日期>/` | 渠道收到的附件 |
| `workspaces/<agent>/` | 从渠道新建会话时的默认工作目录 |

## config.json

所有字段都可以不写。

```jsonc
{
  "defaultAgent": "penguin",          // /ht 不带 @agent 时用哪个 Agent
  "uiPort": 47821,
  "channels": {
    "feishu": {
      "enabled": true,
      "isolation": "thread",          // thread（按会话隔离）| shared
      "appId": "cli_xxx", "appSecret": "xxx",   // 不写就从 PenguinHarness 的数据库里读
      "chatId": "oc_xxx",
      "baseDomain": "https://open.feishu.cn",
      "allowedAgents": []             // 空表示放行全部已启用的 Agent
    }
  },
  "agents": {
    "codex":   { "enabled": true, "workspace": "~/…", "permission": "bypass|sandbox", "binary": "/abs/codex", "runTimeoutMinutes": 60 },
    "claude":  { "permissionMode": "bypassPermissions" },
    "grok":    { "permissionMode": "" },  // 空表示 --always-approve
    "penguin": { "projectId": "default_project", "agentId": "default_agent", "workspace": "…" },
    "hermes":  { "socket": "/tmp/hermes-agent-bridge.sock" }
  }
}
```

v1 把 `chatId`、`appId`、`workspace`、`projectId`、`agentId` 写在顶层，现在仍然兼容。

**控制台只改这几个字段**：`enabled`、`isolation`、`defaultAgent`。凭据这类 secret 只能手动编辑文件，`/api/overview` 也不会返回它们。

## 首次启动的迁移（`migrateLegacyHome`）

只要新的数据目录里还没有 `state.json`，就按下面的顺序找旧数据：

1. `~/Library/Application Support/AgentBridge`（v0.3「Agent 桥」）：拷贝 `config.json`、`state.json`、`PAUSED`；**`workspaces/` 用移动而不是拷贝**。因为会话记录里写的就是这个工作目录，拷贝一份会让 Agent 的历史分叉成两份。
2. `~/Library/Application Support/FeishuTopicRelay`（v1 中继）：拷贝配置和状态。

旧目录本身原样保留，作为备份。只有从 `.app` 运行时，才会停用 v1 的 launchd 服务：执行 `bootout`，再把 plist 改名为 `.retired`。

状态格式也要升级：v1 的 `state.json` 是按 threadId 记录的 `maps`，加载时由 `store.js` 的 `migrate()` 转成 v2 的 `bindings`，同时留一份 `state.json.v1-backup`。

## 验证

`test/migrate-home.test.mjs` 在临时 HOME 下跑三种情况：
- 「Agent 桥」的数据优先于 v1；
- 只有 v1 的数据；
- 新目录已经存在时，什么都不动。

`test/adapters.test.mjs` 里有 v1 转 v2 状态格式的测试。

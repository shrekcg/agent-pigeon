# 项目状态

> 更新于 2026-10-30，对应提交 `b19c74d`（v0.3.0，未发布）。每次合并改变下面任何一项的改动，都要同步更新本文。

## 阶段

**开发预览**。代码已推到公开仓库 [shrekcg/agent-pigeon](https://github.com/shrekcg/agent-pigeon)，按维护者要求**还没有发 Release、没有打 tag**。下一步是需求精修，再做第一个公开版本。

## 已经能用的

下表是 2026-10-29 到 2026-10-30 在真实飞书里逐项实测的结果：用户身份往机器人单聊发消息，再读回话题里实际显示的内容。

| 能力 | 状态 | 怎么验证的 |
| --- | --- | --- |
| Mac App 安装、启动、菜单栏、登录项 | 可用 | 从 DMG 安装到 `/Applications`，引擎由外壳拉起，崩溃后自动重启 |
| 窗口拖动（标题区、侧栏顶部、页头） | 已修复，**待用户确认** | `AP_DRAG_SELFTEST=1` 自检：标题区点击落在拖动区上；没有在真实鼠标下验证 |
| 旧版数据迁移（v1 中继、「Agent 桥」） | 可用 | 迁移前后都是 6 个绑定；有单测 `test/migrate-home.test.mjs` |
| 单会话：`/ht@codex` 新建，在话题里对话 | 可用 | Codex 建好会话、写了文件，过程卡和结论卡按顺序出现 |
| 多会话并行：Claude、DeepSeek 两个话题同时跑 | 可用 | 两边各自记住自己的暗号，没有串台 |
| 插话（PenguinHarness） | 可用 | 24 秒的长任务进行中插话，最终总结里回应了插话 |
| 排队（命令行类 Agent，`/pd`） | 可用 | Claude 运行中排队的消息，在上一轮结束后执行，卡片顺序正确 |
| 不隔离模式：回复路由、`/ht-use` | 可用 | 两个会话共用一个对话，回复哪条就发给哪个会话 |
| 从 Agent 侧一句话接入（Skill） | 可用 | Codex 和 Claude 实测：说「把这个对话接入飞书」后，飞书里出现了 `[Codex] …` / `[Claude] …` 话题 |
| 回传文件（含路径带空格、markdown 链接） | 可用 | Codex 产出的 `hello.md` 被识别为本轮文件 |
| 卡片无 emoji，使用飞书官方图标 | 可用 | 图标 token 取自飞书官方图标库 |
| CI（单测 + Swift 外壳编译） | 通过 | GitHub Actions，macOS runner |

## Agent 接入情况（本机，2026-10-30）

| Agent | 状态 | 备注 |
| --- | --- | --- |
| PenguinHarness | 可用 | 唯一一个双向实时同步的 Agent，也支持插话和审批 |
| Claude Code | 可用 | 子进程必须用干净环境启动，否则嵌套运行时会被拒绝登录 |
| Codex | 可用 | |
| Grok | 可用 | |
| DeepSeek Harness | 可用 | headless 模式不逐字推送，文字按步骤提交 |
| Pi | 适配器可用，**本机凭据失效** | Pi 的模型提供方返回 401，需要在 Pi 里重新登录 |
| Hermes | 适配器已写好，**未实测** | 本机 Hermes 的运行时（`~/.hermes/hermes-agent`）已不在磁盘上，要打开 Hermes Studio 重装 |
| GrokBot | 接不了 | 智能体运行在云端，本机没有可调用的接口 |

## 已知问题与限制

- **只有 arm64 构建**。Intel 版用 `ARCH=x64` 理论上能打出来，但没验证过。
- **没有 Developer ID 签名和公证**。别人第一次打开要右键 →「打开」。`scripts/build-app.sh` 已经支持签名和公证，只差证书。
- **命令行类 Agent 只同步渠道发起的轮次**：用户在 Agent 自己窗口里打的字不会出现在飞书。两边同时对同一个会话说话会出问题。
- **飞书凭据没有配置界面**：没装 PenguinHarness 的用户只能手写 `config.json`。
- **钉钉、QQ、微信只是占位**。
- **发生过一次 App 自行退出**：系统日志记为正常退出，原因没查到。之后一直正常。
- **截图只能离屏渲染**：这个环境没有屏幕录制和辅助功能权限，界面验证用离屏 WKWebView 截图，交互验证靠自检。

## 待办（按优先级）

| 优先级 | 事项 |
| --- | --- |
| P0 | 需求精修（维护者下一步要做的） |
| P0 | 用户确认窗口拖动 |
| P1 | 在 App 里配置飞书凭据（appId、appSecret、chatId），引导完成飞书开放平台的设置 |
| P1 | Developer ID 签名、公证，第一个 Release |
| P1 | 实测 Hermes、Pi（运行时和凭据恢复之后） |
| P2 | 命令行类 Agent 也能同步它自己窗口里的轮次（读会话文件增量） |
| P2 | 钉钉渠道 |
| P2 | 自动更新 |
| P3 | QQ、微信渠道；Intel 构建 |

## 本机部署（维护者这台 Mac）

| 项 | 位置 |
| --- | --- |
| 安装的 App | `/Applications/Agent 信鸽.app`（bundle id `io.github.shrekcg.agentpigeon`） |
| 数据目录 | `~/Library/Application Support/AgentPigeon` |
| 旧版数据（只读备份） | `~/Library/Application Support/AgentBridge`、`~/Library/Application Support/FeishuTopicRelay` |
| 旧版 launchd | `~/Library/LaunchAgents/com.wcg.feishu-ht-relay.plist.retired`（已停用） |
| 开发历史（不进仓库） | `~/Library/Application Support/AgentPigeon/dev-history/`：v1 交接文档和旧源码 |
| 本地完整 git 历史 | 本地分支 `local-history`，不推送（早期提交里有本机数据） |
| 当前绑定 | 4 个 Penguin 话题，2 个 Claude 话题（其中一个就是这个项目的开发会话） |

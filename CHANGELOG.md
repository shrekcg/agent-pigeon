# 更新记录

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。还没有正式发布过版本。

## [未发布] 0.3.0

### 新增
- 做成 macOS 菜单栏 App：Swift 外壳、WKWebView 控制台、Bun 编译的单文件引擎；支持登录时启动，引擎崩溃后自动重启。
- 多 Agent 接入：PenguinHarness、Claude Code、Codex、Grok、DeepSeek Harness、Pi、Hermes。
- 渠道层抽象：飞书已实现；钉钉、QQ、微信先占位。
- 「按会话隔离」开关：关闭后所有会话进同一个对话，按引用或 `/ht-use` 决定发给哪个会话。
- 新指令：`/ht@agent`、`/ht-list@agent`、`/ht-agents`、`/ht-use`。
- 给每个 Agent 安装 `feishu-topic` Skill，一句话就能接入当前会话；App 升级后 Skill 自动更新。
- 首次启动自动迁移 v1 中继和「Agent 桥」的数据，并停用 v1 的 launchd 服务。

### 变更
- 改名为 Agent 信鸽 / Agent Pigeon（之前叫「飞书话题中继」「Agent 桥」）。
- 去掉渠道上的七个能力开关，基础能力改为固定行为。
- 卡片和界面不再使用 emoji，改用飞书官方图标和真实品牌标志。

### 修复
- PenguinHarness 一轮之内多次报 `running`，不会再出现多张过程卡。
- 排队的下一轮不再插到上一轮的结论卡前面。
- 回传文件支持 markdown 链接和带空格的路径。
- 窗口可以从标题区域、侧栏顶部、页头拖动。
- 引擎二进制里不再写死构建机路径（之前会卡在 macOS 授权弹窗上）。
- 项目文件夹移动或改名后，续跑不会在原位置重建空目录。

## 0.2（内部版本，2026-10-29）

- 多 Agent 中枢的第一版，配有本地配置页；不对外发布。

## 0.1（内部版本，2026-09-23）

- 飞书话题和 PenguinHarness 会话一一对应的中继，以 launchd 常驻服务运行。

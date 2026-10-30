# 子系统参考

这些页面描述各子系统当前的职责、运行路径、状态和契约。改哪个子系统，就先读哪一页，再顺着页里的源码链接去核对实现。

| 子系统 | 参考页 | 主要源码 |
| --- | --- | --- |
| Agent 适配器：契约、运行事件、命令行类 Agent 的运行方式 | [agents.md](agents.md) | `src/agents/` |
| 中枢：绑定、路由、`/ht` 指令、去重、巡检 | [hub.md](hub.md) | `src/hub/`、`src/core/store.js`、`src/core/commands.js` |
| 飞书渠道：长连接、消息、隔离方式 | [feishu-channel.md](feishu-channel.md) | `src/channels/feishu/index.js`、`inbound.js`、`client.js` |
| 飞书卡片：流式过程卡、结论卡、sequence、超时自愈 | [feishu-cards.md](feishu-cards.md) | `src/channels/feishu/runcard.js`、`view.js`、`cards.js` |
| Mac App 外壳、本地 API、控制台界面 | [app-shell.md](app-shell.md) | `app/macos/`、`src/api/server.js`、`app/web/` |
| Skill 的渲染、安装、升级 | [skills.md](skills.md) | `src/skills/install.js`、`skill/feishu-topic/SKILL.md` |
| 配置、数据目录、状态迁移 | [config-and-state.md](config-and-state.md) | `src/core/config.js`、`paths.js`、`store.js` |

## 维护参考页

改动改变了某个子系统已写明的职责、接口、状态流转、运行路径、兼容规则或失败行为时，在同一个提交里更新它的参考页。只改内部实现、契约不变的重构，不需要改文字。

参考页里链接源码文件和具名符号，不要复制容易变化的实现细节。字段含义和约束这类签名看不出来的东西，要写清楚。

## 评审改动

1. 先确定改动影响了哪个子系统、实际走的是哪条运行路径。
2. 对照改动前后的实现，核对改动说明里声称的前后行为，并追查改动行以外的调用方和状态流转。
3. 检查被改动的契约是否已经在参考页里更新，源码链接是否还有效。
4. 检查引用的测试或运行证据确实覆盖了声称的行为。没跑的检查要写明。

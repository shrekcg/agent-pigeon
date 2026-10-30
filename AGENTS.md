# 写给接手的 Agent

这个仓库是 **Agent 信鸽（Agent Pigeon）**：一个 macOS 菜单栏 App，把本机 AI Agent 的会话接到飞书，一个会话对应一个话题。

## 开工前

1. 读 [docs/status.md](docs/status.md)：现在做到哪了，哪些能用，哪些还在待办。
2. 读 [LESSONS.md](LESSONS.md)：以前踩过的坑，每条后面都有对应的规则。
3. 改哪个子系统，就先读 [docs/subsystems/](docs/subsystems/README.md) 里它那一页，再去核对源码。
4. 想推翻某个设计时，先看 [docs/decisions/](docs/decisions/README.md) 里当初为什么这样定。

## 硬性规则

- **只有维护者明确说了，才发布、打 tag、建 Release、往 GitHub 推送**。
- **不提交本机数据**：个人路径、chat_id、会话 ID、凭据一律不进仓库。文档里用 `oc_xxx`、`~/…` 这种占位写法。提交前跑一遍：`git grep -nE "/Users/|oc_[0-9a-f]{12,}|cli_[0-9a-f]{12,}"`。
- **改了行为就同步文档**：子系统的契约变了，在同一个提交里更新它的参考页；状态变了，更新 `docs/status.md`。
- **状态机的改动要带单测**：运行边界、排队、迁移、路由。
- **改界面或卡片要看实际效果**：界面截图看，卡片在真实飞书里跑一轮，再用 `tools/topicdump.js` 读回来核对，只编译通过不算。
- **同一个飞书应用只能有一个长连接**：开发时先退出已安装的 App，或者在开发数据目录里关掉飞书渠道。
- **不用 emoji**：界面和卡片里的图标用真实品牌标志或飞书官方图标库。

## 常用命令

```bash
npm test                      # 全部单测
npm run dev                   # 开发模式启动引擎（./.dev-data），浏览器打开 http://127.0.0.1:47821/
scripts/build-app.sh          # 打包 .app 和 DMG
"/Applications/Agent 信鸽.app/Contents/MacOS/agent-pigeon-engine" ht status
```

更多说明见 [docs/development.md](docs/development.md)。

## 文档语言

文档和面向用户的文案用中文；代码、注释和变量名用英文。

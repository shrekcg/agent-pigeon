# 参与贡献

欢迎提 Issue 和 Pull Request。

## 开发环境

- macOS 13 及以上（App 外壳只支持 macOS；引擎本身是跨平台的 JavaScript）
- Node.js 22.5 及以上（引擎用到 `node:sqlite`）
- [Bun](https://bun.sh)：用于把引擎编译成单个二进制
- Swift 5.9 及以上：Xcode 或 Command Line Tools

```bash
npm ci
npm test
npm run dev                 # 浏览器打开 http://127.0.0.1:47821/
scripts/build-app.sh        # 生成 dist/Agent 信鸽.app 和 DMG
```

`npm run dev` 用 `./.dev-data` 作为数据目录。这样开发时启动的引擎不会碰到你已安装 App 的数据，也不会接管已安装的 Skill。注意同一个飞书应用同一时间只能有一个长连接：开发时请先退出已安装的 App，或者在 `./.dev-data/config.json` 里把 `channels.feishu.enabled` 设成 `false`。

## 代码结构

见 [docs/architecture.md](docs/architecture.md)。最常见的两类贡献：

- **接入一个新 Agent**：在 `src/agents/` 加一个适配器。命令行类 Agent 继承 `CliAdapter`，只需实现会话列表和输出解析。再在 `src/agents/index.js` 和 `src/skills/install.js` 里各登记一行。用真实 CLI 录一段输出写进 `test/adapters.test.mjs`。
- **接入一个新渠道**：在 `src/channels/<id>/` 实现 `Channel` 契约，在 `src/channels/index.js` 里给它的 `make` 赋值。

## 提交前

- `npm test` 全部通过。
- 改了运行边界或状态机（`run_start` / `run_end`、排队、迁移），要补对应的单测。
- 改了界面或飞书卡片，在 PR 里附截图。
- 不要提交 `config.json`、日志、会话 ID、飞书 chat_id 等本机数据。

## 风格

- 代码、注释、变量名用英文；面向用户的文案用中文。
- 不引入新的运行时依赖，除非确有必要。目前引擎只依赖飞书官方 SDK。
- 界面不用 emoji，图标用真实的品牌标志或飞书官方图标库。

# 开发与运维

## 环境

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| macOS | 13 及以上 | App 外壳（AppKit、WKWebView、SMAppService） |
| Node.js | 22.5 及以上 | 开发时直接运行引擎、跑测试（用到 `node:sqlite`） |
| Bun | 1.4 及以上 | 把引擎编译成单个二进制 |
| Swift | 5.9 及以上 | 编译外壳；Xcode 或 Command Line Tools 都行 |
| rsvg-convert、iconutil | 任意 | 只在重新生成图标时需要 |

## 常用命令

```bash
npm ci                    # 装依赖（只有飞书官方 SDK）
npm test                  # 全部单测，不联网、不碰飞书
npm run dev               # 用 ./.dev-data 作为数据目录启动引擎
scripts/build-app.sh      # 打包 dist/Agent 信鸽.app 和 DMG
```

`npm run dev` 启动后用浏览器打开 <http://127.0.0.1:47821/>。

**同一个飞书应用只能有一个长连接**。开发时要么先退出已安装的 App，要么在 `./.dev-data/config.json` 里写 `{"channels":{"feishu":{"enabled":false}}}`。

开发模式（设置了 `AP_HOME`，或者不是从 `.app` 里运行）不会停用旧版服务，也不会改写各 Agent 里已安装的 Skill。只有装好的 App 会接管这台机器。

## 目录

```
app/
  macos/           Swift 外壳（Package.swift、Info.plist、entitlements）
  web/             控制台界面（index.html、app.js、app.css、icons/）
  assets/          App 图标、菜单栏图标的源文件和导出文件
src/
  main.js          引擎入口：serve / ht / version
  engine.js        装配：配置 → Agent → 渠道 → 中枢 → 本地 API
  agents/          Agent 适配器（base、cli 公共实现、每个 Agent 一个文件）
  channels/        渠道（base 契约、feishu/）
  hub/             中枢：绑定、路由、/ht 指令执行
  api/server.js    本地 HTTP：静态界面 + /api/*
  cli/ht.js        控制命令（Skill 调用它）
  skills/          Skill 的渲染与安装
  core/            配置、状态、路径、日志、指令解析、格式化
skill/feishu-topic/SKILL.md   Skill 模板
scripts/           build-app.sh、bundle-engine.mjs
test/              node:test 单测
tools/topicdump.js 读出飞书话题里实际显示的内容（排障用）
```

## 打包与安装

```bash
scripts/build-app.sh
```

脚本按顺序做这几件事：

1. 用 `bun scripts/bundle-engine.mjs` 把引擎编成 `Contents/MacOS/agent-pigeon-engine`。
2. 用 `swift build -c release` 编译外壳，生成 `Contents/MacOS/AgentPigeon`。
3. 拷贝资源：图标、`web/`、Skill 模板、LICENSE。
4. 签名：默认临时签名；设置了 `SIGN_ID` 就用 Developer ID 签名，并开启 hardened runtime。
5. 生成 DMG；设置了 `NOTARY_PROFILE` 时提交公证并 staple。

本机替换安装：

```bash
osascript -e 'tell application id "io.github.shrekcg.agentpigeon" to quit'
MP=$(hdiutil attach -nobrowse -readonly dist/AgentPigeon-*-arm64.dmg | tail -1 | awk -F'\t' '{print $3}')
ditto "$MP/Agent 信鸽.app" "/Applications/Agent 信鸽.app" && hdiutil detach "$MP"
open "/Applications/Agent 信鸽.app"
```

用 `ditto` 覆盖安装，不要先删掉旧 App 再拷贝：先删会让登录项和 Launch Services 的注册一起丢掉。

## 发布（还没做过，流程备用）

1. 修改 `src/core/version.js` 里的 `VERSION`，在 `CHANGELOG.md` 里写好这个版本的条目。
2. 用 `SIGN_ID=… NOTARY_PROFILE=… scripts/build-app.sh` 打包并公证。
3. `git tag vX.Y.Z && git push --tags`，再用 `gh release create vX.Y.Z dist/AgentPigeon-X.Y.Z-arm64.dmg` 上传 DMG。

维护者说「发布」之前，不要打 tag，也不要建 Release。

## 日常排障

```bash
E="/Applications/Agent 信鸽.app/Contents/MacOS/agent-pigeon-engine"
"$E" ht status            # 引擎、渠道、Agent、绑定数
"$E" ht agents            # 每个 Agent 可不可用、原因
"$E" ht skills status     # Skill 装在哪些 Agent 里
tail -f ~/Library/Application\ Support/AgentPigeon/logs/engine.log
```

| 现象 | 先查 |
| --- | --- |
| 窗口一直显示「正在启动引擎」 | `logs/engine.log` 和 `engine.stdout.log`；引擎有没有卡在 macOS 授权弹窗上（见 [LESSONS.md](../LESSONS.md) 第 1 条） |
| 飞书发消息没反应 | 日志里有没有「飞书长连接启动中」；同一个应用是不是被别处占用（例如 PenguinHarness 的「远程控制」） |
| 某个话题没反应 | `state.json` 里有没有它的绑定；对应 Agent 是否可用（`ht agents`） |
| 卡片报 `300317` / `200850` | 见 [subsystems/feishu-cards.md](subsystems/feishu-cards.md) |
| 命令行类 Agent 报「Not logged in」 | 子进程环境不干净（见 [subsystems/agents.md](subsystems/agents.md)） |

不接飞书也能自测，可以合成一条飞书消息：

```bash
P=$(cat ~/Library/Application\ Support/AgentPigeon/ui.port)
curl -X POST "http://127.0.0.1:$P/api/_debug/event" -H 'Content-Type: application/json' -H 'X-AP-Admin: 1' \
  -d '{"kind":"message","payload":{"sender":{"sender_type":"user"},"message":{"message_id":"om_test1","chat_id":"<chatId>","message_type":"text","content":"{\"text\":\"/ht-agents\"}"}}}'
```

## 改动前后

- 改子系统前，先读它在 [subsystems/](subsystems/README.md) 里的参考页和 [LESSONS.md](../LESSONS.md)。
- 改运行边界、排队、迁移这类状态机，必须补单测。
- 改界面或卡片，要看实际效果：界面用离屏截图，卡片用 `tools/topicdump.js` 读回，不能只看编译结果。
- 一次改完，只重启一次：重启会把正在跑的卡片冻结成「已冻结」静态卡。

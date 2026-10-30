# Mac App 外壳、本地 API 与控制台

源码：`app/macos/Sources/AgentPigeon/main.swift`（外壳）、`src/api/server.js`（本地 HTTP）、`app/web/`（控制台界面）、`scripts/build-app.sh` 和 `scripts/bundle-engine.mjs`（打包）。

## 包结构

```
Agent 信鸽.app/Contents/
  Info.plist                 LSUIElement=true（只有菜单栏），bundle id io.github.shrekcg.agentpigeon
  MacOS/AgentPigeon          Swift 外壳，约 160KB
  MacOS/agent-pigeon-engine  Bun 编译的引擎，约 58MB
  Resources/AppIcon.icns、StatusIcon(@2x).png、web/、skill/SKILL.md、LICENSE
```

## 外壳的职责

- **托管引擎**：
  - 以子进程方式启动 `agent-pigeon-engine serve`；
  - 工作目录固定为数据目录，环境变量里去掉 `PWD`；
  - stdin 用一根管道，App 退出时管道关闭，引擎读到 EOF 就自行退出。
- **重启策略**：
  - 引擎退出码为 75 时，0.3 秒后重启（这是界面请求的重启）；
  - 其他退出码视为崩溃，2 秒后重启；
  - 一分钟内崩溃超过 5 次就停止重试，并在窗口里显示原因。
  - 引擎写出 `ui.port` 才算启动完成，20 秒还没写出就算超时。
- **窗口**：
  - 一个 WKWebView，加载 `http://127.0.0.1:<ui.port>/`；
  - 不是 `127.0.0.1` 的链接一律交给系统浏览器打开；
  - 窗口打开时有 Dock 图标，关闭后回到只有菜单栏的状态。
- **拖动**：
  - WKWebView 会接管它范围内的所有鼠标事件，所以全尺寸内容的窗口原本没有地方可以拖。
  - 标题栏位置盖了一条透明的 `DragStrip`：左边让出 78pt 给红绿灯，右边让出 170pt 给页头按钮，高 28pt。拖动和双击都由它交给窗口处理，双击遵循系统的标题栏双击设置。
  - 页面里标了 `data-drag` 的区域（侧栏顶部、页头）按下鼠标时，会给外壳发 `drag` 消息。
  - 设置 `AP_DRAG_SELFTEST=1` 启动，会打印标题栏位置的命中测试结果。
- **菜单栏**：显示引擎状态，菜单项有「打开 Agent 信鸽」「重启引擎」「退出」。
- **登录项**：
  - 用 `SMAppService.mainApp` 管理，第一次启动时默认打开；
  - 如果是登录时被系统拉起的，就不弹窗口。
- **和页面的通信**：页面通过 `webkit.messageHandlers.ap` 发消息，目前有 `loginItem`、`reveal`、`drag` 三种；外壳调用 `window.apNativeChanged(...)` 通知页面。

## 引擎的编译

- 用 `bun scripts/bundle-engine.mjs` 编译，并关掉 `.env` 和 `bunfig.toml` 的自动加载。
- **必须改写依赖里的 `__dirname` 和 `import.meta.url`**。bundler 默认会把它们写死成构建机上的绝对路径，飞书 SDK 启动时会去读那个路径下的 package.json。如果那个路径在桌面上，macOS 会弹出「访问桌面」的授权请求，引擎就卡在启动阶段。见 [LESSONS.md](../../LESSONS.md) 第 1 条。
- 打完包检查一下：`grep -ac "/Users/" agent-pigeon-engine` 应该是 0。

## 本地 API（`src/api/server.js`）

- 只监听 `127.0.0.1`，优先使用端口 47821，被占用时随机挑一个；端口写进 `ui.port` 和 `admin.port`。
- **端口固定的原因**：页面的来源（origin）不变，浏览器的本地存储才不会丢。
- 写操作必须带 `X-AP-Admin: 1` 请求头（旧的 `X-HT-Admin` 也接受）。跨站页面要带自定义请求头必须先过 CORS 预检，而这个服务从不响应预检，所以浏览器里的网页没法替用户发写请求。
- 不在 `/api/` 下的 GET 请求返回 `web/` 里的静态文件，并做了防路径穿越检查。

| 路由 | 作用 |
| --- | --- |
| `GET /api/overview` | 控制台用到的全部数据：版本、Agent、渠道、绑定、Skill |
| `POST /api/settings` | `{ channel: {id, enabled?, perSession?}, agent: {id, enabled?}, defaultAgent? }`，写入 `config.json`；需要重启时返回 `restart: true` |
| `POST /api/restart` | 引擎以退出码 75 退出，由外壳重新拉起 |
| `GET /api/sessions?agent=` | 某个 Agent 的会话列表，带绑定信息 |
| `POST /api/open`、`/api/close`、`/api/ask` | `ht open`、`ht close`、`ht ask` 背后的接口 |
| `POST /api/pause`、`/api/resume` | 暂停、恢复转发 |
| `POST /api/skills/install`、`/api/skills/uninstall` | 安装、卸载 Skill |
| `GET /api/logs` | 最近 200 行日志 |
| `POST /api/_debug/event` | 合成一条渠道事件，用来自测 |

## 控制台界面（`app/web/`）

- 五个页面：概览、渠道、Agent、会话、设置。URL 里的 `#agents` 这类片段会直接打开对应页面，截图和外链都可以用。
- 设计规范参照 Magpie（MIT）：
  - 背景 `#f4f4f6`，卡片白底，圆角 12px，强调色 indigo `#4f46e5`；
  - 字体用 SF，正文 13px；
  - 支持深色模式；
  - 不用 emoji，标志都是真实图标，来源见 `THIRD_PARTY_NOTICES.md`。
- 每 5 秒刷新一次数据，页面不可见时停止刷新。
- 渠道只有一个开关：「按会话隔离」。基础能力（流式卡、审批、媒体）没有开关。钉钉、QQ、微信只显示「即将支持」。

## 验证

- `swift build -c release --package-path app/macos`（CI 也会跑这一步）。
- 界面：用离屏 WKWebView 截图，或用浏览器打开 `http://127.0.0.1:47821/#<页面>`。
- 安装：用 `codesign --verify --deep --strict` 校验签名，然后打开 App，确认 `ht status` 显示引擎运行中。

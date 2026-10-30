# 0003 Swift 外壳加 WKWebView 加 Bun 引擎，不用 Electron

- 状态：已采纳（2026-10-30）

## 背景

要做成能装到任何一台 Mac 上的 App，最好还能开源发布。参考了 Magpie：它是 Go 写的单个二进制，界面用 Wails 加系统自带的 WebKit，没有带 Chromium，整个 App 61MB。

## 决策

- **外壳**：Swift（AppKit）写的菜单栏 App，约 160KB，负责托管引擎、显示窗口、管理登录项。
- **引擎**：保留已有的 JavaScript 代码，用 `bun build --compile` 编成单个二进制，不需要用户另装 Node。
- **界面**：纯 HTML/CSS/JS，由引擎提供，在 WKWebView 里显示，没有构建步骤。

## 放弃的方案

| 方案 | 为什么不选 |
| --- | --- |
| Electron | 要带一份 Chromium，体积超过 150MB，用户明确说「太重」 |
| Tauri | 要额外引入 Rust 工具链和插件体系，为了一个设置窗口不值得 |
| 用 Go 或 Swift 重写引擎 | 引擎已经稳定并在飞书里实测过，重写的风险大于收益 |
| 纯 SwiftUI 界面 | 界面和引擎的数据要做两套绑定；用 Web 界面，开发模式下也能直接在浏览器里调 |

## 后果

- 整个 App 约 58MB，大头是引擎（Bun 运行时）。
- Bun 编译有一个坑：依赖里的 `__dirname` 会被写死成构建机路径，见 [LESSONS.md](../../LESSONS.md) 第 1 条。
- 签名要分两次：引擎需要 JIT 相关的 entitlements，外壳不需要。

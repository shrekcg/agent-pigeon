# 设计决策

每份记录一个已经定下的关键决策：当时的背景、选了什么、为什么，以及放弃了哪些方案。要推翻某个决策，就新写一份，并在旧记录里标注「已被 000X 取代」，旧记录本身不删。

| 编号 | 决策 |
| --- | --- |
| [0001](0001-hub-channels-agents.md) | 分成渠道、中枢、Agent 三层，用绑定把渠道和会话连起来 |
| [0002](0002-process-card-plus-conclusion.md) | 一轮对话 = 一张流式过程卡加一张结论卡 |
| [0003](0003-native-shell-not-electron.md) | Mac App 用 Swift 外壳加 WKWebView 加 Bun 编译的引擎，不用 Electron |
| [0004](0004-cli-agents-headless-resume.md) | 命令行类 Agent 用无界面续跑接入，只同步渠道发起的轮次 |
| [0005](0005-one-isolation-switch.md) | 渠道只保留「按会话隔离」一个开关，基础能力不设开关 |

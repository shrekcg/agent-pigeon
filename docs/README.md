# 文档索引

先读哪份取决于你要做什么：

| 你要做的事 | 读这份 |
| --- | --- |
| 了解这是什么产品、解决什么问题、给谁用 | [product.md](product.md) |
| 了解当前做到哪了、哪些能用、哪些还没做 | [status.md](status.md) |
| 接手开发：环境、构建、发布、日常操作 | [development.md](development.md) |
| 了解整体技术方案和模块边界 | [architecture.md](architecture.md) |
| 改某个子系统前，看它的契约和坑 | [subsystems/](subsystems/README.md) |
| 了解关键设计为什么这样定 | [decisions/](decisions/README.md) |
| 给用户写的飞书配置步骤 | [飞书应用配置.md](飞书应用配置.md) |
| 以前踩过的坑和由此定下的规则 | [../LESSONS.md](../LESSONS.md) |
| 写给 AI Agent 的接手说明 | [../AGENTS.md](../AGENTS.md) |
| 版本变化 | [../CHANGELOG.md](../CHANGELOG.md) |

## 维护规则

- **同一个事实只写在一处**，其他地方链接过去。代码会变的细节（函数签名、行号）写进源码注释，不在文档里复制。
- **改动和文档同步提交**：改了子系统的职责、接口、状态流转、运行路径或失败行为，就在同一个提交里更新它的参考页。只改内部实现、契约不变的重构，不需要改文档。
- **只写当前行为**：文档只描述现在的实现。计划写进 [status.md](status.md) 的待办或 GitHub Issue。
- **不写本机数据**：不要出现个人路径、chat_id、会话 ID、凭据。示例一律用 `oc_xxx`、`~/…` 这种占位写法。

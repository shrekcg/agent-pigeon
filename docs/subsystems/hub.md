# 中枢

源码：`src/hub/hub.js`（绑定、路由、动作）、`src/hub/commands.js`（`/ht` 指令的执行）、`src/core/commands.js`（纯函数：指令解析、`/pd`、停止意图、回传路径、会话查找、`idleEdge`）、`src/core/store.js`（持久状态）。

## 职责

中枢上接渠道、下接 Agent，渠道和 Agent 彼此不直接打交道，它负责：

- **管理绑定**：一个绑定把渠道里的一个位置和某个 Agent 的一个会话连起来。
- **路由**：渠道收到的消息转给对应的会话；Agent 产生的事件转给对应绑定的渠道视图。
- **两边共享的记账**：
  - 会话 ID 回写；
  - 标题跟随；
  - 自己注入的文字不当成 Agent 端发言再显示一遍；
  - 记住上一条指令；
  - 遗留卡收尾；
  - 已归档或已删除会话的巡检。

## 绑定

```
{ id, channel, agent, sessionId, cwd, title, createdAt, address }
```

- `id` 由渠道决定，飞书话题模式是 `feishu:<threadId>`，共享模式是 `feishu:m:<anchorMessageId>`。
- `sessionId` 可以是 `null`：命令行类 Agent 新建会话时，要等第一轮跑完，适配器发出 `session_id` 事件，中枢才把 ID 写进来。
- `bind()` 按「渠道 + Agent + 会话」幂等，同一个会话在同一个渠道里只会有一个绑定。

## 入站流程（`Hub.inbound`）

```
去重（seen，最近 500 条）
→ 是 /ht 指令        → commands.js 执行
→ 渠道能定位到绑定    → 暂停？停止意图？否则 send（默认插话，/pd 或媒体排队）
→ 未绑定话题，或共享模式下没有当前会话 → 用这条消息作为首条输入新建会话
→ 主时间线的普通消息  → 回帮助卡
```

- **定位绑定**由渠道自己做（`channel.resolveBinding`）：
  - 话题模式看 thread_id；
  - 共享模式先看引用的是哪条消息，再看当前会话。
- **停止意图**只在这个绑定正在运行时才生效，判断见 `isStopIntent`：只认几个准确的词，或 12 个字以内的短语，所以长句不会误触发。
- **暂停**期间消息不送进会话，60 秒内最多提醒一次。

## 出站事件（`#onAgentEvent`）

- `session_id`：写进绑定。
- `title`：只有当前标题还是占位名（`新会话`、`会话 xxxxxxxx`）时才跟着改，用户手动改过的不动。
- `user_text`：如果和最近注入的某条文字一样（10 分钟内，最多记 80 条），说明这是自己发进去的消息回显，丢掉。
- 其余事件原样交给渠道视图。

## 指令

| 指令 | 种类 | 说明 |
| --- | --- | --- |
| `/ht`、`/ht〈标题〉`、`/ht@<agent>〈标题〉` | `new` | 新建会话，开一个位置。`@agent` 可以用别名，见 `agents/index.js` 的 `ALIASES` |
| `/ht <ID前缀/最近>`、`/ht@<agent> <…>` | `attach` | 接入已有会话。可以按完整 ID、前缀、8 位短号、唯一的标题片段或「最近」查找 |
| `/ht-list[@agent]` | `list` | 列出某个 Agent 的会话 |
| `/ht-agents` | `agents` | 各 Agent 是否可用 |
| `/ht-cn〈名〉`、`/ht-cn〈ID〉〈名〉` | `rename` | 改名 |
| `/ht-close[〈ID〉]` | `close` | 下线 |
| `/ht-use〈ID〉` | `use` | 共享模式下切换当前会话 |
| `/ht-help` | `help` | 帮助 |

括号可以用 `〈〉`、`《》`、`<>`、`＜＞` 中的任意一种。开头的全角 `／` 也认。

## 巡检

启动时跑一次，之后每 24 小时跑一次（`SESSION_SWEEP_MS`）。只检查 `capabilities.sweep` 为真的 Agent，目前只有 PenguinHarness。会话被删除或归档后，对应绑定自动下线，并在渠道里留一条说明。

## 状态（`state.json`）

| 字段 | 内容 |
| --- | --- |
| `bindings` | 绑定 |
| `active` | 共享模式下每个对话的当前会话，键为 `<channel>:<chatKey>` |
| `seen` | 最近 500 条入站消息 ID |
| `sentTexts` | 最近注入的文字（用来过滤回显） |
| `openCards` | 还没收尾的流式卡片（用来在重启后收尾） |

写入方式是先写临时文件再改名，整个文件重写。

## 验证

`test/hub.test.mjs` 用假渠道和假 Agent 覆盖了这些情况：

- 话题模式新建会话、会话 ID 回写、续跑；
- 在未绑定话题里发消息；
- 重复投递的消息；
- `attach` 的幂等；
- 共享模式按引用路由和 `/ht-use`；
- 自己注入的文字不回显；
- 停止和下线；
- 渠道的 Agent 放行名单。

`test/commands.test.mjs` 覆盖指令解析。

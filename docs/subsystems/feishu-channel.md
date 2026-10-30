# 飞书渠道

源码：`src/channels/base.js`（渠道契约）、`src/channels/feishu/index.js`（渠道本身）、`inbound.js`（入站消息与附件）、`client.js`（REST、CardKit、长连接）。卡片部分见 [feishu-cards.md](feishu-cards.md)。

## 连接

- 一个飞书自建应用，一个对话：用户和机器人的单聊，对应配置里的 `chatId`。其他对话的消息、机器人自己发的消息一律忽略。
- 事件通过官方 SDK 的长连接（`WSClient`）接收：`im.message.receive_v1`、`card.action.trigger`、`im.message.reaction.created_v1`。
- **同一个应用同一时间只能有一个长连接**。如果 PenguinHarness 的「远程控制」也用这个应用，就要把它的「启用连接」关掉，否则两边会抢消息。
- 凭据的读取顺序：先看 `config.json` 的 `channels.feishu.appId/appSecret`；没有的话，只读打开 PenguinHarness 的 `~/.penguin/data/web.db`，从 `messaging_bindings` 表里取 `channel='feishu'` 的最新一行。凭据不会写到别的地方。
- 发 IM 消息、回复、更新卡片都走 `imCall()`：串成一条队列，每次间隔 1.1 秒，遇到 `230020`（发得太频繁）自动退避重试。CardKit 的元素推送不走这条队列。

## 隔离方式

渠道级设置 `channels.feishu.isolation`，对应控制台里的「按会话隔离」开关。

| 方式 | 打开会话（`open`） | 定位绑定（`resolveBinding`） |
| --- | --- | --- |
| `thread`（默认） | 在主时间线发一张名片，再回复它一次，这样就开出一个话题。名片首行是 `[Agent] 标题` | 按话题的 thread_id |
| `shared` | 在主时间线发一张名片，不开话题 | 先看用户引用的消息（`parent_id`）属于哪个绑定，没有引用就用当前会话 |

- 共享模式下，渠道会记下每条自己发出的消息属于哪个绑定（`trackMessage`，最多 3000 条），用户引用回复时才能路由回去。
- 切换隔离方式只影响之后新开的会话，已有的绑定保持原样。

## 入站附件

- 图片和文件会下载到 `数据目录/inbox/<日期>/`，以本地路径交给 Agent。所有 Agent 都能读本地文件，但不是每个 Agent 都接受 base64。
- 大小上限：图片 20MB，文件 100MB。
- 语音、视频、表情包不支持，会在话题里说明。
- 富文本消息（post）只取其中的文字。

## 回传文件

Agent 回复里提到的路径，同时满足以下条件才会回传：

- 路径可以是裸路径、反引号括起来的路径，或者 markdown 链接；
- 按真实路径比较后，位于会话目录内；
- 文件存在；
- 修改时间不早于本轮开始前 2 分钟。

每轮最多回传 5 个。图片不超过 10MB 按图片发，其他文件不超过 30MB 按文件发，更大的只发一条说明。

## 卡片按钮与表情

- **停止**：调用 `hub.stop(bindingId)`，提示语按实际结果给出：「已请求停止」或「当前没有正在运行的任务」。
- **允许 / 拒绝**：调用 `hub.decide`，处理完把卡片改成「已允许 / 已拒绝」；如果审批已经处理过，改成「已处理过」。
- **提问卡回答**：作为一条排队消息注入会话。
- **表情审批**：在审批卡上点 DONE / THUMBSUP / OK 表示允许，点 CROSS_MARK / THUMBDOWN 表示拒绝。
- 按钮回调必须同步返回 toast，平台把它当成一次请求和响应。

## 加一个渠道

在 `src/channels/<id>/` 实现 `Channel` 契约（`start`、`open`、`createView`、`resolveBinding`、`reply`、`refresh`、`closed`、`ask`、`status`），再在 `src/channels/index.js` 里给它的 `make` 赋值。

- 没有话题能力的平台，`capabilities.threads` 设为 `false`，隔离方式会固定为 `shared`。
- 中枢、Agent 和控制台都不用改。

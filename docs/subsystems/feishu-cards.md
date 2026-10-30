# 飞书卡片

源码：`src/channels/feishu/runcard.js`（过程卡）、`src/channels/feishu/view.js`（一个绑定的渲染与运行边界）、`src/channels/feishu/cards.js`（其余卡片的 JSON）。

## 一轮在话题里的样子

```
用户消息
执行过程卡   run_start 时建卡，运行中逐字刷新；收尾后折叠成一个面板加状态行
结论卡       本轮最后一条助手消息，单独一张卡
回传文件     如果本轮有产出
```

阅读顺序固定是：问题、过程、答案。这个形态是定版，曾经否掉过两种做法：一是新消息到达时让出卡片、把回答续到下一张；二是收尾后再补发一条纯文字。改动前先读 [decisions/0002-process-card-plus-conclusion.md](../decisions/0002-process-card-plus-conclusion.md)。

## 节奏常量（`runcard.js` 顶部）

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `CONTENT_MIN_INTERVAL_MS` | 100 | 两次正文推送的最小间隔（与飞书官方 openclaw-lark 插件一致） |
| `LONG_GAP_MS` | 2000 | 距上次推送超过 2 秒，算作一次停顿 |
| `GAP_BATCH_MS` | 300 | 停顿后的第一帧延后 300ms，让它带上整句文字，而不是半个字 |
| `STATUS_MIN_INTERVAL_MS` | 1500 | 状态行和工具面板的刷新间隔 |
| `MAX_CARD_TEXT` | 20000 | 卡片正文上限，超出部分截断并注明 |
| `STEPS_VISIBLE` | 6 | 工具面板只显示最近 6 步 |

其他时间常量写在 `view.js` 里：
- 建卡后 3.5 秒还没发出去，就发一次心跳；
- `run_end` 之后等事件静默 500ms 再收尾，最多等 5 秒；
- 同一个审批，10 分钟内只发一次卡。

## 卡片结构

运行中用 CardKit 流式卡片（schema 2.0），元素依次是：

- `answer`：正文累积
- `steps`：工具步骤
- `status`：状态行，带飞书标准图标
- 「停止」按钮

卡片头部是飞书标准图标 `robot_outlined`，加一个 Agent 名称的文字标签。不用 emoji。

收尾后整张卡换成一个默认折叠的 `collapsible_panel`（`执行过程 · N 步`，里面是本轮分析和工具步骤），下面是一行状态，按钮去掉。**带按钮的卡就是没收尾的卡。**

状态行的取值和图标：

| 阶段 | 文本 | 图标 token |
| --- | --- | --- |
| 起始 | 开始处理… | `time_outlined` |
| 思考 | 思考中 · mm:ss | `loading_outlined` |
| 工具 | 调用工具 〈名称〉 · mm:ss | `setting_outlined` |
| 生成 | 生成中 · mm:ss | `edit_outlined` |
| 完成 | 完成 · 用时 Xs · 〈模型〉 | `succeed_filled` |
| 失败 | 请求失败（code） · 用时 Xs | `error_filled` |
| 手动停 | 已停止（手动中断） | `stop_outlined` |
| 无输出 | 已结束（本轮没有文字输出） | `warning_filled` |

图标 token 必须取自飞书官方图标库（`open.feishu.cn/document/feishu-cards/enumerations-for-icons`）。**建卡接口不会校验 token**，填错了不报错，只是不显示图标。

## sequence 规则

- CardKit 对同一张卡的 `sequence` 是 int32，必须严格递增，否则返回 `300317`。
- 对同一张卡的所有写入，都要走 `RunCard.#op()` 的串行链，并用 `#nextSequence()` 取号。
- 被大值推进过的卡再也改不回去。收尾遗留卡时，sequence 用 `1_000_000_000`、`1_500_000_000`、`2_000_000_000` 三档，失败就换下一档。不要随手用 `2_147_483_647`，用了这张卡就锁死了。
- 收尾时要 `patchCardSettings({ streaming_mode: false })`，否则客户端可能一直把它显示成流式中。

## 10 分钟流式窗口

CardKit 的流式窗口只有 10 分钟。超时后推送元素会返回 `200850`（或 `300309` streaming mode is closed），但整卡更新仍然可用。

- 卡片存在超过 9 分钟时，主动切换到 `fullMode`；收到上面两个错误码时，被动切换。
- `fullMode` 下每次更新都整卡 PUT，间隔不少于 1.5 秒。
- **不能因为超时就把卡判死**：旧版这样做过，结果后续文字退化成一条条聊天消息，刷屏。

## 运行边界（`view.js`）

- `run_start`：建卡。PenguinHarness 在一轮之内会多次报 `running`，所以已经有一张运行中、未收尾的卡时，不再建新卡。
- `run_end`：只有本连接见过 `run_start` 才算一轮结束，判断见 `idleEdge()`。SSE 重连时服务端会先推一个 `idle` 快照，如果把它当成结束，就会把上一轮的回答当成新结论再发一次。
- **排队的下一轮**：它的卡要等上一轮的结论卡发出去再出现。做法是 `view.settled` 这个 Promise 加上 `RunCard.after`，保证顺序始终是问题、过程、答案。
- **共享模式**：卡片标题换成会话名，结论卡带会话名表头。每条发出的消息都记下属于哪个绑定，这样用户回复时能路由回去。

## 遗留卡

卡片只活在进程内存里，进程退出后就没人去收尾。

- 卡片发出时写入 `state.json.openCards`，收尾后清掉。
- 启动和收到 SIGTERM 时，`closeOpenCards()` 把这些卡改成无按钮的静态卡，状态行显示「Agent 信鸽重启，本卡在此冻结」。

## 失败可见

- Agent 报了 `failure`，卡片状态行会显示「请求失败（code）」。
- 如果这一轮根本没有卡，就直接在话题里发一条失败说明。
- 用户手动停止不算失败。

## 验证

- 用 `node tools/topicdump.js <thread_id> 10` 读出话题里实际显示的内容，核对顺序。
- 卡片改动必须在真实飞书里跑一轮，只编译通过不算。

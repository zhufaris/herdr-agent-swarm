# cc-connect v1.5.0 input message 与卡片模型调研

日期：2026-10-04

范围：本机安装的 `cc-connect v1.5.0`；对应源码 revision
[`17c61062c2f9ce9bcdd45a2082e491f9743a2770`](https://github.com/chenhg5/cc-connect/tree/17c61062c2f9ce9bcdd45a2082e491f9743a2770)。

## 结论

cc-connect 的交互模型很简洁：平台输入归一化成 `core.Message`，同一
`SessionKey` 同时只运行一个普通 turn；session 忙时，新输入进入内存 FIFO；
当前 turn 收到 terminal result 后，再逐条投给 agent。持久化 history 只有
`user` 和 `assistant` 两种 role；thinking、tool、permission、streaming card
都是 UI 投影，不是 canonical conversation。

这个展示思路值得 Swarm 借鉴，但它的可靠性边界不应复制。cc-connect 没有
durable ingress queue、持久化 acceptance record、agent delivery attempt 或
exact-turn ownership。平台 callback、queued notice 或 UI 中出现 user bubble，
都不能证明输入已经持久化或已经到达 agent。

## 输入、队列与持久化

- Feishu callback 提取 message ID，做短期内存去重和进程启动时间过滤，生成
  session key，并执行 mention/allowlist 检查（[`feishu.go:1338-1425`](https://github.com/chenhg5/cc-connect/blob/17c61062c2f9ce9bcdd45a2082e491f9743a2770/platform/feishu/feishu.go#L1338-L1425)）。
- callback 启动 goroutine 后立即返回；媒体下载、core acceptance 和 agent
  delivery 都发生在 transport callback 返回之后（[`feishu.go:1451-1457`](https://github.com/chenhg5/cc-connect/blob/17c61062c2f9ce9bcdd45a2082e491f9743a2770/platform/feishu/feishu.go#L1451-L1457)）。
- 统一入站对象携带 `SessionKey`、`MessageID`、文本、附件、reply context 和
  `UserMessageTimeMs`，没有通用 role 字段（[`message.go:362-402`](https://github.com/chenhg5/cc-connect/blob/17c61062c2f9ce9bcdd45a2082e491f9743a2770/core/message.go#L362-L402)）。
- session 忙时，输入追加到进程内 `pendingMessages` slice；这里只调用
  `OnAccepted` 并回复已排队，不写 session snapshot（[`engine.go:3142-3213`](https://github.com/chenhg5/cc-connect/blob/17c61062c2f9ce9bcdd45a2082e491f9743a2770/core/engine.go#L3142-L3213)）。
- 当前 turn 完成后，每次取 `pendingMessages[0]`，重置上一 turn 的 card/stream
  状态，再投给 agent；真正开始处理时才写 user history（[`engine.go:5872-6013`](https://github.com/chenhg5/cc-connect/blob/17c61062c2f9ce9bcdd45a2082e491f9743a2770/core/engine.go#L5872-L6013)）。
- session snapshot 使用原子 JSON 写入并可在重启后恢复，但 schema 不含
  `pendingMessages`（[`session.go:267-311`](https://github.com/chenhg5/cc-connect/blob/17c61062c2f9ce9bcdd45a2082e491f9743a2770/core/session.go#L267-L311)，
  [`session.go:618-710`](https://github.com/chenhg5/cc-connect/blob/17c61062c2f9ce9bcdd45a2082e491f9743a2770/core/session.go#L618-L710)）。

因此 cc-connect 的 FIFO 是单进程 acceptance order，不是可恢复的 canonical
input log。create-time watermark 只拒绝严格更旧的输入；相同或缺失 timestamp
以及 adapter 异步处理仍不能形成 total order（[`engine.go:568-584`](https://github.com/chenhg5/cc-connect/blob/17c61062c2f9ce9bcdd45a2082e491f9743a2770/core/engine.go#L568-L584)，
[`engine.go:2591-2615`](https://github.com/chenhg5/cc-connect/blob/17c61062c2f9ce9bcdd45a2082e491f9743a2770/core/engine.go#L2591-L2615)）。

## Human、assistant 与过程事件

| 概念 | cc-connect 表示 | durable history |
| --- | --- | --- |
| Human | 入站 `core.Message`；turn 开始后追加 `user` | 是 |
| Assistant | terminal result 聚合的最终 response | 是 |
| Thinking | `EventThinking` | 否 |
| Tool use/result | `EventToolUse` / `EventToolResult` | 否 |
| Permission/question | 结构化交互事件；用户操作再变成 input | 否 |
| System | adapter 注入的运行上下文 | 否 |

Agent event 类型与仅含 `user`/`assistant` 的 history schema 见
[`message.go:404-460`](https://github.com/chenhg5/cc-connect/blob/17c61062c2f9ce9bcdd45a2082e491f9743a2770/core/message.go#L404-L460)。
terminal result 才写 assistant history（[`engine.go:5500-5592`](https://github.com/chenhg5/cc-connect/blob/17c61062c2f9ce9bcdd45a2082e491f9743a2770/core/engine.go#L5500-L5592)）。
tool use 通常更新 rich card 的 tool steps；不支持 rich card 时才降级成独立消息
（[`engine.go:5093-5212`](https://github.com/chenhg5/cc-connect/blob/17c61062c2f9ce9bcdd45a2082e491f9743a2770/core/engine.go#L5093-L5212)）。

Web UI 同样体现了“history 与 live projection 分离”：加载时把 durable
user/assistant history 映射成消息；live reply、stream、card、buttons 都投影成
assistant visual entries（[`ChatView.tsx:343-473`](https://github.com/chenhg5/cc-connect/blob/17c61062c2f9ce9bcdd45a2082e491f9743a2770/web/src/pages/Chat/ChatView.tsx#L343-L473)）。
发送时 UI 会先乐观追加 user bubble 再发 WebSocket（[`ChatView.tsx:506-521`](https://github.com/chenhg5/cc-connect/blob/17c61062c2f9ce9bcdd45a2082e491f9743a2770/web/src/pages/Chat/ChatView.tsx#L506-L521)），
所以可见消息不能充当 durable acceptance 证据。

## Ack、retry 与幂等边界

- Feishu 入站去重是 60 秒进程内 map，重启后并不重放恢复
  （[`dedup.go:8-50`](https://github.com/chenhg5/cc-connect/blob/17c61062c2f9ce9bcdd45a2082e491f9743a2770/core/dedup.go#L8-L50)）。
- 通用 agent `Send` 没有 durable attempt ID 或 idempotency token。Codex
  app-server 只有取得非空 turn ID 才认为 `turn/start` 成功
  （[`appserver_session.go:444-503`](https://github.com/chenhg5/cc-connect/blob/17c61062c2f9ce9bcdd45a2082e491f9743a2770/agent/codex/appserver_session.go#L444-L503)）。
- Feishu outbound 对 transient error 最多 retry 3 次，但请求没有显式
  idempotency key；模糊网络失败存在重复消息窗口
  （[`feishu.go:3673-3727`](https://github.com/chenhg5/cc-connect/blob/17c61062c2f9ce9bcdd45a2082e491f9743a2770/platform/feishu/feishu.go#L3673-L3727)，
  [`feishu.go:3773-3857`](https://github.com/chenhg5/cc-connect/blob/17c61062c2f9ce9bcdd45a2082e491f9743a2770/platform/feishu/feishu.go#L3773-L3857)）。

## 对 Swarm 的推荐

1. 保持 SQLite 为 workflow truth、Core JSONL 为 conversation order truth，Lark
   card 只做 projection。不要用 Feishu arrival time、submission ID、SQLite row
   order 或 card update order 重排内容。
2. 采用一个统一的 **Conversation Segment / Turn Card** 聚合：一个 canonical
   `human_message` 开启一张新卡；后续 assistant、thinking、tool、command/waiting
   事件按 Core sequence 进入该卡，直到下一个 `human_message`。
3. Feishu 输入先用 `submission_id` 创建同一张 Turn Card 的 `pending` 外壳；只有
   exact canonical `human_message.submission_id` 出现后，才把该卡原地升级为
   `working` 并绑定 immutable segment identity。不要另外创建一张 Answer Card。
4. 直连 Herdr、Primary 和 Worker 统一使用上述边界。直连输入没有 Feishu
   submission intent 时，在看到 canonical Human Message 后直接创建 `working`
   Turn Card。
5. 卡片正文保留结构化事件：answer text 常显；thinking 显示摘要、全文折叠；
   tool call/result 与 waiting-for-command 作为有状态步骤；system/runtime 只显示
   必要告警。Human 文本固定显示在卡片头部，不混入 answer timeline。
6. Human boundary 是语义分段，不是排序机制。长内容仍按 9,000 字符或 CardKit
   限制分页；同一 segment 的 continuation card 不产生新的 Human boundary。
7. segment identity 应来自 producer/session fence + canonical Human item ID；
   pending adoption 使用 `submission_id -> human_event_id -> segment_id` 的 durable
   关系。create/update/finalize 使用稳定的 segment/page idempotency key 和严格
   card sequence。
8. 前一页冻结后不回写。迟到但 canonical 属于旧 segment 的事件应走该 segment
   的 late-result continuation/correction projection，不能移动到较新的 Human 卡片。

## 限制

本次未启动 cc-connect、未抓取生产流量，也未逐一审计所有 platform adapter。
结论基于本机二进制对应 revision 的 core、Feishu、Bridge/Web、Codex 与 Claude
Code 代表性路径；没有修改配置、数据库或运行服务。

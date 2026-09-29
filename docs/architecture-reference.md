# Herdr Agent Swarm 架构参考

## 文档目标

本文面向第一次维护 Herdr Agent Swarm 的工程师。读完后，你应该能够：

- 判断一项事实由 Herdr、Herdr Core Agent Events、SQLite、Lark 还是 user systemd 负责；
- 从 Lark 输入追踪到 Agent 执行、结构化观察、持久化投影和 CardKit 投递；
- 判断新行为应进入哪个 context、workflow、port 或 adapter；
- 在改动代码时保护 FIFO、no-replay、identity fence、durable outbox 和有序分页等不变量。

本文是代码结构的导航。精确行为以 [Architecture](architecture.md) 为准，用户命令以
[Feishu group usage](feishu-group-usage.md) 为准，领域词汇以
[Context Map](../CONTEXT-MAP.md) 为准。

## 1. 系统本质

Herdr Agent Swarm 是一个独立部署、持久化、由人控制的多 Agent 工作流协调器。它把
Lark 话题绑定到真实 Herdr Pane 中的 Primary Agent，把 Worker 任务绑定到受管 Worker
Pane，并通过 retryable outbox 把 durable projection 投递到 Lark。

```text
Lark message or card action
  -> durable inbound
  -> application workflow
  -> durable prompt/control intent
  -> Herdr Agent
  -> Herdr Core Agent Events
  -> SQLite projection + outbox
  -> Lark CardKit / rich-text delivery
```

它的核心问题不是消息转发，而是在进程重启、网络失败、重复事件、迟到结果、Core
journal retention 和不确定执行之间保持业务语义不变。

## 2. 权威源与边界

| 事实 | 权威源 | Swarm 的责任 |
| --- | --- | --- |
| Pane、terminal、前台进程、Agent kind/session、实时状态 | fresh Herdr snapshot 与 targeted observation | 验证 identity/generation 后收敛 durable binding |
| 支持 Agent 的 turn lifecycle、Agent message、tool call/result、plan | exact Herdr Core Agent Events source | 读取有序 cursor，投影为 Answer/Main Card 状态 |
| Binding、Prompt FIFO、Worker task、控制操作、read model、outbox、lease | SQLite | 在事务和 fencing token 内推进状态 |
| 可见消息、CardKit 卡片和 delivery receipt | Lark | 作为投递目标；不得反推工作流事实 |
| 服务进程、启停和守护 | user systemd | 通过 `npm run swarm:*` 操作 |

必须保持以下规则：

1. 不从 Lark 卡片修复 SQLite，也不把卡片文本当作执行状态。
2. Herdr socket event 只是 bounded wake-up hint；fresh snapshot 才是收敛依据。
3. 支持 Agent 的结构化回复只来自 Core Agent Events；不回退到 pane scrollback 或 Swarm
   自行解析的 JSONL。
4. 所有外部投递先持久化 intent；重试 Lark outbox 绝不重放 Agent prompt。
5. 一旦 prompt 可能到达 Agent，只能精确观察、detached recovery 或显式 skip，不能自动重放。

## 3. 分层与依赖方向

```text
External systems
  Lark / CardKit | Herdr / Core Agent Events | user systemd
           |
Adapters and infrastructure
  gateway plugin | Herdr adapter | event reader | SQLite stores | command runner
           |
Application workflows
  inbound | sessions | prompts | workers | reconciliation | projection | delivery
           |
Domain contracts
  states | transitions | events | capability ports | reducers | invariants
```

`src/main.ts` 是唯一 composition root。`src/composition/` 构造 adapter、capability store、
workflow、runtime event integration、lease、health 和 shutdown ownership。领域和应用层只依赖
consumer-shaped port；它们不能读取部署路径、调用具体 SQLite module 或自行创建另一套基础设施。

## 4. 五个业务 Context 与一个观察边界

| Context / boundary | Owns | Does not own |
| --- | --- | --- |
| Primary Session | Lark topic 到 Primary pane/session 的 durable binding、generation、provisioning | Prompt FIFO、回复内容、Lark delivery |
| Prompt Execution | ordinary prompt FIFO、steering、dispatch evidence、attached/detached observation | Pane 事实、卡片渲染 |
| Worker Runtime | Worker identity/generation、task FIFO、turn ownership、worktree 生命周期 | Primary conversation binding |
| Conversation Projection | Topic/Main/Run/Worker/Answer read models、timeline、page cursor | 执行决策 |
| Delivery and Operations | gateway intent、lane ordering、retry/dead letter、delivery checkpoint、lease/status | Agent 执行结果 |
| Agent Observation boundary | exact pane/session/turn 对应的 Core event cursor | Binding lifecycle 或 presentation policy |

Agent Observation 当前是跨 Context 的 anti-corruption boundary，而不是第六个 durable aggregate。
Core 拥有 source discovery、producer-specific decode 和 journal；Swarm 的 `HerdrEventsReader` 只用
pane、Agent kind 和 expected session ID attach，再把 versioned events 转换为
`AgentTranscriptObservation`，Prompt/Worker/Projection 消费这个稳定 port。
现存 `AgentTranscript*` 类型名是兼容中的领域词汇，表示归一化的 Agent 输出观察；它们不表示
Swarm 直接打开或解析 Agent JSONL。新的 filesystem integration 必须使用 event-source 命名。

## 5. 关键领域对象

### TopicPaneBinding

Binding 是一个 Lark topic 与 Primary Agent session 的 durable 关系。它有三条独立状态轴：

| 轴 | 示例 | 回答的问题 |
| --- | --- | --- |
| lifecycle | provisioning, active, draining, archived, closed, failed | 会话处于哪个业务阶段？ |
| attachment | unattached, attached, degraded, orphaned | durable identity 与 live pane 是否可信？ |
| runtime | idle, working, blocked, done, unknown | fresh Herdr observation 看到什么？ |

生命周期只能经领域 transition 推进。普通 metadata 更新不能修改 lifecycle、attachment、
generation 或 exact-session fence。

### PromptJob、WorkerTurn 与控制操作

普通 Prompt 在一个 Binding 内严格 FIFO；一个 Binding 同时至多执行一个 ordinary turn。
Steering 和 stop 是 exact-turn control，不是另一条普通 Prompt。WorkerTurn 在一个 Worker generation
内也保持单 owner、可恢复 claim 和不确定投递语义。

执行状态与 observation state 分开记录。`queued` 工作可以重试 dispatch；已经越过 dispatch
fence 的工作只能继续观察。所有控制结果必须匹配 pane、terminal、session、generation 和 exact turn。

### TopicView、RunCard、AnswerPage

这些是 durable read model，不是执行状态的 authority：

- `TopicViewState` 驱动 Primary Main Card；最近消息只保留 Agent 回复的 bounded window。
- `RunCardView` 记录一个 Prompt 的请求摘要、计划、状态和 Answer projection。
- `answer_timeline_items` 保存有序 Agent Markdown、tool、status 和 final answer 项。
- `AnswerPage` 保存 rich-text message、页 cursor、fingerprint 和 delivery checkpoint。

Answer 以最终 Markdown budget 分页。当前默认单页预算为 12,000 字符；tool panel 的 JSON 大小
不是分页依据。旧页冻结后不再 patch，更新写入 active/continuation page。

## 6. 当前深模块地图

### 接入

`DurableInboundPipeline` 是外部输入进入应用的统一持久化入口。它负责 allowlist 后的 compact
admission、去重、scope FIFO claim/release、retry 和 startup recovery。
`InboundMessageRoutingWorkflow` 只做冻结路由上下文下的命令/普通消息分派；
`PromptAdmissionWorkflow` 原子创建 Prompt、初始 projection 和 outbound intent。

### Primary 执行

`PromptRunWorkflow` 是 Primary 生命周期 facade。它协调：

- `PrimaryPromptDispatcher`：从 SQLite 原子 claim ordinary FIFO；
- `PromptTurnExecutor`：执行单个受 fence 的 turn；
- `DetachedPromptObserver`：重启或不确定 settlement 后恢复 exact turn；
- `ExternalTurnObserver`：采用直接在 Herdr 发起且可证明属于当前 session 的 turn；
- `TurnControlWorkflow` / `TurnControlDispatcher`：持久化并串行执行 exact-turn control。

进程内 worker 只优化调度；互斥、claim 和恢复依据都在 SQLite。

### Worker 执行

`WorkerTurnDispatcher` claim Worker task 并调用 Agent driver；`WorkerTurnObserver` 读取 exact Core
event turn；`InstanceTurnSupervisor` 保证一个 Worker generation 的 dispatch/observe ownership。
Worker 生命周期、worktree 和 pane 操作由 instance/session workflows 管理，不由卡片 projector 管理。

### Agent Observation

生产 composition 只把 `HerdrEventsReader` 交给 Primary 和 Worker workflows。它执行：

1. 用 pane、Agent kind 和 expected native session ID attach Core source；source path 由 Core 唯一定位；
2. 从当前 end、active turn、exact turn 或 previous-turn boundary 打开 cursor；
3. 将 Core event 映射为 Agent message、tool activity/timeline、累计唯一 edited-file count、plan、status 和 lifecycle；其中 edited-file event 只携带计数，不暴露路径；
4. 对 source/session/turn/start-time 做 fence，并对输出再次做 presentation-side bound/redaction；
5. 在 cursor retention floor 前的边界不可证明时 fail closed。

协调器不读取 JSONL，不解析 pane 文本，也不根据“看起来 idle”推断 exact turn 成功。

### Runtime reconciliation

`HerdrRuntimeReconciler` 通过 `BindingReconciliationPass` 和 `BindingRuntimeConverger` 收敛 fresh
snapshot。Socket 与周期触发都进入同一条路径；workspace failure 隔离且通过 health/status 暴露。
reconciliation 只拥有 live binding facts，不拥有 Core reply projection。

### Projection

纯 reducer 生成 desired view；`ConversationViewProjector`、`AnswerPageWorkflow`、
`MainCardWorkflow` 和 `WorkerTurnCardWorkflow` 把 lifecycle/Core observations 收敛到 SQLite。
Main Card 不是第二份 Answer：它展示当前任务、完整计划、当前活动、最近五条 Agent 回复和运行环境；
完整 Agent/tool 历史留在 Answer 或 Worker Task surface。

### Delivery

`OutboundIntentWriter` 先写 durable gateway intent。`GatewayOutboxDispatcher` 把扫描调度委托给
`OutboundLaneDrain`，把单次 effect 委托给 `OutboundDeliveryExecutor`。同一 target lane 串行，
不同 lane 有界并发。成功 receipt 与 page/card checkpoint 在同一 SQLite transition 中提交。

### SQLite capability graph

`SqliteCapabilityGraph` 在一个 `SqliteContext` 上构造 capability stores，`SqliteStoreBundle` 只暴露
consumer-shaped ports。migration 由一个 ordered runner 执行。跨表业务转换保持一个 transaction 和
write fence；不能为了“一表一个 repository”拆散原子性。`SqliteBindingStore`/`SqliteStoreKernel`
仅是测试和 headless smoke 的 compatibility facade，不是生产 composition owner。

### Runtime lifecycle

`ManagedBridgeRuntime`、`RuntimeLifecycleLedger`、`BridgeRuntimeShutdown` 和 instance lease 共同拥有
startup/shutdown。`HealthSnapshotCollector` 产生 `/health`、`/ready`、`/status` 所需的 bounded snapshot；
HTTP server 不自行推断 readiness。

## 7. 三条主链路

### 普通 Lark Prompt

```text
Gateway callback
  -> normalize + authorize
  -> DurableInboundPipeline
  -> InboundMessageRoutingWorkflow
  -> PromptAdmissionWorkflow transaction
  -> prompt-ready hint
  -> PromptRunWorkflow claim
  -> Agent driver / Herdr
  -> Core Agent Events exact turn
  -> Answer/Main projection transaction
  -> gateway outbox lane
  -> Lark delivery + checkpoint
```

### Herdr/Core observation

```text
Herdr socket hint or periodic timer
  -> fresh snapshot reconciliation
  -> binding identity convergence

Core event polling
  -> exact source cursor
  -> exact turn observation
  -> durable timeline/plan/message projection
  -> card convergence
```

两条链路共享 identity，但职责不同：snapshot 回答“哪个 Agent 在哪个 Pane、现在什么状态”；
Core event 回答“这个 exact turn 产生了哪些结构化内容”。

### Lark delivery failure

```text
outbox lane head
  -> target/version validation
  -> gateway effect
       success   -> durable receipt/checkpoint
       transient -> bounded backoff retry
       permanent or exhausted -> dead letter
```

任一分支都不会再次提交 Prompt。

## 8. JSONL 与 Core Agent Events 清理边界

“不再由 Swarm 解析 JSONL”不等于“删除 JSONL”。当前边界分三层：

| 分类 | 当前用途 | 决策 |
| --- | --- | --- |
| Agent 原始 JSONL 历史 | Core source 输入、Agent 自身恢复/审计 | 保留；不由 Swarm 删除或改写 |
| Core `events.db` journal | versioned cursor、retention、source 状态 | 保留；由 Core 管理 retention |
| Swarm TraeX/Pi direct parser、file cursor、projector | 旧的 reply decode 路径 | 已删除；smoke 与测试使用 Core Events/Core-shaped observations |
| pane scrollback parser | bounded diagnostics only | 绝不作为 reply fallback；诊断用途按现有边界保留 |

清理已完成：Core 根据 pane、Agent kind 和 authoritative native session，在 allowlisted roots 内进行
bounded、exactly-one source discovery；Swarm 不再传 filesystem path，也不扫描 Agent sessions root。
Agent 原始 JSONL 和 Core journal 仍完整保留，删除它们会破坏 Core source、Agent 历史与恢复能力。

## 9. 并发、恢复与一致性

- **Durable before wake**：先提交 SQLite，再发进程内 scoped hint；hint 丢失只增加延迟。
- **FIFO and exclusion**：同 Binding 一个 ordinary turn；同 Worker generation 一个 turn owner。
- **No replay**：dispatch 结果不确定时 detached，不回到 queued。
- **Exact identity**：pane、terminal、session、generation、turn ID、canonical start time 必须匹配。
- **Replay idempotency**：timeline 用稳定 item ID；answer replay 只追加可证明缺失 suffix 或 replace-all。
- **Outbox ordering**：每 lane 串行，冻结页不 patch，checkpoint 与 receipt 原子推进。
- **Instance fencing**：SQLite lease token 失效后旧实例停止写入并 shutdown。
- **Retention failure**：Core cursor/boundary 不再保留时 fail closed，不能改读 pane 或原始 JSONL。

## 10. 改动放置指南

| 要改什么 | 首选位置 |
| --- | --- |
| Lark/Feishu SDK normalization 或 materialization | `src/gateways/feishu/` |
| Herdr CLI/Socket parsing | `src/adapters/`、`src/runtime/herdr/` |
| Core event contract adapter | `src/runtime/herdr-events-reader.ts` 与 domain observation port |
| Prompt/Worker/Session 决策 | 对应 `src/coordinator/` workflow |
| 状态转换和 consumer contract | `src/domain/` |
| durable projection/outbox transition | capability store + `src/events/` workflow |
| Card/rich-text 纯渲染 | `src/cards/`、presentation/gateway materializer |
| migration/transaction | `src/store/sqlite/` |
| 构造和 shutdown ownership | `src/composition/` |

新增跨边界行为时，先写清 authority、pre-effect durable fact、identity fence、uncertain outcome 和
recovery path，再选择模块。不要把这些判断塞进 router、renderer 或 adapter callback。

## 11. 验证清单

涉及边界的改动至少验证：

1. focused unit/integration test 覆盖 success、duplicate、stale identity、failure 和 recovery；
2. `npm run architecture:check`；
3. `npm run docs:audit`；
4. `npm run typecheck`；
5. `npm run build`；
6. 跨 workflow、persistence 或 shared runtime 的改动运行 `npm test`。

部署前先 `./install.sh` 生成 immutable release，再检查 `npm run swarm:status` 的 active-work safety
gate。正常 restart 不允许越过活跃工作；`--force` 也不应被理解为修复 degraded recovery 或放宽
identity/no-replay fence。

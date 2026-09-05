# Herdr Agent Swarm 架构参考

## 文档目标

本文面向第一次维护 Herdr Agent Swarm 的工程师。读完后，你应该能够：

- 判断一项状态由 Herdr、SQLite、Lark 还是 systemd 负责；
- 从飞书输入追踪到 TraeX 执行和 CardKit 投递；
- 找到新增命令、状态转换、运行时观测或投递行为应进入的模块；
- 在修改代码时保护 FIFO、no-replay、事务性 outbox 和 CardKit 顺序等核心不变量。

本文提供代码结构的心智模型。精确的运行行为和运维约束以
[Architecture](architecture.md) 与 [Feishu group usage](feishu-group-usage.md) 为准。

## 1. 系统本质

Herdr Agent Swarm 不是简单的消息转发器，而是一个持久化、多项目、多 Agent
工作流协调器。它管理项目级 Primary 和 Worker 实例，把 Lark 话题绑定到真实
Herdr Pane 中的 Agent 进程，同时保留 Herdr 作为本地观察、接管和高风险审批入口。

```text
Lark message
     │
     ▼
durable inbound → application workflow → durable prompt/control intent
                                             │
                                             ▼
                                      Herdr Pane / TraeX
                                             │
                                  authoritative observation
                                             ▼
                                  durable view + Lark outbox
                                             │
                                             ▼
                                      Lark CardKit delivery
```

这个系统面对的主要问题不是如何调用两个外部接口，而是如何在进程重启、网络失败、
重复事件、迟到回调和不确定执行之间保持业务语义不变。

## 2. 权威源

系统有四个不同的权威源。修改代码前，应先判断正在处理的是哪一类事实。

| 事实 | 权威源 | 典型内容 |
| --- | --- | --- |
| 运行时事实 | Herdr | Pane、terminal、前台进程、Agent session、Agent 状态 |
| 工作流事实 | SQLite | Binding、Prompt FIFO、控制操作、投递意图、审计、实例租约 |
| 展示事实 | Lark | 消息、话题、CardKit 卡片和外部投递结果 |
| 进程事实 | user systemd | 服务启动、停止、重启和进程守护 |

由此得到四条规则：

1. 不根据 Lark 卡片内容修复 SQLite。
2. 不根据 Herdr 事件 payload 直接修改 Binding；事件只触发一次新的 Herdr 对账。
3. Lark 投递失败只重试 outbox，不能重新执行 TraeX prompt。
4. 应用不自行管理服务进程；生命周期由 user systemd 与 `npm run swarm:*` 负责。

## 3. 分层与依赖方向

项目使用 Ports and Adapters 结构，并在应用层使用 DDD 状态机和 CQRS 风格的投影。
依赖方向始终指向领域契约。

```text
┌──────────────────────── External systems ────────────────────────┐
│ Lark / CardKit             Herdr / TraeX             user systemd │
└─────────────┬────────────────────┬────────────────────────┬───────┘
              │                    │                        │
              ▼                    ▼                        ▼
┌──────────────────── Infrastructure and adapters ─────────────────┐
│ Lark adapter · Herdr adapter · SQLite store · command runner      │
│ Socket subscriber · cache · health · lease · shutdown             │
└────────────────────────────┬──────────────────────────────────────┘
                             │ implements ports
                             ▼
┌────────────────────── Application workflows ─────────────────────┐
│ inbound routing · provisioning · prompt execution · reconciliation│
│ pane control · session administration · projection · delivery     │
└────────────────────────────┬──────────────────────────────────────┘
                             │ depends on contracts
                             ▼
┌──────────────────────────── Domain ───────────────────────────────┐
│ entities · value states · transitions · events · capability ports │
│ FIFO · no-replay · identity fences · delivery ordering invariants │
└───────────────────────────────────────────────────────────────────┘
```

`main` 是 composition root。它负责构造具体 adapter、store、workflow、event bus、
lease、health server 和 shutdown controller。其他模块不应自行读取部署路径或创建
另一套基础设施实例。

## 4. 领域模型

### 4.1 TopicPaneBinding

代码中简称 `Binding`。它表示一个受控的 Lark 话题与 Herdr Pane 的关联，而不是简单
的数据库映射。Binding 同时携带三个彼此独立的状态轴：

| 状态轴 | 值 | 回答的问题 |
| --- | --- | --- |
| Lifecycle | provisioning、active、draining、archived、closed、failed | 会话处于哪个业务阶段？ |
| Attachment | unattached、attached、degraded、orphaned | 持久化会话与 Pane 的连接是否可信？ |
| Runtime | idle、working、blocked、done、unknown | TraeX 当前正在做什么？ |

三轴组合比一个巨大的枚举更准确。例如：

- `active + attached + working`：正常执行中；
- `active + degraded + unknown`：暂时无法确认运行时；
- `active + orphaned + unknown`：Pane 已确认失联；
- `draining + attached + working`：等待当前 turn 完成后归档。

生命周期只能通过 `transitionSession` 定义的转换推进。普通 metadata 更新不得修改
lifecycle、attachment、generation 等受保护字段。

### 4.2 PromptJob、Turn 与 Steering

`PromptJob` 是一项持久化工作。它有两个 dispatch kind：

- `turn`：普通请求，在同一个 Binding 内严格 FIFO；
- `steering`：针对一个正在执行的父 Prompt，优先注入该 turn。

Prompt 的执行状态和观测状态分开记录。`observationState` 用来表达请求是否尚未开始、
仍被当前进程观察、已与观察者脱离，或已经完成。这个区分支持最重要的 no-replay
规则：一旦请求可能已送达 TraeX，bridge 就只能继续观察或标记不确定，不能自动重放。

### 4.3 PaneControlOperation 与 ModelPreference

stop 与历史 steering 操作使用持久化 Pane control queue。运行时 model selection 使用独立的
generation-scoped ModelPreference：catalog 查询和选择不写 terminal，也不占用 Pane control
队列；pending revision 在下一条普通 Prompt claim 时原子绑定。典型旧 control 状态为：

```text
accepted → running → applied → confirmed
                     ├────────→ rejected
                     ├────────→ failed
                     └────────→ uncertain
```

操作记录保留 `paneId`、`terminalId` 和 `bindingGeneration`。执行和完成回调必须同时
匹配这些身份，防止旧 Pane 的迟到结果覆盖 replacement Pane 的状态。

模型偏好使用 `pending → applying → effective`，任何可能已执行但无法确认的路径进入
`uncertain`。模型与 prompt 通过同一次结构化 `turn/start` 提交；越过 durable dispatch
fence 后不允许自动重放。

### 4.4 RunCard、TopicView 与 AnswerPage

这些对象是 projection/read model，不是和 Binding、Prompt 同层级的领域实体。

- `TopicViewState` 描述一个话题当前的主卡片。
- `RunCardView` 描述一个 Prompt 的排队、执行、输出和完成状态。
- `AnswerPage` 描述流式答案当前使用的 Lark message、CardKit card、element、source
  offset 和 sequence。

AnswerPage 的生命周期是：

```text
creating → active → frozen
                    或
                  finished
```

内容超过单卡安全上限时创建 continuation page。旧页进入 frozen 后不得再 patch；
所有 stream sequence 必须在对应 element 内单调增加。

## 5. 主要模块地图

### 5.1 接入与命令路由

`InboundRouter` 是标准化 Lark 输入的入口。它负责 allowlist、去重、持久化接收、
命令解析和 workflow 分派。它不负责真正运行 Prompt、操作 Pane 或调用 CardKit。

普通输入遵循“先记录 inbound，再接受业务工作”的顺序。进程在业务处理前退出时，
未完成的 inbound record 可以重新进入 acceptance queue。

### 5.2 Binding provisioning

`BindingProvisioningWorkflow` 负责创建、发现和重新连接会话：

- 选择项目；
- 创建或认领 Pane；
- 启动 TraeX；
- 创建 Lark topic；
- 激活 Binding；
- attach、reattach、replace；
- 恢复中断的 provisioning。

这个流程跨越 SQLite、Herdr 和 Lark，无法使用一个分布式事务。因此它以持久化
checkpoint 实现 saga 式恢复。每一步都必须可判定“已经完成”“可以安全继续”或
“结果不确定”。

### 5.3 Prompt execution

`PromptRunWorkflow` 是 Prompt 执行的唯一 owner。它负责：

- 扫描持久化 work；
- 为每个 Binding 启动至多一个普通 turn worker；
- 原子 claim 下一条 FIFO Prompt；
- 管理当前 `TurnSupervisor`；
- 执行 steering；
- 恢复 detached observer；
- 完成、失败或归档 draining Binding。

内存 worker 只负责执行。真正的互斥和可恢复 claim 存在 SQLite 中，因此重启不会
把内存状态误当成业务事实。

### 5.4 Runtime reconciliation

`HerdrRuntimeReconciler` 是运行时事实进入领域状态的唯一收敛路径。它：

1. 获取权威 Herdr snapshot；
2. 限定到配置允许的 workspace；
3. 检查 Pane、terminal 和 native Agent session identity；
4. 应用 generation 和 identity fence；
5. 必要时读取经过裁剪、清洗和脱敏的终端输出；
6. 原子更新 Binding observation 和 output checkpoint；
7. 发布 lifecycle event，并在确有 durable work 时发出 wake-up。

Socket event 和周期任务都只请求 reconciliation。丢失一个事件会
增加延迟，但不会改变最终状态。

### 5.5 控制、管理和查询

| Module | 职责 |
| --- | --- |
| `PaneControlWorkflow` | stop、steer、model control queue 的唯一 owner |
| `ModelSelectionWorkflow` | model/mode 交互状态机、超时和恢复 |
| `PaneClosureWorkflow` | 带二次确认的破坏性 Pane 关闭 |
| `SessionAdministrationWorkflow` | status、rename、archive、resume |
| `OperationsQueryWorkflow` | spaces、sessions、failures 只读查询 |
| `DeliveryRecoveryWorkflow` | 打开话题以及 retry/dismiss dead letter |
| `RetiredPaneCleanupWorkflow` | replacement 后旧 Pane 的持久化清理流程 |

这些 workflow 分离了查询、可逆管理、运行中控制、破坏性操作和 delivery recovery。
新增行为应进入最接近其业务能力的 workflow，而不是继续扩大 router。

### 5.6 Projection 与 Lark delivery

`ConversationViewProjector` 消费 lifecycle event，通过纯 reducer 更新 TopicView 和
RunCard，再记录 outbound intent。卡片 renderer 只处理展示，不决定生命周期。

`LarkOutboxDispatcher` 从 SQLite 读取 durable outbox，并负责：

- Card reply、update、stream create、stream content 和 stream finish；
- transient retry 和指数退避；
- permanent failure 和 dead letter；
- 成功投递后的 message/CardKit/page checkpoint；
- 每条 target lane 内严格串行，不同 lane 之间有限并发。

### 5.7 SQLite transaction owner

`SqliteBindingStore` 同时实现多个 capability-focused store port，但只有它拥有底层
SQLite transaction。它负责的不是简单 CRUD，而是业务原子转换，例如：

- 接受 Prompt 时同时创建 Prompt、RunCard、AnswerPage 和初始 outbox intent；
- 完成 Turn 时同时更新 Prompt、Binding 和终态 read model；
- 完成 Pane control 时同时保存结果状态和结果卡片 intent；
- Lark 投递成功时同时推进 outbox 与对应 delivery/page checkpoint。

可以继续缩小调用方看到的 port，但不能为了“按表分 repository”而拆散这些事务。

### 5.8 Adapters 与运行时模块

- `HerdrCliAdapter` 隔离 CLI/Socket、数据校验、运行时观察和兼容 fallback。
- `LarkSdkAdapter` 隔离 SDK、事件标准化和 CardKit transport。
- `WorkspaceSnapshotCache` 合并短时间内重复的 snapshot 请求。
- `HerdrSocketSubscriber` 通过原生 Socket event 提供低延迟 wake-up；周期对账负责兜底。
- `InstanceLeaseController` 保证只有一个实例可写同一数据库。
- `BridgeRuntimeShutdown` 按依赖顺序停止 ingress、workflow、projection、delivery 和 store。
- health server 区分进程存活、依赖就绪和脱敏后的运行状态。

## 6. 三条核心链路

### 6.1 普通 Prompt

```text
Lark event
  → normalize and allowlist
  → durable inbound record
  → InboundRouter
  → atomic Prompt + RunCard + AnswerPage + outbox acceptance
  → prompt-ready wake-up
  → PromptRunWorkflow atomic claim
  → Herdr runPrompt
  → runtime observations and lifecycle events
  → view projection
  → durable outbox
  → ordered CardKit delivery
  → delivery/page checkpoint
```

### 6.2 Herdr 状态变化

```text
native Socket event / periodic timer
  → invalidate relevant snapshot cache
  → request reconciliation
  → fresh Herdr snapshot and targeted observation
  → identity-fenced SQLite transition
  → lifecycle projection and optional work wake-up
```

事件只降低收敛延迟。即使所有事件丢失，周期 reconciliation 仍应得到相同终态。

### 6.3 Lark 投递失败

```text
outbox lane head
  → target validation
  → Lark request
       ├── success   → delivered checkpoint
       ├── transient → scheduled retry
       └── permanent / exhausted → dead letter
```

任何分支都不会重新触发 Prompt。用户或自动恢复只能改变 delivery intent 的状态。

## 7. 事件、通知和持久化的区别

项目中有三种容易混淆的异步信号：

| 类型 | 是否持久化 | 用途 | 丢失后的结果 |
| --- | --- | --- | --- |
| Lifecycle event | 否，进程内 | 通知 projection 业务结果 | startup convergence 从 durable state 补齐终态展示 |
| Workflow wake-up | 否，进程内 | 提醒 worker 重新读取 durable work | 周期扫描或下一次事件重新唤醒 |
| Lark outbox row | 是 | 表达必须执行的外部投递 | 重启后继续 retry 或进入 dead letter |

必须遵守 durable-before-wake：

1. 先提交 SQLite 状态；
2. 再发 scoped wake-up；
3. 不假设 wake-up 一定被消费。

`lifecycle_events` 和进程内 event bus 都不是完整 Event Store。当前系统属于状态持久化
加可重建投影，不属于 Event Sourcing。

## 8. 一致性和并发机制

### FIFO 与单 turn

每个 Binding 至多有一个普通 turn 处于执行状态。后续普通 Prompt 留在 SQLite FIFO。
不同 Binding 可以并行执行。

### No-replay

worker 先在 SQLite 中原子 claim Prompt；adapter 在确认提交动作已经发生，或错误语义
无法排除已经提交时，记录 dispatched checkpoint。此后的异常会让 Prompt 转为
detached observation，而不是回到 queued。

### Identity fencing

运行时 observation 和 control result 必须匹配预期的 Pane、terminal 和 Binding
generation。迟到的旧结果不能推进当前 Binding。

### Instance fencing

进程启动时获取 SQLite lease 和 fencing token。租约丢失会触发 shutdown；旧实例失去
写权限，避免两个进程同时调度同一份 durable work。

### Outbox ordering

每个 outbound target 都有稳定 lane。只有 lane head 可以投递；失败的 head 只阻塞自己
的 lane。这个规则同时提供 CardKit sequence 顺序和跨卡片并行。

### Projection recovery

终态 Prompt、Binding 和 read model 持久化后，即使进程在 lifecycle notification 与
outbox 写入之间退出，startup convergence 也会比较 view/delivery version 并补建缺失
intent。

## 9. 如何放置新功能

使用下面的判断顺序：

1. **是否是纯状态转换？** 放入 domain transition 或 reducer。
2. **是否是一个用户用例？** 放入 capability-focused workflow。
3. **是否访问 Herdr、Lark、SQLite 或操作系统？** 通过 port，在 adapter 中实现。
4. **是否改变多个 durable record？** 在 SQLite store 提供一个原子 transaction method。
5. **是否只是通知 worker 检查状态？** 使用 wake-up，不把 payload 当事实。
6. **是否产生用户可见结果？** 先写 outbound intent，再由 dispatcher 投递。
7. **是否只是展示变化？** 修改 projection/reducer 和纯 card renderer。

举例：

- 新增 `/swarm pause`：先定义业务语义和状态转换，再增加 workflow；router 只分派。
- 新增 Herdr observation 字段：adapter 负责标准化，reconciler 负责应用，projection 决定展示。
- 新增卡片按钮：card renderer 产生 action，router 校验 action，具体决策进入对应 workflow。
- 新增投递类型：扩展 outbox kind、lane/target validation 和 Lark adapter，不从 workflow
  直接调用 SDK。

## 10. 修改前检查清单

### 工作流与持久化

- 是否先持久化 intent，再触发外部副作用？
- 重启后能否区分“未开始”和“可能已执行”？
- 多行状态变化是否在同一 SQLite transaction？
- 重复消息、重复 action 和重复 wake-up 是否幂等？

### Herdr 与并发

- 是否通过 fresh observation 验证 Pane，而不是信任事件 payload？
- 是否校验 pane、terminal、session 和 generation？
- 是否保持每 Binding 单 ordinary turn？
- 不确定 dispatch 是否保持 no-replay？

### Lark 与 CardKit

- 是否通过 durable outbox 投递？
- target lane 和 idempotency key 是否稳定？
- AnswerPage 冻结后是否仍可能被 patch？
- sequence 是否只在对应 CardKit element 内递增？

### 安全与运维

- 是否保留 configured-chat 和 user-originated allowlist？
- 日志、错误和终端输出是否经过脱敏？
- 是否意外增加了远程审批或高风险控制能力？
- shutdown、lease loss 和恢复路径是否仍然可收敛？

## 11. 当前架构演进方向

当前结构已经形成稳定的领域和应用边界。后续演进应优先加深现有模块，而不是增加
更多薄包装层：

1. 使用结构化 Pane/Workspace identity，消除对复合 Pane ID 格式的推断。
2. 用 composition-root 级 deadline 或 `AbortSignal` 协调 shutdown。
3. 将 Herdr timeout、fallback、退避和 circuit protection 收敛为一个深模块。
4. 仅把确实需要运维调节的 poll、debounce 和 size limit 放入验证配置。
5. 继续收窄 workflow 所见的 store port，同时保留跨表事务的单一 owner。
6. 明确哪些 projection 必须事务内生成，哪些允许由 startup convergence 重建。

判断一次重构是否改善架构，可以使用三个问题：

- 删除这个模块后，复杂度会消失，还是扩散到多个调用者？
- 调用者需要知道多少内部顺序、错误和一致性细节？
- 能否只通过模块接口测试完整业务行为？

复杂度被隐藏、规则更集中、调用者知识更少，才是更深的模块。

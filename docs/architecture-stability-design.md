# 消息系统架构稳定性：优化方案、设计与测试

## 1. 交付范围与结论

读者：负责 Herdr Agent Swarm 持久化、卡片投递和部署的维护者。读完后应能按本文的分阶段变更和验收标准实施优化，而不改变 Prompt 的执行安全边界。

基线：`c501b7e`（2026-09-11）。本文保留完整目标设计及各阶段当时的验证快照。稳定性、恢复证据、Worker Session、生命周期与性能 HIGH/P0 实现已提交为 `b614527`；迁移仅在测试库验证，尚未安装、重启或写入线上数据库。当前源码行为以 [architecture.md](architecture.md) 为准，实施范围和历史验证见第 8 节。

推荐保持单服务、SQLite、用户 systemd 和 Herdr 权威模型。先修复投递确认正确性，再修复重启幂等性与恢复证据，最后做调度、限流和性能优化。无需现在引入 Redis、Kafka 或拆分微服务。

成功标准分为两层：

- 当前切片：只确认领取并实际发送的版本；旧尝试回执不能确认新尝试；未变化 Answer 快照不重新入队；不确定本地检查点保留 claim；用正向测试验证，而不是将现状复现测试通过误报成缺陷修复。
- 全部实施后：恢复成功必须有成功投递证据；同 lane 顺序保持；独立 lane 不因整批等待而浪费空闲名额；增量启动、全局限流和端点不确定性策略全部验证；不导致 Prompt 重放。

## 2. 问题清单与证据

以下定位均相对基线提交；行号是本次审查定位，不是永久接口。

| 优先级 | 问题 | 实现证据 | 影响与验证 |
| --- | --- | --- | --- |
| P0 | 请求在途时可以覆盖同一 pending 行，成功回执按 ID 读取更新后的行 | `src/store/sqlite/outbox-queue-store.ts:53-62`；`src/events/outbound-delivery-executor.ts:51-58`；`src/store/sqlite/outbox-delivery-store.ts:25-43` | 外部只收到 v1，SQLite 却记录 v2 delivered，丢失最新投影；R7 已复现 |
| P1 | 静态/关闭卡片已 delivered 后仍无条件重新入队 | `src/store/sqlite/projection-store.ts:208-250` | 重复 convergence、启动遍历可能制造无变化投递；R1 已复现静态分支；关闭分支代码审查确认，实施时补直接测试 |
| P1 | final-fold 的旧 dead letter 被重新置 pending 并清除错误，未检查是否同一被拒绝内容 | `src/store/sqlite/projection-store.ts:184-203` | 重启绕过重试上限，审计丢失；R2 已复现 |
| P1 | 相同 final payload 仅因 viewVersion 增加就重新发送 | 同上 `:194-198`；`src/coordinator/startup-view-converger.ts:84-90` | 非可见字段变化也增加历史补发；R3 已复现。不能仅凭本测试断言此前 1,279 条均由该路径产生 |
| P1 | 没有 successor 也写 released_newer_snapshot，统计立即排除该失败 | `src/store/sqlite/outbox-recovery-store.ts:67-71`；`src/store/sqlite/operations-store.ts:29` | lane 放行被误当投递恢复，最新卡片仍可能缺失；R4 已复现 |
| P1 | quarantine 以 lane 为键覆盖，历史恢复事实不稳定 | `src/store/sqlite/outbox-recovery-store.ts:71` | 后一次失败覆盖前一失败指针，unresolved 计数重新增加；R5 已复现 |
| P1 | Promise.all 整批屏障阻止空闲槽位补入新任务 | `src/events/lark-outbox-dispatcher.ts:160-183` | 同批一个慢请求拖住已释放名额；R6 已复现 |
| P2 | interactive 仅按消息 kind 选取 | `src/store/sqlite/outbox-queue-store.ts:107-113` | 当前 Main/静态 Answer 的 card_update 不受保护，历史 create 反而占用交互配额；已有优先测试只覆盖预先入队的 Answer create |
| P2 | 每次启动全量遍历 binding/run cards，缺少持久的候选扫描与分页 | `src/coordinator/startup-view-converger.ts:64-90` | 历史规模决定启动成本；尚未做生产规模压力验证 |
| P2 | 重入队保留原 created_at，stalled 使用该时间 | `src/store/sqlite/projection-store.ts:197`；`src/store/sqlite/operations-store.ts:52-63` | 刚重建的投递可立即被计算成数天停滞 |
| P2 | Retry-After 只约束单行；业务拒绝缺少端点语义 | `src/store/sqlite/outbox-delivery-store.ts:140-144`；`src/events/delivery-error-classifier.ts` | 同一额度下其它 lane 继续碰限流；230028 重试无助修复内容。未实测上游额度范围，不能臆定所有端点共用额度 |

此前会话观察到 pending 从 1,279 降到 0，同时 delivered 增加，因此不能把那批工作简单称为“卡死”。此前最后三个 pending 是重试中的 230028 更新，**并不是**三个 active quarantine 的 successor；后者是独立的历史 card_reply 失败。本文未重新读取线上状态，也不把历史数字当成当前监控值。

230099 的准确含义必须由请求端点与业务响应判定。不能把历史 card_reply 的 HTTP 400/230099 一律认定为可通过重建 Main Card 修复的锁定错误。

## 3. 方案取舍

| 方案 | 收益 | 代价/不足 | 选择 |
| --- | --- | --- | --- |
| A. 只修统计与增加重试 | 小改动、短期减少告警 | 无法消除错误确认、重复补发，可能隐藏真实失败 | 不采用 |
| B. 单服务内强化投递快照、检查点和恢复事实 | 保留部署模型；能用 SQLite 事务验证正确性 | 需要增量 schema 和跨 store/executor 的接口修改 | 推荐 |
| C. 引入外部消息队列/多个投递进程 | 可独立扩容 | 仍需快照身份与幂等协议；增加跨系统一致性、迁移和运维复杂度 | 暂缓，只有测量证实单节点瓶颈后再评估 |

不变边界：Herdr 管运行时身份；SQLite 管工作流、投递意图和 lease；Lark 只管可见输出。不得从卡片推断任务状态。所有恢复仅影响投影和投递，不访问 Prompt submit；不新增远程审批或任意终端控制。

## 4. 目标设计

本节描述完整目标协议，不等同于已实现接口。当前切片沿用一般意图的版本化 key，仅给 static/closed/final Answer 增加递增 revision；尚无独立 projection checkpoint；已实现按失败 revision 保存的 recovery ledger 子集。无法证明 HTTP 未开始的旧 owner claim 一律隔离，不自动恢复发送。端点级超时不确定性仍由后续阶段实现。

### 4.1 不可变投递版本与在途确认（阶段 A，P0）

分开三件事：desired projection（当前想展示什么）、delivery revision（某次已冻结的发送内容）、delivery checkpoint（外部确认了什么）。

在现有 outbound_replies 上增加单调的 `snapshot_revision`、`payload_hash`、`claimed_fence`、`claim_attempt_id`、`claimed_at` 和不可清除的 `first_claimed_at`。同一逻辑投影用稳定的 projection_key；每个真正不同的可见快照或物理目标分配递增 revision，idempotency key 包含 projection_key/revision。hash 只用于比较内容，不独自充当版本：A→B→A 必须生成第三个版本，不能误命中第一个已 delivered 的 A。

- 事务 claim 只允许当前 lane head、due、无 active claim 且当前 lease fence 有效的行；返回包含 ID/revision/hash/fence/attempt ID 的冻结投递凭据。每次重试生成新的 attempt ID，同一 lease 下的旧尝试也不能确认新尝试。
- claim 后 payload、intent、target、renderer revision 和 sequence 都不可修改。新状态单独追加 successor；只能合并 first_claimed_at 为空、attemptCount=0、未存 card checkpoint 的可替换 successor。
- 请求明确结束后，失败事务写入该次尝试结果并清除 active claim；可重试行保留同一不可变 revision、幂等键和 first_claimed_at，到期再 claim。超时但效果不确定的请求按下述 uncertain 规则处理，不进入普通释放重试路径。
- enqueue 同 key 但不同 payload 必须返回明确冲突，不再静默覆盖。所有调用方（包括 static/final card reservation）同时迁移，不能只修通用 enqueue。
- markDelivered、markFailed、checkpointCard 都以凭据比较并更新；只有成功匹配的回执才能更新页面/TopicView 检查点和发出 checkpoint hint。失效回执只做有界审计。
- claim/确认/释放与 lane head 更新必须同一 SQLite 事务；保持一个 lane 最多一个在途外部效果。
- 重启仅在新进程获得 lease、确认旧 owner 已退出之后回收旧 fence 的 claim。不因本地超时就释放一个尚未终止的 HTTP 请求。

崩溃窗口：

1. claim 后、HTTP 前：可以用相同 intent 恢复投递。
2. CardKit create 成功、引用消息前：先保存 card_id_checkpoint，再发送引用；checkpoint 已持久化时重启复用 entity。create 成功但 checkpoint 未落库属于下一项的不确定窗口。
3. HTTP 成功、SQLite 确认前：外部结果不确定。使用原幂等键/sequence；若端点幂等窗口不足或语义未知，保留 uncertain 等待可证明的恢复，不宣称 exactly-once。
4. 旧进程回执晚到：fence/revision 检查失败，不覆盖新检查点。

上述回收针对 Lark delivery，不针对 TraeX Prompt。Prompt 的不重放协议不变。

### 4.2 幂等投影与增量启动（阶段 B，P1/P2）

新增按投影身份保存的 checkpoint（建议表 `card_projection_delivery`）：

- projection_key 是逻辑身份：卡片 family + binding/worker generation + prompt/turn + 逻辑 page；不能跨 generation 或不同内容页比较。
- target_incarnation 单独标识物理投递目标，关联实际 message/card/element。create 前预分配 incarnation，拿到 cardId 后以 checkpoint 绑定，不改变已 claim 的 intent；后续 update 使用已绑定目标。重建物理卡片分配新 incarnation。
- desired_revision/hash、confirmed_revision/hash、renderer_revision、dirty_since、last_confirmed_at；确认记录同时保存 target_incarnation。
- 内容 fingerprint 基于确定性序列化的实际可见 payload、target_incarnation 和 renderer revision。相同可见内容不因非可见 viewVersion 更新触发发送；目标重建不能复用旧目标的成功回执。
- 相同 desired hash 已 confirmed：no-op；相同 revision pending/claimed：waiting；相同失败 revision：保持 dead_letter。新内容生成新 intent，保留旧错误证据。
- manual retry 明确授权同 revision 重试，并单独记录尝试历史；启动不会隐式变成 manual retry。
- finished 页可按新可见快照更新；frozen 页不被刷新。冻结前必须完成所需 final snapshot，失败则保留恢复 obligation，而不是静默跳过 finalization。
- 不改变 canonical Answer、source_start、9,000 字符页面规则或按 element 递增的 CardKit sequence。

checkpoint 不随 outbox 历史裁剪删除，否则裁剪后下一次启动又认为未投递。终态卡片只在真实投影变化或缺失 checkpoint 时进入候选集。

启动扫描由 StartupViewConverger 读取索引支持的 dirty/missing/recovery candidates，游标分页每批 100，并在批间 yield；main/current 策略先行、历史 renderer upgrade 后台进行。错误候选保留可重扫状态，不能仅 warning 然后永远丢失；readiness 区分核心恢复完成与后台历史修复，不等全部历史补发。

### 4.3 恢复义务独立于 lane quarantine（阶段 C，P1）

quarantine 仍只回答“这个 lane 能否调度”；不要让该可覆盖索引同时承担历史恢复账本。

新增 `delivery_recoveries`，每个 failed revision 一条稳定记录：failed_reply_id/revision、projection_key、failure code/class、action、state、replacement_reply_id/revision、created_at/resolved_at、resolution_reason。state 为 `unresolved | replacement_pending | recovered | dismissed`。

- rebuild_answer：事务记录 unresolved obligation + 冻结旧页；投影保留 dirty。创建 successor 后原子链接 replacement_pending；即使 wake 丢失或进程崩溃，durable candidate scan 也能继续。
- rebuild_main：创建 replacement intent 与 obligation/link 同事务，旧 message pointer 保留到成功投递。
- released_newer_snapshot：只是放行策略。没有 successor 时仍 unresolved；successor 在途/失败仍不能记 recovered。
- recovered：必须有同一逻辑投影身份下满足 desired revision 的**已确认可见快照**。Answer 的静态 create 不保证包含后续全部内容，需对应最终内容检查点而非仅拿到 cardId。
- 跨卡片恢复显式保存旧/new target_incarnation 的替代关系，并校验逻辑投影与 generation。若 Answer 重建同时更换物理 pageIndex，还须记录旧投影到新投影的替代映射和 canonical source 范围，确认新快照覆盖旧义务要求的内容；不同逻辑页之间不能仅比较 revision 大小。
- replacement 再失败：追加其独立失败记录，原 obligation 仍待恢复；更高成功快照可以一次解决同一逻辑投影的更低失败版本。旧实体被证明由新实体取代后才能关闭旧义务，不靠 lane 字符串猜测。
- manual dismiss：经现有授权路径处理，记 dismissed 与操作者；无 successor 的 immutable 通知保持人工处理。

迁移只从 SQLite 中明确 delivered 的同身份 successor 回填 recovered。无法证明的历史 released 项保留 unresolved/legacy reason，不通过猜测把健康刷绿。不将 91 或 3 等历史统计写死到迁移。

### 4.4 有界、公平的投递执行（阶段 D，P1/P2）

保留总并发 4，用 work-conserving pump 替换 Promise.all 批次屏障：每个完成事件释放一个名额并立即扫描；active lane set 排除在途 lane。独立慢请求不影响已空闲的其它名额。单 lane 顺序仍来自 SQLite，而非 JavaScript Promise 的到达次序。

持久记录 work_class（live/history），由投影来源和任务状态决定，不只看 kind。当前 Main、静态 Answer、互动回复均可 live；历史修复即使是 create 也属于 history。

在两类都有 due 工作时按 3 live : 1 history 的 dispatch 配额选取，类内按 eligible_since/order；一类为空则另一类使用全部空闲资源。新 live 到达时不取消已开始的 history；下一个空闲名额即可选取。用固定调度次数而非网络时长证明无饥饿；网络不挂起时再测延迟目标。

每 100 次 claim yield；lane 不前进检测继续保留。关闭时停止 claim、等待已启动效果结束；未结束 writer 保持 lease，不另开服务强抢所有权。

### 4.5 错误语义、速率和安全（阶段 E，P2）

- transport timeout/连接故障与 HTTP 429：有界退避；只有确认端点返回的 transport 状态可信时才分类。
- CardKit 300309/300317：限定操作类型和目标身份，走语义恢复，不在 classifier 中把 300317 的含义扩大为任意 card_reply 重建。
- 230028：内容审核拒绝，不对同 revision 自动重试，也不改写内容以绕过审核；保留脱敏错误，等待内容修正或授权人工处置。
- 230099：端点特定处理，card_reply 不套用 Main Card update 的恢复策略；需要请求类别和安全错误摘要。
- 单行退避保留；429 新增被文档确认的 app/endpoint quota scope 的 cooldown（bounded Retry-After，最长一小时），持久到 SQLite 避免重启消失。未知 scope 保守使用 app 级 cooldown，暴露过度抑制指标，不虚构上游额度。
- 在 cooldown 内不 claim 该 scope；其它 scope 和本地接收/持久化继续工作。恢复时使用 jitter 避免所有 lane 同时重试。
- 日志不输出 payload、prompt 或 SDK 原始 config/request。结构化字段包括 replyId、projection_key 摘要、revision、recoveryId、safe code、claim fence、attempt；错误描述按现有 redaction 截断。

### 4.6 健康、延迟与规模

/status 分离历史数量、待投递、in-flight、retry_wait、active lane quarantine、unresolved recovery、replacement_pending、recovered、manual dismiss。只有 current unresolved、超时待恢复、due lane 真停滞、系统依赖错误导致 degraded；历史 resolved 不降级。未解决 immutable 通知仍明确列为需人工关注，不因 pending=0 自动宣布“所有消息正常”。

stalled 使用当前 revision 的 eligible_since/last_progress_at，不用十天前的初始 row.created_at。保留历史 created_at 作为审计时间。先设置当前兼容阈值 300 秒，再根据负载校准。

端到端投递延迟以终态可见内容的确认时间计算，兼容 static/final card，不仅统计 stream_finish。报告每类 p50/p95/p99、窗口样本数、backlog growth、恢复持续时间；指标缺样本返回 null，不当作零延迟。

使用索引查询、分页和短 TTL 缓存统计，避免每个 /status 都全表 GROUP BY。先在 1,500 个终态投影、10,000 条历史 outbox 的临时库测量，并保存 EXPLAIN QUERY PLAN、样本大小和耗时；不能先加索引再凭感觉声称快。

## 5. 实施切片、接口边界与依赖

| 阶段 | 修改边界 | 前置 | 完成条件 |
| --- | --- | --- | --- |
| A | delivery contracts、queue/delivery store、executor、SQLite schema、Worker/Primary reservations | 无 | R7 转为正向防丢失测试；claim/ack fence 和故障窗口测试通过 |
| B | projection store、Answer/Main workflow、startup candidate store、retention、schema | A | R1/R2/R3 转为 no-op/保留错误测试；重启与裁剪测试通过 |
| C | recovery store/ledger、delivery checkpoint transaction、operational summary、health | A/B | R4/R5 转为有证据恢复测试；替代失败和多代恢复测试通过 |
| D | dispatcher pump、lane selector、work class、shutdown | A | R6 转为立即补位测试；顺序、并发上限、公平性全部通过 |
| E | classifier、Lark adapter safe normalization、quota cooldown、metrics | A/C/D | 429 跨 lane/重启、230028 单次拒绝、日志脱敏和性能测试通过 |

每个阶段独立测试和提交，由用户明确授权提交/发布；不把全部修改一次性部署。schema 采用有序 additive migration，生成代码不手工编辑。变更都经过领域 ports；coordinator 不绕过 outbox 直接发卡，store 不 import executor。

## 6. 测试矩阵

### 6.1 基线复现与当前正向回归

以下测试使用临时/内存 SQLite 和 fake Lark，不发送真实消息。表中“基线结果”保留原始缺陷证据；R1–R7 均已转为正向断言。R4/R5 的验证范围是同目标快照及明确链接的 Main rebuild；跨 Answer 页的单静态替代证明见第 8.5 节。

| ID | 测试位置与基线检索名称 | 基线结果 | 正向断言目标 |
| --- | --- | --- | --- |
| R1 | answer-page-workflow.test.ts / unchanged delivered static | 相同 ID/payload 再 pending | confirmed 后重复 converge 不新增/重开 intent |
| R2 | answer-page-workflow.test.ts / unchanged rejected final | 错误和重试次数被清空 | 相同拒绝快照仍 terminal，错误审计不变 |
| R3 | answer-page-workflow.test.ts / identical final payload | 仅 viewVersion 增加也再 pending | 相同可见 hash no-op，真正新内容才创建 revision |
| R4 | sqlite-store.test.ts / without any successor | pending=0，失败却从 unresolved 消失 | unresolved 保持；没有 replacement 不得 recovered |
| R5 | sqlite-store.test.ts / overwrites the lane quarantine | 第二次失败覆盖指针，计数重新增加 | 每失败有稳定 ledger，计数不依赖最新 lane 指针 |
| R6 | lark-outbox-dispatcher.test.ts / free slot | 只剩一个慢请求仍不启动新 interactive | 空闲槽位立即接新 live，不等待慢请求 |
| R7 | lark-outbox-dispatcher.test.ts / newer payload than the one sent | fake 收 v1，库写 v2 delivered | v1 ack 仅确认 v1，v2 保持可调度并实际投递 |

运行命令：

```sh
npx vitest run tests/answer-page-workflow.test.ts tests/sqlite-store.test.ts tests/lark-outbox-dispatcher.test.ts
```

### 6.2 完整实施验收矩阵（当前切片尚未全部覆盖）

| 门禁 | fixture / 注入点 | 必须断言 |
| --- | --- | --- |
| A1 | v1 HTTP 被 gate 挂起，期间入 v2/v3 | 外部请求与每个 confirmed revision 精确对应；合并不删除 claim head |
| A2 | claim 前后、HTTP 后 ACK 前断开临时库/重开 store | 只按原 intent 恢复；旧 fence 回执无效；Prompt submit 计数不增加 |
| A3 | create entity 成功后 reference 失败，重启 | 已持久化 checkpoint 时复用 entity；仅在已验证幂等窗口内断言引用不重复；HTTP 成功但 checkpoint 未写或端点能力未知时保持 uncertain，不盲目重发 |
| B1 | 1,500 finished cards + 1 dirty live card，重复启动 3 次 | 无变化历史 intent=0；恰好当前 dirty intent；Prompt 数量、状态和 dispatch 次数不变 |
| B2 | delivered outbox retention 后重启 | checkpoint 尚存，终态不复活；missing/dirty 可恢复；frozen 页不写 |
| B3 | 同 hash/different version、different hash/same version、A→B→A、renderer upgrade | 稳定 hash no-op；新可见内容获得新 revision；不复用历史 A 的 receipt |
| C1 | rebuild 已预约、replacement pending/failed/delivered | 前两态仍未恢复；只有 delivered proof 才 recovered |
| C2 | 同 lane 连续失败，replacement 跨 card，随后 retention | 每条 ledger 仍可查；恢复链不回环；不能跨 generation 误解决 |
| C3 | active immutable quarantine、manual retry/dismiss | 正确权限、审计和 lane head；不自动丢弃、不提交 Prompt |
| D1 | 4 并发，其中 1 慢 3 快，然后新 live 到达 | 实际并发≤4、同 lane≤1；下一空闲槽位开始 live |
| D2 | 持续 live + 1,500 history | 两类均 due 时每 4 次 dispatch 至少一次 history；live 占多数；类内 FIFO |
| D3 | drain 中 shutdown + write fence loss | 停止新 claim，已启动请求有界结束；lease 安全规则不削弱 |
| E1 | 多 lane 同 quota 429、另 quota 正常、重启 | cooldown 未到不调用该 quota；另一 quota 可进展；有界 Retry-After |
| E2 | 230028、各端点 230099、300309/300317、网络超时 | 明确 retry/rebuild/manual 分类；未匹配目标不得错重建 |
| E3 | 旧 created_at、新 eligible_since；static final 完成 | 不立即 stalled；真实停滞到阈值才告警；延迟包含 static |
| E4 | 10,000 历史 + 1,500 终态，fake API 10ms | 报告启动、内存和 loop delay；live 排队 p95 目标<250ms，非生产 SLA；确认走候选索引 |

现有 no-replay、exact-turn fencing、跨重启分页、lease 和 shutdown 测试继续全量运行。现有测试成功不能替代 A1–E4。

## 7. 部署和回滚门禁

1. 本地 focused tests、architecture:check、typecheck、build、完整 npm test 通过；阶段对应正向验收测试全部通过。
2. 用临时旧 schema fixture 验证迁移、二次启动幂等、checkpoint retention 与恢复 ledger；不要拿在线数据库做试验。
3. 用户授权后，swarm:status 检查 active prompt/worker/outbox；不把旧的 force 授权沿用到新发布。
4. ./install.sh 安装不可变 release，再通过标准安全门重启。核对 expected/observed build、PID/listener ownership、readiness、startup recovery 和 SQLite integrity。
5. 非变更的重启必须不重新预约终态投影；一次真实 live 消息正常投递、无 Prompt 重放；需要发消息的在线验证另获授权。
6. 回滚只用明确兼容新 schema/claim 协议的 release。不能直接将旧进程指向新增 claim/ledger 的数据库；先停服务并保留一致 SQLite backup（含 WAL 的正确备份语义），不能复制孤立 db 文件。
7. 不为健康变绿清库，不自动 dismiss 不明失败，不通过内容变形规避飞书审核。

## 8. 验证记录与完成审计

### 8.1 已实现的首个 P0 切片

- `OutboundDeliveryClaim` 携带冻结 row、attempt ID、lease fence、payload hash 和 snapshot revision。executor 在发送前领取 fresh lane head，ACK/failure/card checkpoint 通过凭据做事务校验；同一 lease 的旧尝试也不能确认新尝试。
- SQLite 保护已领取行的内容、目标身份、序列、revision 和 first-claim 标记；active claim 禁止删除并阻止同 lane 后继发送。已领取、尝试过或持有 card checkpoint 的行不被 coalescing 删除。在途 Worker Main create 保留当前内容，新 desired view 等待后续 convergence。
- 对已经尝试的 pending key 写入不同发送内容会报 `outbound_idempotency_conflict`。这不是全局严格 key 协议：terminal key 仍保留旧有 dedupe 语义，完整逻辑/物理身份冲突校验留待扩展。
- static/closed/final Answer 比较序列化 payload；相同内容不因 viewVersion 增长或重复 convergence 重开。不同内容追加 revision，A→B→A 不复用旧回执；旧拒绝证据保留，最新 final revision 决定投递事实。冻结页不新建 final patch，失败的 static replacement create 不自动重开。
- retention 保留最新 numbered Answer revision 作为临时去重检查点；旧 delivered/dismissed revision 仍可裁剪，active claim 不裁剪。尚未新增独立 checkpoint 表。
- 外部成功但本地 ACK/card checkpoint 失败时报告 `outbound_checkpoint_uncertain`，不作为普通失败释放重试。仍在途的 claim 保留并阻塞 lane；新 owner 激活 fence 后把不匹配 owner/token 的遗留 claim 标记为 unknown dead letter 和 active blocked quarantine，保留 payload/card checkpoint，并清除过期的 quarantine release 标记。
- claim 本身不能证明 HTTP 是否开始，因此 owner 丢失后即使可能停在 HTTP 前也保守隔离；没有实现可证明安全的自动重投。已经退役的行收到匹配回执，只释放 claim，不推进投影。所有路径保持 Prompt 不重放。

### 8.2 验证记录

2026-09-11 最新本地结果（覆盖收尾审查修正）：

| 检查 | 结果 | 证据与边界 |
| --- | --- | --- |
| 完整 npm test | 161 个文件、2,000 个测试通过，0 失败 | 14:15:39 开始，Vitest 耗时 16.41 秒 |
| architecture:check | 通过 | 检查 290 个源码文件的 import 边界；测试 fixture 适配器未污染 production capability 或 test kernel |
| npm run typecheck / npm run build | 均通过 | build identity 为 sha256:69f185904011cd6e6c6ffc9b17f780a48ac2d5b01eed3e8b67aed961da76c2e0 |
| 正向回归 | R1/R2/R3/R7 及 claim 边界通过 | v1/v2 实际发送、A→B→A、陈旧 ACK/failure/checkpoint、SQL 防变更/删除、owner-loss 重开库、lease loss、退役在途回执、外部成功后本地 ACK 失败 |
| 迁移与保留 | 现有迁移/no-op reopen 测试及新增 checkpoint/revision 测试通过 | 临时 SQLite；不等于全部 A1–E4 验收或生产规模压测 |
| 变更范围 | 生产源码、测试与文档 | 已提交；未安装、重启或写入线上数据库；无真实 Lark 投递/UI 验证 |

设计阶段曾有 1,992 项通过的基线记录，该数字已被上述最新回归取代。上述记录属于首个 P0 切片；随后 R4/R5 和 R6 已转为正向测试，最新结果见第 8.4–8.6 节。

### 8.3 剩余工作与部署边界

- [x] 完成首个 P0 投递冻结/确认切片及部分阶段 B 的 Answer 幂等快照；源码架构说明和 README 已同步。
- [x] 阶段 A 的外部效果不确定性首片：请求/响应超时、连接重置和缺少 pre-send 证据的 transport 失败进入 durable uncertain quarantine，不再自动重试；DNS、连接拒绝和 connect timeout 仍可重试。端点特定查询/调和仍未实现，不能宣称 exactly-once。
- [ ] 阶段 B：独立 projection checkpoint、target incarnation、增量启动候选、renderer 升级和规模测试。
- [x] 阶段 C 首片：独立 recovery ledger、同目标快照和明确 Main rebuild 的成功证据，修复 R4/R5。
- [x] 阶段 C 次片：关闭的 Primary Answer stream 到单个静态替代页的内容覆盖证明，见第 8.5 节。
- [ ] 阶段 C 剩余：跨多页覆盖合并、多代替代链、变更源内容的协调、Worker 覆盖证明、候选重扫、ledger 保留策略及 current/historical 健康分类。
- [x] 阶段 D：移除整批 Promise.all 屏障、公平补位、持久化 live/history 工作分类与 3:1 配额，修复 R6，见第 8.6 节。
- [ ] 阶段 E：端点错误语义、跨 lane app quota cooldown、独立 durable in-flight/retry/cooldown/lane-wait 指标已完成；语义恢复要求精确 Lark 调用和 durable target，SQLite 不再从裸错误码推断，`230028` 当前 revision 首次拒绝即终止。性能与规模测量仍待完成（uncertain effect 计数已实现）。
- [x] 用户已授权并完成本地提交；发布与第 7 节在线验证仍需另行授权。

卡片设计/可读性/稳定性优化和 instances 多 Agent 易用性优化已记为后续待办，先各自形成方案再实施；不扩入当前稳定性切片。当前本地完成状态不代表上线批准。

Herdr 直接发起的 Primary turn 现已纳入事件驱动双投影收敛：pane hint 先完成 Binding identity reconcile，再显式唤醒 Primary external-turn observer；canonical transcript 生成的生命周期事件同时驱动 Main Card 与对应 Answer Card。首次 EOF baseline 不回放历史，周期扫描继续提供丢失 hint 的兜底。

Startup view convergence 新生成的 Main/Answer 修复 intent 统一标记为 `history`，正常交互和 Herdr/Lark 实时 turn 仍保持 `live`。因此重启后即使存在大量历史卡片修复，3:1 outbox 公平调度也会让新 Answer 在首批可用槽位内投递；重启前已持久化 intent 的 work class 不被改写。

最终验证：event router、external-turn observer、runtime reconcile、discovery、card projection、startup/shutdown 与架构边界专项 9 个文件、149 项测试通过；`npm test` 167 个文件、2,144 项测试全部通过；`architecture:check` 检查 304 个源码文件，`npm run typecheck`、`npm run build` 与 `git diff --check` 通过。build identity：`sha256:bf401c8d8659ca3e5671fd0e63e9080afc8abb7629c793cce897aab13b9cbc04`。未安装、重启、部署或写入真实 Lark。

### 8.4 恢复证据切片（2026-09-11）

新增 migration 31 和 `delivery_recoveries`，每个 failed reply/revision 一条稳定记录，保存首次失败摘要、恢复动作、显式 replacement、成功 reply/message/time。SQLite dead-letter trigger 与失败状态同事务写入；ledger 同样受 lease write fence 保护，不随 outbox 历史行 cascade 删除。它不是逐次 HTTP 尝试日志。

- R4：没有 successor 或 successor 仍在途/失败时，释放 lane 不再减少 unresolved dead-letter 数量。
- R5：第二次失败覆盖 lane quarantine 不会覆盖第一条恢复记录；匹配成功 ACK 原子关闭对应义务，成功 reply 被 retention 删除后仍保留证明。
- 同目标快照要求 target/lane、binding/prompt/worker/turn/selection、role 一致及更高 version/revision；无 version 的历史快照使用严格 delivery order。同页 numbered Answer revision 可以在 viewVersion 不变时推进。明确链接的 Main rebuild 还须匹配原 binding generation；未知效果不根据普通 successor 推断恢复。
- manual retry 保留首次失败证据，只有 ACK 才 recovered；authorized dismiss 记为 dismissed，而不是 recovered。`/status` 的 `deliveryRecoveries` 单列 unresolved/replacement_pending/recovered/dismissed，重试期间仍能看到待恢复义务；readiness 策略没有扩大。
- migration 只将有 released-snapshot 记录且有同身份 delivered successor 的历史失败回填 recovered；其它 legacy 失败保留 unresolved。跨 Answer 页创建成功仍不证明最终内容覆盖，故不会提前关闭旧失败。

本切片验证：`npm test` 161 文件、2,006 测试全部通过（14:49:15，16.68 秒），`architecture:check` 291 个源码文件通过，`npm run typecheck`、`npm run build`、`git diff --check` 通过。build identity：`sha256:1afe1c67f61fc9c89699f05796ebabccc4c37a67ef9d914942def0b9abfc829b`。新增覆盖 Main rebuild 再次失败与 stale ACK、跨 generation 拒绝、manual retry/dismiss、同版本/异目标/unknown 不误恢复、ledger 写入失败导致 ACK 事务回滚、旧库迁移/重开/裁剪。未提交、安装、重启或线上发送消息。最新验证见第 8.5 节。

### 8.5 单静态替代页的内容覆盖证明（2026-09-11）

维护者判断一个旧 Answer 投递失败是否恢复时，必须同时检查覆盖证据和成功更新回执，不能仅依据替代卡已创建或 lane 已释放。

- migration 32 新增 `answer_delivery_coverage`、`answer_recovery_links`、`answer_recovery_candidates`，均受 lease write fence 保护。stream/static snapshot reservation 在 claim 前记录 canonical source 起止位置与 SHA-256；coverage 不可 UPDATE，也不能在 claim 后补写。不解析 CardKit Markdown 来反推原文，不改 canonical offsets 或 9,000 字符分页。
- 关闭 stream 后，静态替代页 reservation 将旧失败、同 generation 的新 page 和 create intent 原子关联。create ACK 只建立投递身份，恢复义务仍是 `replacement_pending`。
- 候选 static update 必须与失败区间同起点、完整覆盖旧区间，且该前缀 hash 相同；允许尾部追加，不接受缩短或改写。匹配 claim 的 update ACK 还须验证 Prompt、binding generation、替代页 message 与 create 回执，才与 ACK 同事务标记 recovered。这里证明的是接口接受了投递，不是用户已阅读。
- 未解决义务保护 failed row 和 replacement create，避免裁剪提前销毁确认所需身份；解决后恢复正常裁剪，ledger 与 link 仍保留成功回执摘要和失败区间证明。旧库无 coverage 时保持 unresolved，不猜测回填。
- 此切片只覆盖 Primary 的单次 streaming → 单静态页替代，不包含多页覆盖合并、多跳替代链、变更源内容或 Worker 证明。公平调度 R6 已在后续第 8.6 节实施。

最新验证：`npm test` 161 文件、2,011 测试全部通过（16:28:57，16.84 秒）；`architecture:check` 291 个源码文件、`npm run typecheck`、`npm run build` 和 `git diff --check` 通过。build identity：`sha256:ca535eee85a5eaf9b190c3bad143eed4fc7511ccd9b29fcb169e5afe0b47bd4d`。覆盖完整/不足/改写内容、跨 generation、旧 retry ACK、coverage 不可改、重开库与裁剪，以及 dispatcher 静态重建成功路径。两个旧 outbox 迁移夹具同步移除新版证据表再模拟旧库，并验证升级后 migration 32、保护触发器和外键完整性；生产迁移校验未放宽。

变更仍仅在本地，未提交、安装、重启或向真实 Lark 发送消息。测试使用 Vitest 现有临时 SQLite 夹具；文档按恢复判定条件而非卡片表象整理。发布时需将恢复判定变化列入 release notes，并另行取得部署授权。

### 8.6 Work-conserving 投递与公平分类（2026-09-11）

投递消息仍必须先写入 SQLite。内存不保存唯一的待发消息，只维护正在执行的 lane、唤醒 revision 和最多四个并发槽位。这样进程重启后不会丢失投递意图、顺序、claim 或恢复证据，同时避免每次槽位释放都等待整批网络请求结束。

- dispatcher 用完成事件驱动的 pump 替代固定 `Promise.all` 批次。任一请求完成，或新 durable work 唤醒 dispatcher 时，立即扫描并填充空闲槽位；active lane 会从候选中排除，同 lane 顺序仍由 SQLite lane head 决定。
- migration 33 为 outbox 增加持久化 `work_class`。普通用户可见投递默认 `live`；Main rebuild、Answer static rebuild、stream rebuild 和 startup-lite 恢复标为 `history`，并对现有明确恢复 key 做保守回填。`work_class` 纳入 claim 后不可变字段和 payload hash。
- 同时有两类 due 工作时按固定 dispatch 次数执行 3 live : 1 history；一类为空时另一类使用所有槽位。配额不按网络时长计算，也不取消已启动工作。
- shutdown 立即停止新 claim，等待 active delivery 收敛。任一 checkpoint 变得 uncertain 时也停止补位，等待 sibling delivery 完成后再抛错，防止下一 scan 与残留请求叠加突破并发 4。
- 独立 `card_reply` 属于独立 reply lane，没有跨消息完成顺序要求。因此第一条飞书发送阻塞时，第二条已持久化入站可以先完成；这不改变同一卡片/Answer element 的严格顺序。

验证覆盖 R6 立即补位、3:1 history 配额、并发上限、同 lane 顺序、backoff、失败隔离、停止期间不 claim、checkpoint uncertain 等待 sibling、旧库 work-class 回填、claim 后禁止重分类和 no-op reopen。该段记录对应当时状态；阶段 E 的端点错误语义随后已实现，剩余项见 8.3。

最新验证：`npm test` 161 文件、2,014 测试全部通过（16:50:17，16.89 秒）；`architecture:check` 291 个源码文件、`npm run typecheck`、`npm run build` 和 `git diff --check` 通过。build identity：`sha256:38e50ad6bb4d19884f8fa6339bfc767a1be0abcb22aa121c24c5daadfc3499c9`。变更仍未提交、安装、重启或投递到真实 Lark。

### 8.7 群根 Pane 入口与可恢复 Thread Alias（2026-09-11）

`/swarm panes` 的目录仍回复在调用位置，但“发送卡片到群”现在通过 durable `group_card_create` outbox intent 发布一条新的群根卡片。SQLite 的 `binding_thread_aliases` 在按钮事务中先进入 `reserving`；Lark ACK 与 root/thread identity 写入、alias 激活和 outbox delivered 同事务完成。未确认的 alias 不参与路由，checkpoint uncertain 不会自动再建一条群根消息。

新入口卡是当前 Main Card 的无按钮快照，不参与 canonical Main Card 的 viewVersion/CardKit sequence。用户在新 thread 回复普通消息时，alias 以 chat、binding generation、pane、active lifecycle 和 attached 状态重新校验，复用原 Binding FIFO/Agent，但以 alias root 创建该 Prompt 的 Answer Card。generation 或 pane 变化后旧 alias 立即不可路由。alias thread 拒绝项目、Worker、model switch、reset/close/replace 等会话或拓扑变更，相关操作必须回到原始 Main Card topic。

migration 34 以保留所有历史行、claim、lane、quarantine、recovery 和 Answer coverage 外键的方式升级 outbox kind/target 约束，并重装索引与保护 trigger。最终验证：`npm test` 161 文件、2,024 测试全部通过（17:44:38，17.54 秒）；`architecture:check`、`npm run typecheck`、`npm run build`、`git diff --check` 和 `v0.4.0` 本地 release SHA256 校验通过。build identity：`sha256:fe4cc660fc7c2864b61b432a3fe959dd741b351ebacc57f0f9a5b036c2d089f1`。release staging 位于 `/tmp/herdr-pane-thread-v040-1RZo7f`；未提交、打 tag、发布、安装、重启或写入真实 Lark。

### 8.8 统一卡片信息层级（2026-09-11）

Primary Main、Primary Answer、Worker Main 和 Worker Task 统一采用“身份/状态 → 主要内容 → 必要提示 → 合法操作 → 历史与运行环境”的阅读顺序。此切片只修改纯 CardKit renderer，不改 view、callback identity、outbox、thread alias、分页或恢复协议。

- Primary Main 的最新消息压缩为最多 6 行和 3,000 个展示字符；Workers 位于最近活动之前，最近活动最多 5 项，Runtime 始终位于末尾。
- Answer 第 1 页仅在 queued/running/blocked 时展示进度，完成态不重复常规过程；续页仅保留紧凑元数据和正文，不重复 Worker、进度或操作提示。Worker 动态最多展示 3 项。
- Worker Main 改为状态摘要、警告、当前任务、统一操作区、队列、最近任务、运行环境；进度最多 3 项，最近任务最多 5 项，标签统一为中文。
- Worker Task 将父 Turn 压入首行元数据，进度最多 3 项；有完成结果时使用简短结果状态，续页不重复请求。操作按钮统一放在一个 action row，callback payload 不变。
- 新增纯 helper 处理 compact metadata、action row、recent items 和递归移除快照按钮。无 CSS、动画、新依赖或 CardKit 非标准组件。

聚焦验证覆盖 6 个测试文件、139 项测试，包含四类卡片、Answer page workflow 和共享样式。最终全量结果见本节后续验证记录。

最终验证：卡片相关 7 个测试文件、144 项测试通过；`npm test` 161 文件、2,026 项测试全部通过（18:06:03，18.06 秒）；`architecture:check`、`npm run typecheck`、`npm run build`、`git diff --check` 和 `v0.4.0` 本地 release SHA256 校验通过。build identity：`sha256:9bc64496b74a6f8fdc8ec54900d8a2c8de933f5d39fc17ab59a45bdca5a7bdda`。release staging 位于 `/tmp/herdr-card-readability-final-v040-wfENR6`；未提交、打 tag、发布、安装、重启或写入真实 Lark。

### 8.9 Lark 端点错误语义（2026-09-12）

每个 Lark port 调用现在携带有限枚举的 operation 与 durable target 上下文；分类器同时使用该上下文和安全归一化后的业务码决定恢复策略。只有匹配的 Primary Main `230099/300317` 与 Primary Answer content-stream `300309` 生成 recovery kind，SQLite 不再从裸错误码二次推断。`230028` 是当前 revision 的永久内容拒绝，第一次响应后立即 dead letter，不自动重试或改写。非匹配端点保持拒绝证据但不重建其它卡片，uncertain effect 仍优先进入 blocked quarantine。

专项验证覆盖 classifier、Lark adapter、安全日志、dispatcher、Answer workflow 与 SQLite，共 6 个文件、391 项测试通过。最终全量 `npm test` 为 167 个文件、2,127 项测试通过；`architecture:check` 检查 303 个源码文件，`npm run typecheck`、`npm run build` 与 `git diff --check` 通过。build identity：`sha256:dadd807e46345f141e624362fdc7be41e00735a2c755a6b41f06c9887a3300da`。未安装、重启、部署或写入真实 Lark。

### 8.10 Lark app quota cooldown（2026-09-12）

migration 38 新增单行 `lark_delivery_cooldowns`，在精确 claim 的 HTTP 429 失败事务内使用该 reply 已计算的 `next_attempt_at` 单调延长 app cooldown。lane selection、直接 claim、force scan 与重启均不能绕过门限；已在途 sibling 可以完成，各自的后续 429 只能延长期限。到期后不批量改写 outbox，由 next-wake 加 `0..250ms` 本地 jitter 自动恢复现有调度。

`/status` 报告 active、deadline、remaining time、trigger count 和安全错误摘要；active cooldown 将 status 标记 degraded，但 `/ready` 仍表示服务可持久接收工作。cooldown 只影响 Lark outbox，不改变 Herdr、Prompt 或 Worker 状态机。实现未假设 message/CardKit/topic 具有独立额度。

最终验证：quota、lease、SQLite、dispatcher、health 和错误分类专项 6 个文件、380 项测试通过；`npm test` 167 个文件、2,137 项测试全部通过；`architecture:check` 检查 304 个源码文件，`npm run typecheck`、`npm run build` 与 `git diff --check` 通过。build identity：`sha256:5c7401e4be3a9b13f8c27a5d0540a47485a9eeb15d7063b210cac21a64c1a294`。未安装、重启、部署或写入真实 Lark。

### 8.11 Durable outbox work diagnostics（2026-09-12）

`OperationalSummary.outboxWork` 将每条 pending outbox row 互斥地归为 ready、inFlight、retryWait、cooldownWait 或 waitingBehindLane；五类之和恒等于 `pendingOutbox`。分类由 SQLite 的 claim、lane head、row deadline 与 app cooldown 事实一次聚合得出，不新增状态、迁移、索引或写操作。row backoff 优先于 cooldown；active quarantine 下没有 lane head 的 pending row 属于 waitingBehindLane。

durable `inFlight` 与 dispatcher 的进程内 `activeDeliveries` 保持独立，供运维判断进程状态与持久 claim 是否漂移，但不互相修复。最早 claim 的时间和非负年龄只用于观察，不新增超时阈值；异常 legacy timestamp 返回 null age。正常 pending 分区不改变 `/status` 或 `/ready`，active cooldown、quarantine 和 stalled lane 继续沿用既有降级规则。

最终验证：SQLite、health、dispatcher、service lifecycle 与 operations 专项 5 个文件、433 项测试通过；`npm test` 167 个文件、2,141 项测试全部通过；`architecture:check` 检查 304 个源码文件，`npm run typecheck`、`npm run build` 与 `git diff --check` 通过。build identity：`sha256:971242a82890612c4430bbd8fe2bceeabedb14624474265c831158c462acf35a`。未安装、重启、部署或写入真实 Lark。

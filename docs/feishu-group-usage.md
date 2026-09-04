# 飞书群使用指南

Herdr Agent Swarm 通过 Herdr headless runtime 管理多个项目；Herdr UI 不是必需组件。
每个已绑定的飞书 Thread 都以其 Herdr pane 中运行的 TraeX 作为该 Thread 唯一的 Primary。
项目中的持久化 Agent 实例仅包含由用户显式创建的 Worker，Worker 可以使用 TraeX、
Codex、Claude Code 或 Pi。兼容的一话题一 TraeX 工作流仍以 Herdr Lark Bridge 模式提供；
该名称不代表当前多 Agent 产品或项目。用户可以在
飞书中创建任务、查看状态、修改名称和发送后续要求；开发者仍可在 Herdr 中
观察或接管同一个终端会话。

## 开始使用

管理员完成 `npm run swarm:setup`、配置 `LARK_ALLOWED_OPEN_IDS` 与
`LARK_ADMIN_OPEN_IDS`、启动服务，并确认 `npm run swarm:status` 正常后，
允许名单内的群成员即可开始操作。实例创建、删除、停止、steer 及会话拓扑操作仅
允许管理员名单成员。传统单话题 TraeX 流程的第一个飞书动作是在目标话题群发送：

```text
@Bot /swarm new 任务说明
```

它只会展示项目选择卡；选择项目后才创建 Pane 并提交首个请求。安装、密钥和服务恢复
属于管理员操作，不在飞书群内完成。

多 Agent 模式先选择项目，再打开实例目录：

```text
/projects
/project my-project
/instances
```

项目配置中的 `maxInstances` 只限制可持久化的 Worker 数量；`projects.json` 不再配置
Primary 或 Worker 模板。当前飞书 Thread 本身就是该 Thread 的 Primary。每个 Worker
从这个 Primary 的确切 Herdr pane/session 派生，拥有专属 pane 和 worktree；它不是可跨
pane 复活的项目级 Agent。

在实例目录点击“创建 Worker”，填写名称、Agent 和是否立即启动。创建操作必须在
active 的项目 Thread 中完成，以便验证父 Primary pane。可写 Worker 默认获得独立
branch/worktree；Primary 由当前 Thread 的 binding 提供，不作为实例创建或提升。
创建后可用以下命令查看和发任务：

```text
/instance reviewer
/to reviewer Review the SQLite transaction boundaries
/steer reviewer Focus on generation fencing
/interrupt reviewer
```

`/to` 始终创建一条新的 Worker 任务，并按该 Worker 的 FIFO 排队；即使这条命令是回复
另一张任务卡发送的，也不会变成 steer 或 follow-up。`/steer` 只作用于该 Worker 当前唯一的
active turn；没有 active turn、目标已经换代或 Agent 不支持 steering 时会明确拒绝，不会退化成
一条新的 `/to` 任务。

每次 `/to` 都会立即创建独立的 Worker task card。卡片从排队、准备、运行或阻塞推进到完成、
失败、取消或 `dispatch-uncertain`，可信的结构化输出会持续写入这张卡。长输出会分页；已经
冻结的前页不会被后续更新改写。`/instance reviewer` 显示最新五条任务的请求、结果摘要和
capture 状态，点击“打开”只读取该任务的持久化卡片，不会再次执行任务。

要持续给同一个任务补充要求，请直接回复它的 task card 并 `@Bot`：

- 回复正在运行或 blocked 的卡片会精确 steer 该 turn。
- 回复 completed、failed 或 cancelled 的卡片会创建一条带父任务关系的新 follow-up，并进入 FIFO。
- 回复仍 queued 的卡片会被拒绝，因为任务尚未开始。
- 回复 `dispatch-uncertain` 的卡片会被拒绝，因为请求可能已到达 Agent；自动重试可能造成重复执行。请先在对应 Herdr Pane 核对。
- 只有直接父消息能匹配 task card；系统不会根据 Thread、当前选中的 Worker 或更早的父消息猜测目标。

task card 上的结果只来自与该 Worker generation、runtime turn ID 和开始时间完全匹配的
TraeX transcript。终端 scrollback、另一轮任务的输出和仅表示“已投递”的回执都不会被当成结果。

在实例详情卡选择“设为当前目标”后，普通消息会持续发给该实例；若目标为 symbolic
Primary，则消息继续进入当前 Thread 的 prompt FIFO。实例 generation 变化时旧卡片和固定
目标会失效，必须刷新后重新选择。Primary 可直接调用同项目中已存在的 Worker，不需要
逐次确认，但不能创建、删除、提升、跨项目调用或自动选择 Worker。Worker 完成不会自动
触发 Primary turn。

实例停止不删除 worktree。删除前系统会重新检查 dirty、conflict、ahead、generation 和
fingerprint；任何不安全或不确定状态都会保留实例/worktree，不提供危险确认按钮。

以下传统 `/swarm` 流程用于单话题 TraeX binding，并在迁移期间继续支持。

在已经配置 Bridge Bot 的飞书群中发送顶层消息，并 `@Bot`：

```text
@Bot /swarm new 修复登录问题
```

Bridge 会先显示项目选择卡片。点击项目后才会创建 Herdr pane、启动 TraeX，
并将当前飞书话题永久绑定到该项目和 pane。后续
操作应在这个话题内发送。

也可以直接用自然语言创建任务：

```text
@Bot 请定位登录超时问题并修复
```

Bridge 仍会先要求你明确选择项目；选择成功后，这条原始消息才会作为首个请求
恰好提交一次。项目选择前不会创建 Pane，也不会把任务发送到默认项目。

## 更自然的卡片操作

项目主卡会根据当前状态显示精简操作。当前版本不提供“立即补充”或“改为立即补充”
入口；任务执行期间发送的普通回复仍按 FIFO 排队。旧卡片上的相关回调会被拒绝，
不会向 terminal 写入文本，已排队的 prompt 也会保持原位置和内容。

“更多操作”按实时状态生成。允许名单成员可刷新状态；停止、重置、重命名、归档、恢复、
替换和 Pane 关闭等管理操作还要求管理员身份及会话创建者身份，服务端也会再次校验
generation，不支持接管。成功操作以 Toast 和原卡刷新反馈；确认、失败或恢复场景才创建专用卡。

## 卡片如何更新

- 项目主卡展示绑定与最近会话的摘要；它不是终端输出的事实来源。
- 每条普通请求拥有一个 Answer 卡片。原始飞书消息就是请求记录，Bridge 不再创建独立 Request 卡。
- Answer 卡通过 CardKit 流式 Markdown 元素显示经过清洗的 TraeX 终端内容，包括可见的工作状态、工具摘要、审批提示和最终回答。
- 内容接近 CardKit 限制时，当前 Answer 卡被冻结，后续内容会在新的“继续回复”卡片中显示；早期卡片不会被改写或删除。
- Bridge 不显示模型 reasoning、内部控制标记、prompt 回显、终端装饰或敏感值。高风险审批仍只能在 Herdr 中完成。

## 当前可用指令

### `/swarm reset [说明]`

在当前已绑定话题中先创建并确认新的 TraeX 会话可用，再原子切换同一个飞书话题。
如果新 pane 创建或 TraeX 启动失败，旧会话仍然连接并可继续使用。切换成功后，Bridge
只会自动关闭经过 fresh observation 确认身份匹配且处于 idle/done 的旧 pane；working、
blocked、身份不匹配或状态无法确认时会保留旧 pane，供你在 Herdr 本地检查。
如果主卡提示 TraeX 仍在运行但未注册为 Herdr Agent，会话创建者也可以使用
`/swarm reset` 创建一个已验证的新 Agent 并切换话题；Bridge 不会向未注册的旧 pane
写入 prompt、按键或自动重放请求，也不会自动关闭状态无法确认的旧 pane。

```text
/swarm reset 重新排查登录问题
```

`/swarm reset` 与 `/swarm new` 不同：后者会选择项目并创建一个新的飞书话题。
新 Pane 使用 `task-xxxx` 随机名称，当前话题的主卡标题会更新为
`项目名 / task-xxxx`；可选说明不会替代这个会话身份。

### `/swarm stop`

当当前话题有活动 TraeX turn 时，字面量 `/swarm stop` 会直接向 Herdr pane 发送 `Esc`，
无论 TraeX 当前是 `working`、`blocked` 还是 `unknown`。它绕过普通 FIFO，不创建
prompt，也不依赖 Herdr 是否识别出 named agent。

只有不带参数的 `/swarm stop`（大小写不敏感）具有这个含义。`/swarm stop now` 等带参数形式
不会作为停止命令。若没有 active binding 或当前没有受 bridge 监督的活动 turn，Bridge
会拒绝 `/swarm stop`，不会加入普通队列。

`/swarm stop` 是 Herdr 本地 Esc 控制，不是 Bridge 对进程或 Herdr pane 的远程强杀，
也不能批准、拒绝或绕过高风险操作。

### `/swarm steer <文本>`

当前不支持。Bridge 会返回拒绝卡，不创建控制操作、不写入 terminal，也不会把文本
自动降级为普通任务。需要继续工作时，请把内容作为普通消息发送，它会进入 FIFO。

### `/swarm new [说明]`

发送后直接展示项目选择卡片；选择后创建新的 Herdr pane、启动 TraeX，并建立飞书话题绑定。
选择卡先写入 durable outbox，再立即尝试投递；短暂的飞书投递失败不会丢失选择请求，
Bridge 会继续重试。

```text
/swarm new 修复登录超时
```

如果当前话题已经绑定到 active pane，Bridge 会拒绝重复创建。
`/swarm new` 始终在选择项目后使用短随机 Pane 名，例如 `task-7kq2`；
话题主卡标题展示为 `space / pane_name`，例如
`herdr-agent-swarm / task-7kq2`。自然语言首条请求和可选说明不会作为话题名。
服务启动后的 Herdr 对账也会让已有受管话题按其真实 Pane 名收敛到该格式。
如需人工命名，使用 `/swarm rename <名称>`，标题将变为 `space / 名称`。

### `/swarm projects`

直接展示同一个项目选择卡片。只有发起命令的人可以点击，选择结果在当前话题绑定后不可切换。

### `/swarm spaces`

只读列出仓库配置中的全部 Space 和当前 Pane，包括空 Space、非 TraeX Pane
以及配置目录之外的“未注册” Pane。某个 workspace 查询失败时，其余 Space
仍会正常显示。已绑定到当前群的 Pane 提供“打开话题”；符合条件且未绑定的
TraeX Pane 提供“认领 Pane”，点击后会重新读取 workspace 并执行与 `attach` 相同的
校验。卡片不会提供关闭或删除动作。

### `/swarm sessions`

列出当前群的会话，包括 Space、Pane ID、lifecycle、attachment、TraeX 状态、
generation、队列长度和最近活动时间。不会显示其他群的话题链接、prompt 正文或终端输出。

### `/swarm failures`

列出当前群需要处理的发送失败、失败任务和异常会话。只有 Lark outbox dead letter
提供“重试发送”和“忽略”；重试复用原幂等键且只发送卡片或文本，绝不会重放 TraeX
prompt。失败任务只用于诊断。

### `/swarm attach <space> <pane>`

把已经运行 TraeX 的 Herdr pane 连接到当前飞书群，并创建正常的项目主卡和话题。
这个命令不会创建、重命名或重启 pane，也不会向 pane 发送文字。

```text
/swarm attach datasage_semantic_knowledge w5:p3G
```

`space` 必须精确匹配项目配置中显式声明的 `spaceName`。`pane` 可以是精确 Pane ID，
也可以是该 Space 中唯一的精确 Pane 名称；名称重名时会返回候选 ID。Bridge 只会在该项目的
Herdr workspace 中查找指定 pane，并确认 pane 正在运行 TraeX。重复执行同一命令
不会创建第二个绑定，而会返回已有连接信息。首次连接成功和重复连接的结果卡都会提供
“打开话题”按钮；点击后 Bridge 会在当前群发送飞书原生的话题转发卡片，再点击该卡片
即可进入项目话题。飞书公开 AppLink 不支持通过 Open API 的消息 ID 直达消息，因此 Bridge
不会再生成无效的 `openMessageId` 链接。如果绑定来自其他飞书群，则继续拒绝且不会暴露对应话题。
未知或重复的 space、其他 workspace
中的 pane、不存在的 pane、非 TraeX pane，以及已经绑定到其他会话的 pane 都会被拒绝。
如果 pane 属于当前群、当前项目中因观测失败变为 `orphaned` 的原会话，`attach` 会在
重新验证 workspace、项目目录、TraeX 和 terminal identity 后恢复原绑定。恢复过程不会
创建新绑定或重放任务；请通过返回的话题入口进入原话题，再发送 `/swarm resume`。

### `/swarm status`

刷新当前话题的绑定状态，包括 workspace、pane、TraeX 状态和队列深度。
该命令必须在已绑定话题中使用。

```text
/swarm status
```

### `/swarm model [name]`

该命令保留用于明确提示：运行中的 Agent 不支持远程切换模型。

```text
/swarm model
/swarm model GPT-5.5
```

Bridge 不会打开 TraeX 的 `/model` 菜单、读取 terminal 或模拟键盘选择。请在创建
Agent 时选择模型，或显式替换 Agent 后使用新模型。该命令不创建 Request/Answer
卡片，也不进入普通任务队列。

### 命令边界

传统单话题流程只把 `/swarm ...` 识别为该 binding 的控制命令。未被多 Agent 命令层
识别的 `/herdr`、`/model`、`/new`、`/stop` 以及其它 slash 命令，会作为普通任务原样
提交给绑定 pane 中的 TraeX，使其可使用自身命令与已安装 skills。顶层
`/steer <worker> <要求>` 属于多 Agent Worker 控制命令，不会进入 Primary FIFO。

### `/swarm rename <标题>`

修改当前任务和 Herdr pane 的显示名称。该命令不会重启 TraeX，也不会创建
新 pane。

```text
/swarm rename 登录超时根因排查
```

### `/swarm close`

归档当前飞书话题与 pane 的绑定。这个命令是非破坏性的：

- 不关闭 Herdr pane；
- 不终止 TraeX；
- 不删除飞书消息历史；
- 归档后不再接受该话题中的新任务。

```text
/swarm close
```

### Pane 恢复命令

当状态显示 `orphaned` 时，可以使用：

```text
/swarm reattach wA:p3
/swarm replace
```

`reattach` 只接受同一 Space、同一项目目录且 terminal identity 匹配、TraeX
仍在运行的原 Pane。`replace` 会新建一个 generation。两者都不会自动重放
结果不确定的任务；验证或替换后会保持归档，确认后再发送：

```text
/swarm resume
```

如果项目创建在 Pane ID 落库前中断，Bridge 不会在重启后自动新建第二个
Pane。请先检查对应 Space；已有 Pane 时发送
`/swarm attach <space> <pane>`，确认不存在时再发送 `/swarm new`。

### `/swarm awake`

当一次已投递任务处于 `detached`，且之后已经直接在 Herdr 中提交并完成了
新的 turn，可以在原飞书话题发送：

```text
/swarm awake
```

Bridge 会从 detached turn 的精确 transcript 边界（完成记录或 interrupt 后
下一个 turn 的开始）开始，按时间顺序把遗漏的
Herdr turn 投影为新的 Answer Card，然后继续原有飞书 FIFO。该命令不会向
TraeX 重发旧任务，不会写入 terminal；重复执行不会重复创建已接管的 turn。
如果找不到完整且带用户请求的后续 turn，原 detached 状态保持不变。

### `/swarm help`

显示 Bridge 帮助卡片。

```text
/swarm help
```

## 在话题中发送普通消息

已绑定话题中的普通回复全部进入 FIFO，按顺序作为下一个 turn 执行。Bridge 不会根据
`继续`、`可以` 等短语自动向正在运行的 turn 注入文本。

| TraeX 状态 | 普通消息的 Bridge 行为 |
| --- | --- |
| `working` 或 `blocked` | 加入 FIFO，等待当前 turn 结束后执行 |
| `idle` 或 `done` | 加入 FIFO，作为下一个 turn 执行 |
| `unknown` | 加入 FIFO，不尝试 steering |

每条普通消息都有独立状态卡。重复的飞书事件不会导致同一条消息重复排队。
排队卡会立即显示准确的 FIFO 前方条数；当前任务的运行时间按 30 秒档更新。有至少三个
有效历史 turn 样本时，卡片还显示基于最近最多十个样本中位数计算的粗略等待区间。该区间
用于解释队列进展，不是截止时间或倒计时。

旧版本留下的 steering 记录在恢复时会标记为 rejected，不会自动重放。`/swarm stop`
仍是显式优先级命令；`/swarm steer` 当前始终拒绝。

## 权限与审批

Herdr Agent Swarm 使用固定三档策略：配置 workspace 内读写、项目测试和 Primary 调用同项目既有
Worker 属于 routine；只有显式配置且可审计的外部效果可通过飞书一次性确认；push、部署、
删除、凭据访问、权限绕过、敏感主机路径、破坏性命令和 Agent 原生非结构化审批均为
local-only。远程 grant 绑定操作者、项目、实例 generation、action fingerprint、资源范围、
策略版本与过期时间，只能消费一次；动作内容变化后旧授权立即失效。

TraeX 需要高风险操作审批时，飞书卡片会显示橙色的“等待终端审批”状态。此时
必须回到对应 Herdr pane 批准或拒绝操作。

飞书端不能：

- 批准或绕过 TraeX 高风险操作审批（批准/拒绝仍必须回到 Herdr 完成）；
- 将任意 pane 强行连接到项目；`attach` 只接受已配置 space 对应 workspace 中正在运行 TraeX 的 pane；
- 通过 `/swarm stop` 强制终止 TraeX 进程或 Herdr pane。

`blocked` 时 `/swarm steer` 同样不会发送文本；是否放行高风险操作仍由 Herdr 终端决定。

## 从飞书关闭 Pane

真正关闭当前话题绑定的 Pane 使用两步确认：

```text
/swarm pane close
/swarm pane close confirm <code>
```

第一条命令生成 60 秒一次性确认码，第二条必须由同一飞书用户在同一话题中
发送。Bridge 会在确认时重新检查父 Primary 的 Pane identity、队列和运行状态，仅允许关闭
Herdr 明确报告为 `idle` 或 `done` 的 Primary；`working`、`blocked` 和 `unknown`
都会被拒绝。确认后的关闭会先终态化这个 Primary 派生的所有 Worker：未开始任务会取消，
可能已投递的任务会标为 `dispatch-uncertain` 而不会重放；随后先关闭这些 Worker pane，
再关闭父 Primary pane。其他 Thread 或其他父 pane 的 Worker 不会受影响。

Worker pane 若被单独关闭或在 Herdr 中消失，也会终态化；原 worktree 可以保留并按
安全删除流程处理，但不能在新 pane 中恢复为同一个 Worker session。关闭成功后，Bridge
会验证父 pane 已从 Herdr 消失，再归档话题。确认码只可使用一次；服务重启只观察未决
Worker/pane 关闭步骤，绝不会自动重放关闭命令或 Agent 任务。

## 常见问题

### 消息没有立即执行

先发送 `/swarm status`。普通消息进入 FIFO；排队卡上的前方条数是准确顺序，等待区间
只是基于历史样本的粗略估算。当前不支持远程 steering；如果 TraeX 是 `blocked`，
请到 Herdr 处理审批。

### `/swarm close` 后 pane 还在

这是预期行为。`/swarm close` 只归档绑定，不会关闭 pane。需要真正关闭时，
请在仍处于 active 的绑定话题中发送 `/swarm pane close` 并按卡片提示确认。

### 可以从飞书批准权限吗

不可以。所有高风险审批都必须在 Herdr 终端完成。

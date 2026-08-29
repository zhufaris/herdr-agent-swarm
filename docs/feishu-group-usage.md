# 飞书群使用指南

Herdr Agent Swarm 通过 Herdr headless runtime 管理多个项目和多个 Agent 实例；Herdr UI
不是必需组件。每个项目最多一个 Primary，并可有多个由用户显式创建的 Worker，底层
可以是 TraeX、Codex、Claude Code 或 Pi。原有 Herdr Lark Bridge 仍可将飞书话题
绑定到 Herdr pane 中运行的 TraeX。用户可以在
飞书中创建任务、查看状态、修改名称和发送后续要求；开发者仍可在 Herdr 中
观察或接管同一个终端会话。

## 开始使用

多 Agent 模式先选择项目，再打开实例目录：

```text
/projects
/project my-project
/instances
```

在实例目录点击“创建实例”，明确填写名称、角色、Agent 和是否立即启动。Primary 默认
使用主 checkout；可写 Worker 默认获得独立 branch/worktree。每个项目只能有一个 Primary。
创建后可用以下命令查看和发任务：

```text
/instance reviewer
/to reviewer 检查当前改动并给出建议
/steer reviewer 只关注并发安全
/interrupt reviewer
```

在实例详情卡选择“设为当前目标”后，普通消息会持续发给该实例；若目标为 symbolic
Primary，则 Primary 变更后自动解析到新 Primary。实例 generation 变化时旧卡片和固定
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

项目主卡会根据当前状态显示精简操作。任务执行中，任意群成员都可点击“立即补充”，
在仅对当前操作者有效的输入卡中补充要求。提交时 Bridge 会重新校验原 turn；如果原
turn 已结束，内容不会发送，也不会转投新的 turn。

普通话题回复始终按 FIFO 排队。执行中排队的 Answer 卡会提供“改为立即补充”；转换
成功后只绑定当时捕获的活动 turn。若该 turn 已结束，原 prompt 保持原队列位置和内容。

“更多操作”按实时状态生成。所有成员可刷新状态；停止、重置、重命名、归档、恢复、
替换和 Pane 关闭等管理操作仅会话创建者可用，服务端也会再次校验身份与 generation，
不支持接管。成功操作以 Toast 和原卡刷新反馈；确认、失败或恢复场景才创建专用卡。

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

将文本作为当前活动 TraeX turn 的 steering 立即注入，绕过普通 FIFO。只要有受
bridge 监督的活动 turn（`working` 或 `blocked`）即可注入；`blocked` 时文本会进入
TraeX 的 steering 输入，而不是审批界面。没有活动 turn 时会拒绝，不会降级为普通任务。

### `/swarm new [说明]`

打开项目选择卡片；选择后创建新的 Herdr pane、启动 TraeX，并建立飞书话题绑定。

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

打开同一个项目选择卡片。只有发起命令的人可以点击，选择结果在当前话题绑定后不可切换。

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

在已绑定且空闲的项目话题中查看或切换当前 Pane 的 TraeX 模型。

```text
/swarm model
/swarm model GPT-5.5
```

不带名称时显示当前模型和可用模型；带名称时由 TraeX 匹配并切换。名称未知或
不唯一时，Bridge 会原样展示 TraeX 的候选或错误信息。该命令不创建 Request/Answer
卡片、不进入任务队列；当前有任务运行或排队时会拒绝，请等待队列完成后重试。

### 命令边界

只有以 `/swarm` 开头的消息由 HerdrSwarm 处理。`/herdr`、`/model`、`/new`、
`/stop`、`/steer` 以及其它 slash 命令都会作为普通任务原样提交给绑定 pane 中的
TraeX，使其可使用自身命令与已安装 skills。

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

### `/swarm help`

显示 Bridge 帮助卡片。

```text
/swarm help
```

## 在话题中发送普通消息

已绑定话题中的普通回复默认进入 FIFO，按顺序作为下一个 turn 执行。只有少量明确、简短的
延续语句可能自动加入最近五分钟内仍受 Bridge 监督的活动 turn，例如 `继续`、`继续处理`、
`按这个做`、`可以`、`确认`，以及以 `补充：`、`另外注意：`、`再看下`、`顺便检查`
开头且不超过 100 个字符的纯文本。成功时 Answer 卡会显示“已自动加入当前执行”。

Slash 命令、代码块、图片或附件、超过 100 个字符的内容，以及不在上述白名单中的模糊消息
仍进入 FIFO。要无歧义地插入当前 turn，请显式使用 `/swarm steer <文本>`：

| TraeX 状态 | 普通消息的 Bridge 行为 |
| --- | --- |
| `working` 或 `blocked` | 明确的短延续语句可能自动加入当前 turn；其他消息进入 FIFO。需要明确立即插入可点“立即补充”或用 `/swarm steer` |
| `idle` 或 `done` | 加入 FIFO，作为下一个 turn 执行 |
| `unknown` | 保守地进入 FIFO，不尝试 steering |

每条消息都有独立状态卡。`/swarm steer` 卡显示“已加入当前执行”，当前 turn 的最终
回答仍只显示在主任务卡中。重复的飞书事件不会导致同一条消息重复注入。
排队卡会立即显示准确的 FIFO 前方条数；当前任务的运行时间按 30 秒档更新。有至少三个
有效历史 turn 样本时，卡片还显示基于最近最多十个样本中位数计算的粗略等待区间。该区间
用于解释队列进展，不是截止时间或倒计时。

如果自动延续在发送到 TraeX 前被明确拒绝，卡片会提供“作为新任务排队”，由用户确认后
幂等地转为普通 FIFO 任务。如果发送结果不确定，Bridge 不显示该按钮，也不会自动重放，
以免同一段内容被 TraeX 执行两次。
`/swarm stop` 与 `/swarm steer` 是显式的优先级命令：只要有受 bridge 监督的活动 turn
（`working` 或 `blocked`）即可生效，越过普通 FIFO，但不改变已排队的普通消息。

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

`blocked` 时的 `/swarm steer` 会把文本作为 steering 送入 TraeX，而不是替你点击审批
按钮；是否放行高风险操作仍由 Herdr 终端决定。

## 从飞书关闭 Pane

真正关闭当前话题绑定的 Pane 使用两步确认：

```text
/swarm pane close
/swarm pane close confirm <code>
```

第一条命令生成 60 秒一次性确认码，第二条必须由同一飞书用户在同一话题中
发送。Bridge 会在确认时重新检查 Pane identity、队列和运行状态，仅允许关闭
Herdr 明确报告为 `idle` 或 `done` 的 Pane；`working`、`blocked` 和 `unknown`
都会被拒绝。关闭成功后，Bridge 还会验证 Pane 已从 Herdr 消失，再归档话题。
确认码只可使用一次，服务重启不会自动重放关闭操作。

## 常见问题

### 消息没有立即执行

先发送 `/swarm status`。除上述白名单短延续语句外，普通消息进入 FIFO；排队卡上的
前方条数是准确顺序，等待区间只是基于历史样本的粗略估算。要明确立即插入当前 turn，
请用 `/swarm steer <文本>`；如果 TraeX 是 `blocked`，也可以到 Herdr 处理审批。

### `/swarm close` 后 pane 还在

这是预期行为。`/swarm close` 只归档绑定，不会关闭 pane。需要真正关闭时，
请在仍处于 active 的绑定话题中发送 `/swarm pane close` 并按卡片提示确认。

### 可以从飞书批准权限吗

不可以。所有高风险审批都必须在 Herdr 终端完成。

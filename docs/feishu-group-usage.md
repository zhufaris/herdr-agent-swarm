# 飞书群使用指南

Herdr Lark Bridge 将飞书话题绑定到 Herdr pane 中运行的 TraeX。用户可以在
飞书中创建任务、查看状态、修改名称和发送后续要求；开发者仍可在 Herdr 中
观察或接管同一个终端会话。

## 开始使用

在已经配置 Bridge Bot 的飞书群中发送顶层消息，并 `@Bot`：

```text
@Bot /herdr new 修复登录问题
```

Bridge 会先显示项目选择卡片。点击项目后才会创建 Herdr pane、启动 TraeX，
并将当前飞书话题永久绑定到该项目和 pane。后续
操作应在这个话题内发送。

也可以直接用自然语言创建任务：

```text
@Bot 请定位登录超时问题并修复
```

这条消息会同时作为新任务的首个请求。

## 卡片如何更新

- 项目主卡展示绑定与最近会话的摘要；它不是终端输出的事实来源。
- 每条普通请求拥有一个 Answer 卡片。原始飞书消息就是请求记录，Bridge 不再创建独立 Request 卡。
- Answer 卡通过 CardKit 流式 Markdown 元素显示经过清洗的 TraeX 终端内容，包括可见的工作状态、工具摘要、审批提示和最终回答。
- 内容接近 CardKit 限制时，当前 Answer 卡被冻结，后续内容会在新的“继续回复”卡片中显示；早期卡片不会被改写或删除。
- Bridge 不显示模型 reasoning、内部控制标记、prompt 回显、终端装饰或敏感值。高风险审批仍只能在 Herdr 中完成。

## 当前可用指令

### `/new [标题]`

在当前已绑定话题中先创建并确认新的 TraeX 会话可用，再原子切换同一个飞书话题。
如果新 pane 创建或 TraeX 启动失败，旧会话仍然连接并可继续使用。切换成功后，Bridge
只会自动关闭经过 fresh observation 确认身份匹配且处于 idle/done 的旧 pane；working、
blocked、身份不匹配或状态无法确认时会保留旧 pane，供你在 Herdr 本地检查。

```text
/new 重新排查登录问题
```

`/new` 与 `/herdr new` 不同：后者会选择项目并创建一个新的飞书话题。

### `/stop`

当当前 TraeX turn 明确处于 `working` 时，将字面量 `/stop` 作为高优先级
steering 立即注入当前 turn。它会绕过已经排队的普通消息，但不会取消、重排或
执行这些消息；当前 turn 结束后，普通消息仍按原 FIFO 顺序继续。

只有不带参数的 `/stop`（大小写不敏感）具有这个含义。`/stop now` 等带参数形式
不会作为 steering。若没有 active binding，或当前状态是 `idle`、`done`、`blocked`、
`unknown`，Bridge 会拒绝 `/stop` 且不会把它加入普通队列。如果状态在检查后、注入前
发生变化，Bridge 同样会将本次 `/stop` 标记失败，不会降级为后续普通 turn。

`/stop` 是发给 TraeX 的 steering，不是 Bridge 对进程或 Herdr pane 的远程强杀，
也不能批准、拒绝或绕过高风险操作。重复投递同一个飞书事件只会注入一次。

### `/herdr new <标题>`

打开项目选择卡片；选择后创建新的 Herdr pane、启动 TraeX，并建立飞书话题绑定。

```text
/herdr new 修复登录超时
```

如果当前话题已经绑定到 active pane，Bridge 会拒绝重复创建。
不带标题的 `/herdr new` 会在选择后使用短随机 Pane 名，例如 `task-7kq2`；
卡片标题展示为 `space / pane_name`。

### `/herdr projects`

打开同一个项目选择卡片。只有发起命令的人可以点击，选择结果在当前话题绑定后不可切换。

### `/herdr spaces`

只读列出仓库配置中的全部 Space 和当前 Pane，包括空 Space、非 TraeX Pane
以及配置目录之外的“未注册” Pane。某个 workspace 查询失败时，其余 Space
仍会正常显示。已绑定到当前群的 Pane 提供“打开话题”；符合条件且未绑定的
TraeX Pane 提供“认领 Pane”，点击后会重新读取 workspace 并执行与 `attach` 相同的
校验。卡片不会提供关闭或删除动作。

### `/herdr sessions`

列出当前群的会话，包括 Space、Pane ID、lifecycle、attachment、TraeX 状态、
generation、队列长度和最近活动时间。不会显示其他群的话题链接、prompt 正文或终端输出。

### `/herdr failures`

列出当前群需要处理的发送失败、失败任务和异常会话。只有 Lark outbox dead letter
提供“重试发送”和“忽略”；重试复用原幂等键且只发送卡片或文本，绝不会重放 TraeX
prompt。失败任务只用于诊断。

### `/herdr attach <space> <pane>`

把已经运行 TraeX 的 Herdr pane 连接到当前飞书群，并创建正常的项目主卡和话题。
这个命令不会创建、重命名或重启 pane，也不会向 pane 发送文字。

```text
/herdr attach datasage_semantic_knowledge w5:p3G
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
创建新绑定或重放任务；请通过返回的话题入口进入原话题，再发送 `/herdr resume`。

### `/herdr status`

刷新当前话题的绑定状态，包括 workspace、pane、TraeX 状态和队列深度。
该命令必须在已绑定话题中使用。

```text
/herdr status
```

### `/model [name]`

在已绑定且空闲的项目话题中查看或切换当前 Pane 的 TraeX 模型。`/herdr model
[name]` 是等价别名。

```text
/model
/model GPT-5.5
/herdr model GPT-5.5
```

不带名称时显示当前模型和可用模型；带名称时由 TraeX 匹配并切换。名称未知或
不唯一时，Bridge 会原样展示 TraeX 的候选或错误信息。该命令不创建 Request/Answer
卡片、不进入任务队列；当前有任务运行或排队时会拒绝，请等待队列完成后重试。

### `/herdr rename <标题>`

修改当前任务和 Herdr pane 的显示名称。该命令不会重启 TraeX，也不会创建
新 pane。

```text
/herdr rename 登录超时根因排查
```

### `/herdr close`

归档当前飞书话题与 pane 的绑定。这个命令是非破坏性的：

- 不关闭 Herdr pane；
- 不终止 TraeX；
- 不删除飞书消息历史；
- 归档后不再接受该话题中的新任务。

```text
/herdr close
```

### Pane 恢复命令

当状态显示 `orphaned` 时，可以使用：

```text
/herdr reattach wA:p3
/herdr replace
```

`reattach` 只接受同一 Space、同一项目目录且 terminal identity 匹配、TraeX
仍在运行的原 Pane。`replace` 会新建一个 generation。两者都不会自动重放
结果不确定的任务；验证或替换后会保持归档，确认后再发送：

```text
/herdr resume
```

如果项目创建在 Pane ID 落库前中断，Bridge 不会在重启后自动新建第二个
Pane。请先检查对应 Space；已有 Pane 时发送
`/herdr attach <space> <pane>`，确认不存在时再发送 `/herdr new`。

### `/herdr help`

显示 Bridge 帮助卡片。

```text
/herdr help
```

## 在话题中发送普通消息

已绑定话题中的普通回复会根据 TraeX 当前状态处理：

| TraeX 状态 | Bridge 行为 |
| --- | --- |
| `working` | 将消息作为 steering 注入当前 turn，不创建第二个并发 waiter |
| `idle` 或 `done` | 将消息加入 FIFO，作为下一个 turn 执行 |
| `blocked` | 保持排队，不把文字输入审批界面 |
| `unknown` | 保守地进入 FIFO，不尝试 steering |

每条消息都有独立状态卡。Steering 卡显示“已加入当前执行”，当前 turn 的最终
回答仍只显示在主任务卡中。重复的飞书事件不会导致同一条消息重复注入。
`/stop` 是这一规则的显式优先级例外：仅在 `working` 时越过普通 FIFO 注入，
但队列内容保持不变。

## 权限与审批

TraeX 需要高风险操作审批时，飞书卡片会显示橙色的“等待终端审批”状态。此时
必须回到对应 Herdr pane 批准或拒绝操作。

飞书端不能：

- 批准或绕过 TraeX 权限；
- 向审批界面发送 steering；
- 将任意 pane 强行连接到项目；`attach` 只接受已配置 space 对应 workspace 中正在运行 TraeX 的 pane；
- 通过 `/stop` 强制终止 TraeX 进程或 Herdr pane。

## 从飞书关闭 Pane

真正关闭当前话题绑定的 Pane 使用两步确认：

```text
/herdr pane close
/herdr pane close confirm <code>
```

第一条命令生成 60 秒一次性确认码，第二条必须由同一飞书用户在同一话题中
发送。Bridge 会在确认时重新检查 Pane identity、队列和运行状态，仅允许关闭
Herdr 明确报告为 `idle` 或 `done` 的 Pane；`working`、`blocked` 和 `unknown`
都会被拒绝。关闭成功后，Bridge 还会验证 Pane 已从 Herdr 消失，再归档话题。
确认码只可使用一次，服务重启不会自动重放关闭操作。

## 常见问题

### 消息没有立即执行

先发送 `/herdr status`。如果 TraeX 是 `blocked`，请到 Herdr 处理审批；如果是
非 `working` 状态，消息可能正在 FIFO 中等待。

### `/herdr close` 后 pane 还在

这是预期行为。`/herdr close` 只归档绑定，不会关闭 pane。需要真正关闭时，
请在仍处于 active 的绑定话题中发送 `/herdr pane close` 并按卡片提示确认。

### 可以从飞书批准权限吗

不可以。所有高风险审批都必须在 Herdr 终端完成。

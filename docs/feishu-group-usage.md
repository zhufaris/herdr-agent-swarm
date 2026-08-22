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

## 当前可用指令

### `/herdr new <标题>`

打开项目选择卡片；选择后创建新的 Herdr pane、启动 TraeX，并建立飞书话题绑定。

```text
/herdr new 修复登录超时
```

如果当前话题已经绑定到 active pane，Bridge 会拒绝重复创建。
不带标题的 `/herdr new` 会在选择后使用项目显示名作为标题。

### `/herdr projects`

打开同一个项目选择卡片。只有发起命令的人可以点击，选择结果在当前话题绑定后不可切换。

### `/herdr spaces`

只读列出仓库配置中的全部 Space 和当前 Pane，包括空 Space、非 TraeX Pane
以及配置目录之外的“未注册” Pane。某个 workspace 查询失败时，其余 Space
仍会正常显示。已绑定到当前群的 Pane 提供“发送入口”；符合条件且未绑定的
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
“发送话题入口”按钮；点击后 Bridge 会在当前群发送飞书原生的话题转发卡片，再点击该卡片
即可进入项目话题。飞书公开 AppLink 不支持通过 Open API 的消息 ID 直达消息，因此 Bridge
不会再生成无效的 `openMessageId` 链接。如果绑定来自其他飞书群，则继续拒绝且不会暴露对应话题。
未知或重复的 space、其他 workspace
中的 pane、不存在的 pane、非 TraeX pane，以及已经绑定到其他会话的 pane 都会被拒绝。

### `/herdr status`

刷新当前话题的绑定状态，包括 workspace、pane、TraeX 状态和队列深度。
该命令必须在已绑定话题中使用。

```text
/herdr status
```

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

## 权限与审批

TraeX 需要高风险操作审批时，飞书卡片会显示橙色的“等待终端审批”状态。此时
必须回到对应 Herdr pane 批准或拒绝操作。

飞书端不能：

- 批准或绕过 TraeX 权限；
- 向审批界面发送 steering；
- 将任意 pane 强行连接到项目；`attach` 只接受已配置 space 对应 workspace 中正在运行 TraeX 的 pane；
- 强制终止正在工作的 TraeX。

## 已设计但尚未上线

以下命令已有设计，但当前线上版本还不能使用：

```text
/herdr pane close
/herdr pane close confirm <code>
```

它们将用于真正关闭当前话题绑定的 pane。关闭采用 60 秒一次性确认码，并且
仅允许关闭 `idle` 或 `done` 的 pane；`working`、`blocked` 和 `unknown` 状态均
会被拒绝。现阶段如需真正关闭 pane，请在 Herdr 中操作。

## 常见问题

### 消息没有立即执行

先发送 `/herdr status`。如果 TraeX 是 `blocked`，请到 Herdr 处理审批；如果是
非 `working` 状态，消息可能正在 FIFO 中等待。

### `/herdr close` 后 pane 还在

这是预期行为。`/herdr close` 只归档绑定，不会关闭 pane。真正的远程 pane
关闭功能尚未上线。

### 可以从飞书批准权限吗

不可以。所有高风险审批都必须在 Herdr 终端完成。

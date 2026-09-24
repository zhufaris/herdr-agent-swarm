import type { BridgeCommand, HerdrAgentSession } from "./types.js";

export type SwarmCommandKind = BridgeCommand["kind"];
export type SwarmCommandMode = "query" | "mutation";
export type SwarmCommandScope = "global" | "project" | "primary-session" | "active-turn";
export type SwarmCommandAuthorization = "allowed-user" | "administrator" | "creator" | "creator-and-administrator";
export type SwarmCommandReplayPolicy = "none" | "safe-before-effect" | "reconcilable" | "non-replayable";
export type SwarmCommandHandler = "help" | "provisioning" | "operations-query" | "session" | "model" | "pane-control" | "pane-closure" | "prompt-recovery" | "worker-lifecycle";
export type SwarmCommandRisk = "read-only" | "recoverable-mutation" | "destructive-mutation";
export type SwarmCommandSource = "literal" | "natural-language" | "card" | "primary-tool";
export type SwarmCommandSourceDecision = "execute-query" | "admit" | "confirm" | "unsupported";

export interface SwarmCommandPolicy { mode: SwarmCommandMode; scope: SwarmCommandScope; authorization: SwarmCommandAuthorization; replay: SwarmCommandReplayPolicy; handler: SwarmCommandHandler }
export interface SwarmCommandDefinition extends SwarmCommandPolicy { risk: SwarmCommandRisk; syntax: string; summary: string; examples: readonly string[] }

export const SWARM_COMMAND_DEFINITIONS = {
  help: definition("query", "global", "allowed-user", "none", "help", "read-only", "/swarm help", "查看 Swarm 指令和安全边界", ["/swarm help"]),
  projects: definition("query", "global", "administrator", "none", "provisioning", "read-only", "/swarm projects", "选择已配置项目", ["/swarm projects"]),
  spaces: definition("query", "project", "allowed-user", "none", "operations-query", "read-only", "/swarm spaces", "查看默认项目的 Herdr Space", ["/swarm spaces"]),
  panes: definition("query", "global", "allowed-user", "none", "operations-query", "read-only", "/swarm panes", "查看可连接的 Herdr Pane", ["/swarm panes"]),
  sessions: definition("query", "global", "allowed-user", "none", "operations-query", "read-only", "/swarm sessions [cursor]", "查看 Agent Session", ["/swarm sessions"]),
  failures: definition("query", "global", "allowed-user", "none", "operations-query", "read-only", "/swarm failures", "查看最近的投递失败", ["/swarm failures"]),
  status: definition("query", "primary-session", "allowed-user", "none", "session", "read-only", "/swarm status", "查看当前 Primary 状态", ["/swarm status"]),
  new: definition("mutation", "global", "administrator", "reconcilable", "provisioning", "recoverable-mutation", "/swarm new [标题] [--agent traex|pi|codex|claude-code]", "选择项目和 Primary Agent（默认 traex）", ["/swarm new 修复登录问题"]),
  reset: definition("mutation", "primary-session", "creator-and-administrator", "reconcilable", "provisioning", "recoverable-mutation", "/swarm reset [说明]", "为当前话题创建新的受管 Pane", ["/swarm reset 重新排查登录问题"]),
  attach: definition("mutation", "project", "administrator", "reconcilable", "provisioning", "recoverable-mutation", "/swarm attach <space> <pane>", "按 ID 或唯一名称连接已有 Herdr Pane", ["/swarm attach herdr w1:p1"]),
  rename: definition("mutation", "primary-session", "creator-and-administrator", "safe-before-effect", "session", "recoverable-mutation", "/swarm rename <标题>", "重命名当前话题和 Pane", ["/swarm rename 登录问题排查"]),
  close: definition("mutation", "primary-session", "creator-and-administrator", "safe-before-effect", "pane-closure", "recoverable-mutation", "/swarm close", "请求关闭当前会话", ["/swarm close"]),
  pane_close_request: definition("mutation", "primary-session", "creator-and-administrator", "safe-before-effect", "pane-closure", "recoverable-mutation", "/swarm close", "请求关闭当前会话", ["/swarm close"]),
  pane_close_confirm: definition("mutation", "primary-session", "creator-and-administrator", "non-replayable", "pane-closure", "destructive-mutation", "/swarm close confirm <code>", "确认关闭当前会话", ["/swarm close confirm A7K9Q2"]),
  reattach: definition("mutation", "primary-session", "creator-and-administrator", "reconcilable", "provisioning", "recoverable-mutation", "/swarm reattach <pane>", "重新连接 orphaned 会话", ["/swarm reattach w1:p1"]),
  replace: definition("mutation", "primary-session", "creator-and-administrator", "reconcilable", "provisioning", "recoverable-mutation", "/swarm replace", "为 orphaned 会话创建 replacement Pane", ["/swarm replace"]),
  resume: definition("mutation", "primary-session", "creator-and-administrator", "safe-before-effect", "session", "recoverable-mutation", "/swarm resume", "恢复暂停的当前队列", ["/swarm resume"]),
  awake: definition("mutation", "active-turn", "creator", "reconcilable", "prompt-recovery", "recoverable-mutation", "/swarm awake", "从 Herdr transcript 恢复遗漏结果，不重发任务", ["/swarm awake"]),
  skip: definition("mutation", "active-turn", "creator", "reconcilable", "prompt-recovery", "destructive-mutation", "/swarm skip", "跳过 detached Prompt blocker；此前结果仍不确定", ["/swarm skip"]),
  stop: definition("mutation", "active-turn", "creator-and-administrator", "non-replayable", "pane-control", "destructive-mutation", "/swarm stop", "中断 exact active turn，不停止 Pane、不取消 FIFO", ["/swarm stop"]),
  steer: definition("mutation", "primary-session", "administrator", "non-replayable", "pane-control", "recoverable-mutation", "/swarm steer <文本>", "active 时注入 exact turn，idle 时优先于普通队列执行", ["/swarm steer 先定位根因"]),
  model: definition("mutation", "primary-session", "creator-and-administrator", "non-replayable", "model", "recoverable-mutation", "/swarm model [name]", "查看或切换当前模型", ["/swarm model GPT-5.5"]),
  worker_create: definition("mutation", "primary-session", "administrator", "reconcilable", "worker-lifecycle", "recoverable-mutation", "/swarm worker create <name> [--agent <kind>] [--model <name>] [--start]", "创建项目 Worker", ["/swarm worker create reviewer --start"])
} as const satisfies Record<SwarmCommandKind, SwarmCommandDefinition>;

export const SWARM_COMMAND_POLICIES = Object.fromEntries(
  Object.entries(SWARM_COMMAND_DEFINITIONS).map(([kind, value]) => [kind, policyFrom(value)])
) as { [K in SwarmCommandKind]: SwarmCommandPolicy };

export const SWARM_COMMAND_HELP_GROUPS = [
  { title: "创建与连接", kinds: ["new", "reset", "attach"] },
  { title: "查看状态", kinds: ["help", "projects", "spaces", "panes", "sessions", "failures", "status"] },
  { title: "控制会话", kinds: ["rename", "resume", "steer", "model"] },
  { title: "恢复", kinds: ["reattach", "replace", "awake"] },
  { title: "Worker 管理", kinds: ["worker_create"] },
  { title: "高风险操作", kinds: ["stop", "skip", "close", "pane_close_request", "pane_close_confirm"] }
] as const satisfies readonly { title: string; kinds: readonly SwarmCommandKind[] }[];

export function swarmCommandDefinition(command: BridgeCommand): SwarmCommandDefinition {
  const value = SWARM_COMMAND_DEFINITIONS[command.kind];
  if (command.kind === "model" && command.name === null) return { ...value, mode: "query", replay: "none", risk: "read-only" };
  return value;
}

export function swarmCommandPolicy(command: BridgeCommand): SwarmCommandPolicy {
  return policyFrom(swarmCommandDefinition(command));
}

export function swarmCommandSourceDecision(command: BridgeCommand, source: SwarmCommandSource): SwarmCommandSourceDecision {
  const definition = swarmCommandDefinition(command);
  if (definition.mode === "query") return "execute-query";
  if (source === "primary-tool" && definition.risk === "destructive-mutation") return "unsupported";
  if (source === "natural-language" && definition.risk === "destructive-mutation") return "confirm";
  return "admit";
}

function definition(mode: SwarmCommandMode, scope: SwarmCommandScope, authorization: SwarmCommandAuthorization, replay: SwarmCommandReplayPolicy, handler: SwarmCommandHandler, risk: SwarmCommandRisk, syntax: string, summary: string, examples: readonly string[]): SwarmCommandDefinition {
  return { mode, scope, authorization, replay, handler, risk, syntax, summary, examples };
}

function policyFrom(value: SwarmCommandDefinition): SwarmCommandPolicy {
  return { mode: value.mode, scope: value.scope, authorization: value.authorization, replay: value.replay, handler: value.handler };
}

export interface PrimaryCommandContext {
  bindingId: string; bindingGeneration: number; paneId: string | null; terminalId: string | null; nativeSession: HerdrAgentSession | null; activePromptId: string | null;
}

export interface SwarmCommandContext {
  chatId: string; topicId: string | null; rootMessageId: string | null; sourceMessageId: string; actorOpenId: string; projectId: string | null; workspaceId: string | null; primary: PrimaryCommandContext | null;
}

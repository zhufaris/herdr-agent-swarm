import type { BridgeCommand, HerdrAgentSession } from "./types.js";

export type SwarmCommandKind = BridgeCommand["kind"];
export type SwarmCommandMode = "query" | "mutation";
export type SwarmCommandScope = "global" | "project" | "primary-session" | "active-turn";
export type SwarmCommandAuthorization = "allowed-user" | "administrator" | "creator" | "creator-and-administrator";
export type SwarmCommandReplayPolicy = "none" | "safe-before-effect" | "reconcilable" | "non-replayable";
export type SwarmCommandHandler = "help" | "provisioning" | "operations-query" | "session" | "model" | "pane-control" | "pane-closure" | "prompt-recovery" | "worker-lifecycle";

export interface SwarmCommandPolicy { mode: SwarmCommandMode; scope: SwarmCommandScope; authorization: SwarmCommandAuthorization; replay: SwarmCommandReplayPolicy; handler: SwarmCommandHandler }

export const SWARM_COMMAND_POLICIES = {
  help: { mode: "query", scope: "global", authorization: "allowed-user", replay: "none", handler: "help" },
  projects: { mode: "query", scope: "global", authorization: "administrator", replay: "none", handler: "provisioning" },
  spaces: { mode: "query", scope: "project", authorization: "allowed-user", replay: "none", handler: "operations-query" },
  sessions: { mode: "query", scope: "global", authorization: "allowed-user", replay: "none", handler: "operations-query" },
  failures: { mode: "query", scope: "global", authorization: "allowed-user", replay: "none", handler: "operations-query" },
  status: { mode: "query", scope: "primary-session", authorization: "allowed-user", replay: "none", handler: "session" },
  new: { mode: "mutation", scope: "global", authorization: "administrator", replay: "reconcilable", handler: "provisioning" },
  reset: { mode: "mutation", scope: "primary-session", authorization: "creator-and-administrator", replay: "reconcilable", handler: "provisioning" },
  attach: { mode: "mutation", scope: "project", authorization: "administrator", replay: "reconcilable", handler: "provisioning" },
  rename: { mode: "mutation", scope: "primary-session", authorization: "creator-and-administrator", replay: "safe-before-effect", handler: "session" },
  close: { mode: "mutation", scope: "primary-session", authorization: "creator-and-administrator", replay: "safe-before-effect", handler: "session" },
  pane_close_request: { mode: "mutation", scope: "primary-session", authorization: "creator-and-administrator", replay: "safe-before-effect", handler: "pane-closure" },
  pane_close_confirm: { mode: "mutation", scope: "primary-session", authorization: "creator-and-administrator", replay: "non-replayable", handler: "pane-closure" },
  reattach: { mode: "mutation", scope: "primary-session", authorization: "creator-and-administrator", replay: "reconcilable", handler: "provisioning" },
  replace: { mode: "mutation", scope: "primary-session", authorization: "creator-and-administrator", replay: "reconcilable", handler: "provisioning" },
  resume: { mode: "mutation", scope: "primary-session", authorization: "creator-and-administrator", replay: "safe-before-effect", handler: "session" },
  awake: { mode: "mutation", scope: "active-turn", authorization: "creator", replay: "reconcilable", handler: "prompt-recovery" },
  stop: { mode: "mutation", scope: "active-turn", authorization: "creator-and-administrator", replay: "non-replayable", handler: "pane-control" },
  steer: { mode: "mutation", scope: "active-turn", authorization: "administrator", replay: "non-replayable", handler: "pane-control" },
  model: { mode: "mutation", scope: "primary-session", authorization: "creator-and-administrator", replay: "non-replayable", handler: "model" },
  worker_create: { mode: "mutation", scope: "primary-session", authorization: "administrator", replay: "reconcilable", handler: "worker-lifecycle" }
} as const satisfies Record<SwarmCommandKind, SwarmCommandPolicy>;

export function swarmCommandPolicy(command: BridgeCommand): SwarmCommandPolicy {
  if (command.kind === "model" && command.name === null) return { ...SWARM_COMMAND_POLICIES.model, mode: "query", replay: "none" };
  return SWARM_COMMAND_POLICIES[command.kind];
}

export interface PrimaryCommandContext {
  bindingId: string; bindingGeneration: number; paneId: string | null; terminalId: string | null; nativeSession: HerdrAgentSession | null; activePromptId: string | null;
}

export interface SwarmCommandContext {
  chatId: string; topicId: string | null; rootMessageId: string | null; sourceMessageId: string; actorOpenId: string; projectId: string | null; workspaceId: string | null; primary: PrimaryCommandContext | null;
}

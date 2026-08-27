import type { Logger } from "pino";
import { renderFailureCards, renderSessionCards } from "../cards/operations-card.js";
import { renderSpaceDirectoryCards, type SpaceDirectoryGroup } from "../cards/space-directory-card.js";
import { projectSpaceName, type BridgeConfig } from "../config.js";
import type { HerdrPort, OperationsStore, OutboundIntentPort } from "../domain/ports.js";
import type { Binding, HerdrPane, IncomingLarkMessage, ProjectConfig } from "../domain/types.js";
import { safeLogError } from "../runtime/safe-error.js";

interface Options { config: Pick<BridgeConfig, "projects">; store: Pick<OperationsStore, "listBindings" | "listFailures" | "listSessions">; herdr: Pick<HerdrPort, "listPanes">; outbound: Pick<OutboundIntentPort, "enqueueCard">; logger: Logger; }

export interface OperationsQueryWorkflowPort {
  listSpaces(message: IncomingLarkMessage): Promise<void>;
  listSessions(message: IncomingLarkMessage): Promise<void>;
  listFailures(message: IncomingLarkMessage): Promise<void>;
}

export class OperationsQueryWorkflow implements OperationsQueryWorkflowPort {
  constructor(private readonly options: Options) {}

  async listSpaces(message: IncomingLarkMessage): Promise<void> {
    const { config, herdr, store, logger } = this.options;
    const panesByWorkspace = new Map<string, HerdrPane[]>(); const errors = new Map<string, string>();
    await Promise.all([...new Set(config.projects.map((project) => project.workspaceId))].map(async (workspaceId) => {
      try { panesByWorkspace.set(workspaceId, await herdr.listPanes(workspaceId)); } catch (error) { const safe = safeLogError(error); errors.set(workspaceId, safe.message); logger.warn({ event: "space-directory-workspace-failed", err: safe, workspaceId, outcome: "partial" }, "workspace unavailable while building space directory"); }
    }));
    const groups = buildSpaceDirectoryGroups(config.projects, panesByWorkspace, errors); const bindings = store.listBindings();
    const bindingsByPaneId = indexBindingsByPane(bindings);
    const boundPaneIds = new Set(bindings.flatMap((binding) => binding.paneId ? [binding.paneId] : []));
    const panesById = new Map([...panesByWorkspace.values()].flatMap((panes) => panes.map((pane) => [pane.paneId, pane] as const)));
    const projectsByRoute = indexProjectsByRoute(config.projects);
    for (const group of groups) for (const pane of group.panes) {
      const binding = selectSpaceDirectoryBinding(bindingsByPaneId.get(pane.paneId) ?? [], pane.paneId, message.chatId); if (binding) pane.bindingId = binding.id;
      if (!boundPaneIds.has(pane.paneId) && !group.unregistered && pane.foregroundExecutables.includes("traex")) {
        const projects = projectsByRoute.get(spaceDirectoryRoute(group.workspaceId, group.spaceName, panesById.get(pane.paneId)?.cwd)) ?? [];
        if (projects.length === 1) pane.claimProjectId = projects[0]!.id;
      }
    }
    await this.publishCards(message, "spaces", renderSpaceDirectoryCards(groups));
  }

  async listSessions(message: IncomingLarkMessage): Promise<void> { await this.publishCards(message, "sessions", renderSessionCards(this.options.store.listSessions(message.chatId))); }
  async listFailures(message: IncomingLarkMessage): Promise<void> { await this.publishCards(message, "failures", renderFailureCards(this.options.store.listFailures(message.chatId))); }

  private async publishCards(message: IncomingLarkMessage, kind: string, cards: object[]): Promise<void> {
    for (const [index, card] of cards.entries()) await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `${kind}:${message.messageId}:${index}`, card);
    this.options.logger.info({ event: `operation-${kind}-listed`, chatId: message.chatId, pageCount: cards.length, outcome: "listed" }, `listed Herdr ${kind}`);
  }
}

export function buildSpaceDirectoryGroups(projects: readonly ProjectConfig[], panesByWorkspace: ReadonlyMap<string, HerdrPane[]>, errors: ReadonlyMap<string, string>): SpaceDirectoryGroup[] {
  const groups = new Map<string, SpaceDirectoryGroup>();
  const groupsByRoute = new Map<string, SpaceDirectoryGroup>();
  for (const project of projects) {
    const spaceName = projectSpaceName(project);
    const key = `${project.workspaceId}\0${spaceName}`;
    const group = groups.get(key) ?? { spaceName, workspaceId: project.workspaceId, directories: [], panes: [] };
    if (!group.directories.includes(project.cwd)) group.directories.push(project.cwd);
    const error = errors.get(project.workspaceId);
    if (error) group.error = error;
    groups.set(key, group);
    groupsByRoute.set(`${project.workspaceId}\0${project.cwd}`, group);
  }
  const result = [...groups.values()];
  for (const [workspaceId, panes] of panesByWorkspace) {
    const unmatched = [];
    for (const pane of panes) {
      const group = pane.cwd === null ? undefined : groupsByRoute.get(`${workspaceId}\0${pane.cwd}`);
      const view = { paneId: pane.paneId, name: pane.label ?? pane.paneId, agentState: pane.agentState, foregroundExecutables: pane.foregroundExecutables };
      if (group) group.panes.push(view);
      else unmatched.push(view);
    }
    if (unmatched.length) result.push({ spaceName: "未注册", workspaceId, directories: [], panes: unmatched, unregistered: true });
  }
  return result;
}

function indexBindingsByPane(bindings: readonly SpaceDirectoryBindingCandidate[]): Map<string, SpaceDirectoryBindingCandidate[]> {
  const byPane = new Map<string, SpaceDirectoryBindingCandidate[]>();
  for (const binding of bindings) if (binding.paneId) {
    const candidates = byPane.get(binding.paneId) ?? [];
    candidates.push(binding);
    byPane.set(binding.paneId, candidates);
  }
  return byPane;
}
function indexProjectsByRoute(projects: readonly ProjectConfig[]): Map<string, ProjectConfig[]> {
  const byRoute = new Map<string, ProjectConfig[]>();
  for (const project of projects) {
    const key = spaceDirectoryRoute(project.workspaceId, projectSpaceName(project), project.cwd);
    const candidates = byRoute.get(key) ?? [];
    candidates.push(project);
    byRoute.set(key, candidates);
  }
  return byRoute;
}
function spaceDirectoryRoute(workspaceId: string, spaceName: string, cwd: string | null | undefined): string { return `${workspaceId}\0${spaceName}\0${cwd ?? ""}`; }
type SpaceDirectoryBindingCandidate = Pick<Binding, "id" | "paneId" | "chatId" | "topicId" | "rootMessageId" | "lifecycle" | "updatedAt">;
export function selectSpaceDirectoryBinding(bindings: readonly SpaceDirectoryBindingCandidate[], paneId: string, chatId: string): SpaceDirectoryBindingCandidate | null { const rank: Partial<Record<Binding["lifecycle"], number>> = { active: 0, draining: 1, archived: 2 }; return bindings.filter((binding) => binding.paneId === paneId && binding.chatId === chatId && Boolean(binding.topicId ?? binding.rootMessageId) && rank[binding.lifecycle] !== undefined).sort((left, right) => rank[left.lifecycle]! - rank[right.lifecycle]! || right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))[0] ?? null; }

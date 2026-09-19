import type { Logger } from "pino";
import type { ApplicationPresentation, SpaceDirectoryGroup, TopicPaneDirectoryEntry } from "../domain/ports/presentation.js";
import { projectSpaceName, type BridgeConfig } from "../config.js";
import type { HerdrPort } from "../domain/ports/external.js";
import type { OutboundIntentPort } from "../domain/ports/outbox.js";
import type { OperationsQueryStore } from "../domain/ports/workflow.js";
import type { Binding, HerdrPane, IncomingLarkMessage, ProjectConfig } from "../domain/types.js";
import { safeLogError } from "../runtime/safe-error.js";

interface Options { config: Pick<BridgeConfig, "projects">; store: OperationsQueryStore; herdr: Pick<HerdrPort, "listPanes">; outbound: Pick<OutboundIntentPort, "enqueueCard">; presentation: Pick<ApplicationPresentation, "spaces" | "topicPanes" | "sessions" | "failures">; logger: Logger; }

export interface OperationsQueryWorkflowPort {
  listSpaces(message: IncomingLarkMessage): Promise<void>;
  listTopicPanes(message: IncomingLarkMessage, scopeBinding?: Binding | null): Promise<void>;
  listSessions(message: IncomingLarkMessage, cursor?: string | null): Promise<void>;
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
    await this.publishCards(message, "spaces", this.options.presentation.spaces(groups));
  }

  async listTopicPanes(message: IncomingLarkMessage, scopeBinding: Binding | null = null): Promise<void> {
    const scope = scopeBinding ? topicPaneScope(this.options.config.projects, scopeBinding) : null;
    const entries = this.options.store.listBindings()
      .filter((binding) => binding.chatId === message.chatId && (!scope || isInTopicPaneScope(this.options.config.projects, binding, scope)) && binding.state === "active" && binding.lifecycle === "active" && binding.attachment === "attached" && binding.paneId !== null && binding.statusMessageId !== null)
      .flatMap((binding): TopicPaneDirectoryEntry[] => {
        const view = this.options.store.loadTopicView(binding.id);
        if (!view || !binding.statusMessageId) return [];
        const workers = this.options.store.listWorkerInstancesByParent({ bindingId: binding.id, paneId: binding.paneId! }).map((worker) => {
          return { workerId: worker.id, runtimeGeneration: worker.generation, workerSessionGeneration: worker.workerSessionGeneration, workerName: worker.name, paneId: worker.runtimeRef?.paneId ?? worker.pendingRuntimeRef?.paneId ?? null, state: worker.observedState };
        });
        return [{ bindingId: binding.id, bindingGeneration: binding.generation, paneId: binding.paneId!, sourceMainMessageId: binding.statusMessageId, title: binding.title, spaceName: view.spaceName, agentState: binding.lastAgentState, workers }];
      })
      .sort((left, right) => left.spaceName.localeCompare(right.spaceName) || left.title.localeCompare(right.title) || left.paneId.localeCompare(right.paneId));
    await this.publishCards(message, "panes", [this.options.presentation.topicPanes(entries)]);
  }

  async listSessions(message: IncomingLarkMessage, cursor: string | null = null): Promise<void> { await this.publishCards(message, "sessions", this.options.presentation.sessions(this.options.store.listSessions(message.chatId, cursor))); }
  async listFailures(message: IncomingLarkMessage): Promise<void> { await this.publishCards(message, "failures", this.options.presentation.failures(this.options.store.listFailures(message.chatId))); }

  private async publishCards(message: IncomingLarkMessage, kind: string, cards: object[]): Promise<void> {
    for (const [index, card] of cards.entries()) await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `${kind}:${message.messageId}:${index}`, card);
    this.options.logger.info({ event: `operation-${kind}-listed`, chatId: message.chatId, pageCount: cards.length, outcome: "listed" }, `listed Herdr ${kind}`);
  }
}

interface TopicPaneScope { workspaceId: string; spaceName: string; }
function topicPaneScope(projects: readonly ProjectConfig[], binding: Binding): TopicPaneScope | null {
  const project = binding.projectId ? projects.find((candidate) => candidate.id === binding.projectId) : null;
  return project ? { workspaceId: project.workspaceId, spaceName: projectSpaceName(project) } : null;
}
function isInTopicPaneScope(projects: readonly ProjectConfig[], binding: Binding, scope: TopicPaneScope): boolean {
  const project = binding.projectId ? projects.find((candidate) => candidate.id === binding.projectId) : null;
  return Boolean(project && project.workspaceId === scope.workspaceId && projectSpaceName(project) === scope.spaceName);
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

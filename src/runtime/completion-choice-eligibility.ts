import type { CompletionChoiceEligibilityPort, CompletionChoiceEligibilityRequest } from "../domain/ports/completion-choice-eligibility.js";
import type { CompletionChoicePaneCandidate, InstanceStore } from "../domain/ports/instance.js";
import type { AgentInstance } from "../domain/agent-instance.js";
import type { Binding } from "../domain/types.js";
import type { PaneHost } from "../domain/ports/pane-host.js";

export type CompletionChoiceEligibilityStore = Pick<InstanceStore,
  "findCompletionChoicePaneCandidates" | "getBinding" | "getActiveInstanceTurn"
>;

type EligibleOwner = { workspaceId: string; runtimeId: string };

export class CompletionChoiceEligibility implements CompletionChoiceEligibilityPort {
  constructor(
    private readonly store: CompletionChoiceEligibilityStore,
    private readonly panes: Pick<PaneHost, "inspectPane">
  ) {}

  async isEligible(request: CompletionChoiceEligibilityRequest): Promise<boolean> {
    // Capture all durable evidence before the bounded Herdr read. If the gateway
    // times out, a late Pane result can no longer touch SQLite after shutdown.
    const eligibleOwners = this.store.findCompletionChoicePaneCandidates(request.paneId)
      .map((candidate) => this.eligibleOwner(candidate, request.paneId))
      .filter((owner): owner is EligibleOwner => owner !== null);
    const owner = eligibleOwners.length === 1 ? eligibleOwners[0] : null;
    if (!owner) return false;

    const pane = await this.panes.inspectPane(request.paneId);
    if (!pane || pane.paneId !== request.paneId || pane.agentKind !== "traex" || pane.workspaceId !== owner.workspaceId) return false;
    const observedRuntimeId = pane.agentSession?.value ?? pane.terminalId ?? null;
    return owner.runtimeId === observedRuntimeId;
  }

  private eligibleOwner(candidate: CompletionChoicePaneCandidate, paneId: string): EligibleOwner | null {
    return candidate.kind === "primary"
      ? this.eligiblePrimaryOwner(candidate.binding, paneId)
      : this.eligibleWorkerOwner(candidate.instance, paneId);
  }

  private eligiblePrimaryOwner(binding: Binding, paneId: string): EligibleOwner | null {
    if (
      binding.paneId !== paneId
      || binding.agentKind !== "traex"
      || binding.state !== "active"
      || binding.lifecycle !== "active"
      || binding.attachment !== "attached"
    ) return null;
    const runtimeId = binding.agentSessionValue ?? binding.traexSessionId;
    return runtimeId ? { workspaceId: binding.workspaceId, runtimeId } : null;
  }

  private eligibleWorkerOwner(instance: AgentInstance, paneId: string): EligibleOwner | null {
    if (
      instance.role !== "worker"
      || instance.agentKind !== "traex"
      || instance.workerSessionLifecycle !== "active"
      || instance.desiredState !== "running"
      || !["working", "blocked"].includes(instance.observedState)
      || instance.runtimeRef?.paneId !== paneId
      || instance.runtimeRef.generation !== instance.generation
      || !instance.parent
    ) return null;
    const parent = this.store.getBinding(instance.parent.bindingId);
    if (
      !parent
      || parent.projectId !== instance.projectId
      || parent.paneId !== instance.parent.paneId
      || (instance.parent.bindingGeneration !== undefined && parent.generation !== instance.parent.bindingGeneration)
      || parent.state !== "active"
      || parent.lifecycle !== "active"
      || parent.attachment !== "attached"
    ) return null;
    const turn = this.store.getActiveInstanceTurn(instance.id, instance.generation);
    if (!(turn !== null
      && turn.projectId === instance.projectId
      && turn.instanceId === instance.id
      && turn.instanceGeneration === instance.generation
      && (turn.state === "running" || turn.state === "blocked")
      && turn.runtimeTurnId !== null
      && turn.runtimeTurnStartedAt !== null)) return null;
    return instance.runtimeRef.nativeSessionId ? { workspaceId: instance.runtimeRef.herdrWorkspaceId, runtimeId: instance.runtimeRef.nativeSessionId } : null;
  }
}

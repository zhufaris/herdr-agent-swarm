import { createHash, randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { paneIdentityLabels, primaryGroupToken } from "../domain/pane-title.js";
import type { PaneTopologyIntent, PaneTopologyRuntimeIdentity } from "../domain/pane-topology-intent.js";
import type { InstanceStore } from "../domain/ports/instance.js";
import type { PaneHost } from "../domain/ports/pane-host.js";
import type { PaneTopologyIntentStore, PaneTopologyReconciliationPort } from "../domain/ports/pane-topology.js";
import type { HerdrPane, ProjectConfig } from "../domain/types.js";
import type { Binding } from "../domain/types.js";
import { safeLogError } from "../runtime/safe-error.js";

export class PaneTopologyReconciler implements PaneTopologyReconciliationPort {
  constructor(private readonly options: {
    intents: PaneTopologyIntentStore;
    instances: Pick<InstanceStore, "getAgentInstance" | "getBinding" | "listAgentInstances" | "getActiveInstanceTurn" | "hasBindingPrimaryToolCapability">;
    bindings: { listBindings(): Binding[] };
    paneHost: Pick<PaneHost, "movePane" | "labelPane">;
    logger?: Pick<Logger, "warn">;
  }) {}

  async reconcileWorkspace(input: { project: ProjectConfig; panes: readonly HerdrPane[] }): Promise<{ topologyChanged: boolean }> {
    let topologyChanged = false;
    const panes = new Map(input.panes.map((pane) => [pane.paneId, pane]));
    for (const intent of this.options.intents.listRecoverable().filter((candidate) => candidate.expected.workspaceId === input.project.workspaceId)) {
      topologyChanged = await this.reconcileIntent(intent, panes) || topologyChanged;
    }
    const activeOwners = new Set(this.options.intents.listRecoverable().map((intent) => `${intent.owner.kind}:${intent.owner.id}:${intent.owner.generation}:${intent.owner.sessionGeneration}`));
    for (const binding of this.options.bindings.listBindings()) {
      if (binding.projectId !== input.project.id || !binding.paneId || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached") continue;
      const ownerKey = `primary:${binding.id}:${binding.generation}:${binding.sessionEpoch}`;
      if (activeOwners.has(ownerKey)) continue;
      const pane = panes.get(binding.paneId);
      if (!pane || !isSettled(pane.agentState)) continue;
      const expected = runtimeIdentity(pane);
      if (!expected || !pane.tabId) continue;
      let identity;
      try {
        const groupToken = primaryGroupToken({ paneToken: pane.paneToken, label: pane.label, paneId: pane.paneId });
        identity = paneIdentityLabels(groupToken, this.options.instances.hasBindingPrimaryToolCapability(binding.id, binding.generation) ? { kind: "managed-primary" } : { kind: "default-primary" });
      } catch { continue; }
      if (pane.label === identity.paneLabel && pane.tabLabel === identity.tabLabel) continue;
      const desired = { tabId: pane.tabId, anchorPaneId: pane.paneId, paneLabel: identity.paneLabel, tabLabel: identity.tabLabel };
      this.options.intents.reserve({
        id: randomUUID(), idempotencyKey: `pane-topology:primary:${binding.id}:${binding.generation}:${binding.sessionEpoch}:${topologyFingerprint(expected, desired)}`,
        owner: { kind: "primary", id: binding.id, generation: binding.generation, sessionGeneration: binding.sessionEpoch },
        expected, desired
      });
    }
    for (const worker of this.options.instances.listAgentInstances(input.project.id)) {
      if (worker.role !== "worker" || worker.workerSessionLifecycle !== "active" || worker.desiredState !== "running" || !worker.runtimeRef || !worker.parent?.bindingGeneration) continue;
      const ownerKey = `worker:${worker.id}:${worker.generation}:${worker.workerSessionGeneration}`;
      if (activeOwners.has(ownerKey) || this.options.instances.getActiveInstanceTurn(worker.id, worker.generation)) continue;
      const binding = this.options.instances.getBinding(worker.parent.bindingId);
      const workerPane = panes.get(worker.runtimeRef.paneId);
      const parentPane = panes.get(worker.parent.paneId);
      if (!binding || binding.generation !== worker.parent.bindingGeneration || binding.paneId !== worker.parent.paneId
        || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached"
        || !workerPane || !parentPane || !isSettled(workerPane.agentState)) continue;
      const expected = runtimeIdentity(workerPane);
      if (!expected || !parentPane.tabId) continue;
      let identity;
      try {
        const groupToken = primaryGroupToken({ paneToken: parentPane.paneToken, label: parentPane.label, paneId: parentPane.paneId });
        identity = paneIdentityLabels(groupToken, { kind: "worker", name: worker.name });
      } catch { continue; }
      if (workerPane.tabId === parentPane.tabId && workerPane.label === identity.paneLabel && workerPane.tabLabel === identity.tabLabel) continue;
      const desired = { tabId: parentPane.tabId, anchorPaneId: parentPane.paneId, paneLabel: identity.paneLabel, tabLabel: identity.tabLabel };
      this.options.intents.reserve({
        id: randomUUID(),
        idempotencyKey: `pane-topology:worker:${worker.id}:${worker.generation}:${worker.workerSessionGeneration}:${topologyFingerprint(expected, desired)}`,
        owner: {
          kind: "worker", id: worker.id, generation: worker.generation, sessionGeneration: worker.workerSessionGeneration,
          parent: { id: binding.id, generation: binding.generation, sessionGeneration: binding.sessionEpoch, paneId: parentPane.paneId }
        },
        expected,
        desired
      });
    }
    for (const intent of this.options.intents.listRecoverable().filter((candidate) => candidate.expected.workspaceId === input.project.workspaceId)) {
      topologyChanged = await this.reconcileIntent(intent, panes) || topologyChanged;
    }
    return { topologyChanged };
  }

  private async reconcileIntent(intent: PaneTopologyIntent, panes: ReadonlyMap<string, HerdrPane>): Promise<boolean> {
    const worker = intent.owner.kind === "worker" ? this.options.instances.getAgentInstance(intent.owner.id) : null;
    if (intent.owner.kind === "worker" && (!worker || worker.generation !== intent.owner.generation || worker.workerSessionGeneration !== intent.owner.sessionGeneration
      || worker.parent?.bindingId !== intent.owner.parent.id || worker.parent.bindingGeneration !== intent.owner.parent.generation
      || worker.parent.paneId !== intent.owner.parent.paneId || worker.workerSessionLifecycle !== "active" || worker.desiredState !== "running"
      || worker.runtimeRef?.herdrWorkspaceId !== intent.expected.workspaceId || worker.runtimeRef.paneId !== intent.expected.paneId
      || worker.runtimeRef.nativeSessionId !== intent.expected.agentSessionId)) return false;
    if (intent.owner.kind === "worker") {
      const binding = this.options.instances.getBinding(intent.owner.parent.id);
      if (!binding || binding.generation !== intent.owner.parent.generation || binding.sessionEpoch !== intent.owner.parent.sessionGeneration
        || binding.paneId !== intent.owner.parent.paneId || binding.state !== "active"
        || binding.lifecycle !== "active" || binding.attachment !== "attached") return false;
    }
    if (intent.owner.kind === "primary") {
      const binding = this.options.instances.getBinding(intent.owner.id);
      if (!binding || binding.generation !== intent.owner.generation || binding.sessionEpoch !== intent.owner.sessionGeneration
        || binding.paneId !== intent.expected.paneId || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached") return false;
    }
    const exactRuntime = [...panes.values()].filter((pane) => matchesFrozenRuntime(pane, intent.expected));
    const exactTarget = exactRuntime.filter((pane) => pane.tabId === intent.desired.tabId
      && pane.label === intent.desired.paneLabel && pane.tabLabel === intent.desired.tabLabel);
    if ((intent.state === "executing" || intent.state === "uncertain") && exactTarget.length === 1) {
      if (intent.owner.kind === "worker") this.settleWorker(intent, exactTarget[0]!);
      else this.options.intents.finishSucceeded({
        id: intent.id, expectedAttemptCount: intent.attemptCount, at: now(),
        receipt: { previousPaneId: intent.expected.paneId, paneId: exactTarget[0]!.paneId, paneToken: exactTarget[0]!.paneToken ?? null, tabId: exactTarget[0]!.tabId!, workspaceId: exactTarget[0]!.workspaceId }
      });
      return true;
    }
    if (intent.state === "executing") {
      intent = this.options.intents.markUncertain({ id: intent.id, expectedAttemptCount: intent.attemptCount, detail: "move outcome requires exact topology observation", at: now() }) ?? intent;
    }
    const exactExpected = exactRuntime.length === 1 && matchesFrozenTopology(exactRuntime[0]!, intent.expected)
      ? exactRuntime[0]!
      : null;
    if (!exactExpected || !isSettled(exactExpected.agentState)
      || (worker && this.options.instances.getActiveInstanceTurn(worker.id, worker.generation))) return false;
    if (intent.state === "uncertain") {
      const observed = runtimeIdentity(exactExpected);
      if (observed) intent = this.options.intents.rearmIfStillExpected({ id: intent.id, expectedAttemptCount: intent.attemptCount, observed, at: now() }) ?? intent;
    }
    if (intent.state !== "pending") return false;
    const claim = this.options.intents.claim(intent.id, now());
    if (!claim) return false;
    try {
      if (claim.owner.kind === "primary") {
        const receipt = await this.options.paneHost.labelPane({
          workspaceId: claim.expected.workspaceId, paneId: claim.expected.paneId,
          paneToken: panes.get(claim.expected.paneId)?.paneToken ?? null,
          tabId: claim.desired.tabId, paneLabel: claim.desired.paneLabel, tabLabel: claim.desired.tabLabel
        });
        this.options.intents.finishSucceeded({ id: claim.id, expectedAttemptCount: claim.attemptCount, receipt, at: now() });
        return true;
      }
      const receipt = claim.expected.tabId === claim.desired.tabId
        ? await this.options.paneHost.labelPane({
            workspaceId: claim.expected.workspaceId, paneId: claim.expected.paneId,
            paneToken: panes.get(claim.expected.paneId)?.paneToken ?? null,
            tabId: claim.desired.tabId, paneLabel: claim.desired.paneLabel, tabLabel: claim.desired.tabLabel
          })
        : await this.options.paneHost.movePane({
            paneId: claim.expected.paneId, targetTabId: claim.desired.tabId, targetAnchorPaneId: claim.desired.anchorPaneId,
            paneLabel: claim.desired.paneLabel, tabLabel: claim.desired.tabLabel
          });
      this.options.intents.finishWorkerMoveSucceeded({
        id: claim.id, expectedAttemptCount: claim.attemptCount, receipt, at: now(),
        worker: { id: worker!.id, generation: worker!.generation, sessionGeneration: worker!.workerSessionGeneration, expectedNativeSessionId: claim.expected.agentSessionId }
      });
      return true;
    } catch (error) {
      this.options.intents.markUncertain({ id: claim.id, expectedAttemptCount: claim.attemptCount, detail: safeLogError(error).message, at: now() });
      this.options.logger?.warn({ event: "pane-topology-move-uncertain", intentId: claim.id, ownerKind: claim.owner.kind, ownerId: claim.owner.id, err: safeLogError(error), outcome: "observe_before_retry" }, "Pane topology move outcome is uncertain");
      return false;
    }
  }

  private settleWorker(intent: PaneTopologyIntent, pane: HerdrPane): void {
    this.options.intents.finishWorkerMoveSucceeded({
      id: intent.id, expectedAttemptCount: intent.attemptCount, at: now(),
      receipt: { previousPaneId: intent.expected.paneId, paneId: pane.paneId, paneToken: pane.paneToken ?? null, tabId: pane.tabId!, workspaceId: pane.workspaceId },
      worker: { id: intent.owner.id, generation: intent.owner.generation, sessionGeneration: intent.owner.sessionGeneration, expectedNativeSessionId: intent.expected.agentSessionId }
    });
  }
}

function runtimeIdentity(pane: HerdrPane): PaneTopologyRuntimeIdentity | null {
  if (!pane.terminalId || !pane.agentSession?.value || !pane.tabId || !pane.label || !pane.tabLabel) return null;
  return { workspaceId: pane.workspaceId, paneId: pane.paneId, terminalId: pane.terminalId, agentSessionId: pane.agentSession.value, tabId: pane.tabId, paneLabel: pane.label, tabLabel: pane.tabLabel };
}

function matchesFrozenRuntime(pane: HerdrPane, expected: PaneTopologyRuntimeIdentity): boolean {
  return pane.workspaceId === expected.workspaceId && pane.terminalId === expected.terminalId
    && pane.agentSession?.value === expected.agentSessionId;
}

function matchesFrozenTopology(pane: HerdrPane, expected: PaneTopologyRuntimeIdentity): boolean {
  return matchesFrozenRuntime(pane, expected) && pane.paneId === expected.paneId && pane.tabId === expected.tabId
    && pane.label === expected.paneLabel && pane.tabLabel === expected.tabLabel;
}

function isSettled(state: HerdrPane["agentState"]): boolean { return state === "idle" || state === "done"; }
function topologyFingerprint(expected: PaneTopologyRuntimeIdentity, desired: PaneTopologyIntent["desired"]): string {
  return createHash("sha256").update(JSON.stringify({ expected, desired })).digest("hex").slice(0, 16);
}
function now(): string { return new Date().toISOString(); }

import { randomUUID } from "node:crypto";
import type { BridgeEvent } from "../../domain/events.js";
import type { OutboxStore } from "../../domain/ports/outbox.js";
import type { RunCardView } from "../../domain/run-card-view.js";
import { initialTopicView } from "../../domain/topic-view.js";
import type { Binding, BindingTitleProjectionInput, BindingTitleProjectionResult, OrphanBindingProjectionInput, OrphanBindingProjectionResult, RecoverOrphanBindingProjectionInput, RecoverOrphanBindingProjectionResult, RuntimeDegradationInput, RuntimeDegradationResult } from "../../domain/types.js";
import type { SessionTransition } from "../../domain/pane-thread-lifecycle.js";
import { isNativeTraexSession, sameNativeTraexSession } from "../../domain/traex-session-identity.js";
import { matchesAgentKind } from "../../domain/agent-instance.js";
import type { SqliteContext } from "./context.js";
import type { SqliteBindingLifecycleStore } from "./binding-store.js";
import type { SqliteProjectionStore } from "./projection-store.js";

export class SqliteBindingProjectionStore {
  constructor(
    private readonly context: SqliteContext,
    private readonly bindings: SqliteBindingLifecycleStore,
    private readonly projections: SqliteProjectionStore,
    private readonly dependencies: {
      enqueueOutboundReply(input: Parameters<OutboxStore["enqueueOutboundReply"]>[0] & { laneKeyOverride?: string }): unknown;
      listRunCardsByPhases(bindingId: string, phases: readonly RunCardView["phase"][]): RunCardView[];
    }
  ) {}
  private get database() { return this.context.database; }

  reconcileBindingTitleWithProjection(input: BindingTitleProjectionInput): BindingTitleProjectionResult {
    return this.context.transaction(() => {
      let binding = this.requireBinding(input.bindingId);
      if (!matchesRuntimeFence(binding, input.expectedPaneId, input.expectedGeneration)) return { outcome: "stale_binding", binding, outboxReserved: false };
      if (binding.title === input.title) return { outcome: "unchanged", binding, outboxReserved: false };
      this.database.prepare("UPDATE bindings SET title = ?, updated_at = ? WHERE id = ?").run(input.title, now(), input.bindingId);
      binding = this.requireBinding(input.bindingId);
      this.projections.saveTopicView(input.view);
      const reservation = this.projections.reserveMainCardIntent(input.view, input.rootMessageId, input.card, undefined, input.paneEntryCard);
      return { outcome: "projected", binding, outboxReserved: reservation === "reserved" };
    });
  }

  degradeBindingWithProjection(input: RuntimeDegradationInput): RuntimeDegradationResult {
    return this.context.transaction(() => {
      let binding = this.requireBinding(input.bindingId);
      if (!matchesRuntimeFence(binding, input.expectedPaneId, input.expectedGeneration)) return { outcome: "stale", binding, view: this.projections.loadTopicView(input.bindingId), outboxReserved: false };
      const current = this.projections.loadTopicView(input.bindingId) ?? initialTopicView(input.bindingId);
      if (binding.attachment === "degraded" && current.phase === input.view.phase && current.notice === input.view.notice) return { outcome: "unchanged", binding, view: current, outboxReserved: false };
      if (current.viewVersion > input.view.viewVersion) return { outcome: "stale", binding, view: current, outboxReserved: false };
      binding = this.bindings.transitionBinding(input.bindingId, { type: "agent_unregistered" });
      this.projections.saveTopicView(input.view);
      const reservation = this.projections.reserveMainCardIntent(input.view, input.rootMessageId, input.mainCard, undefined, input.paneEntryCard);
      return { outcome: "degraded", binding, view: this.projections.loadTopicView(input.bindingId), outboxReserved: reservation === "reserved" };
    });
  }

  orphanBindingWithProjection(input: OrphanBindingProjectionInput): OrphanBindingProjectionResult {
    return this.context.transaction(() => {
      let binding = this.requireBinding(input.bindingId);
      if (binding.paneId !== input.expectedPaneId || binding.generation !== input.expectedGeneration) return { outcome: "stale", binding: null, view: null, updatedPromptIds: [], outboxReserved: false };
      if (binding.attachment === "orphaned") return { outcome: "unchanged", binding, view: this.projections.loadTopicView(input.bindingId), updatedPromptIds: [], outboxReserved: false };
      const current = this.projections.loadTopicView(input.bindingId) ?? initialTopicView(input.bindingId);
      if (current.viewVersion > input.view.viewVersion) return { outcome: "stale", binding, view: current, updatedPromptIds: [], outboxReserved: false };
      binding = this.bindings.transitionBinding(input.bindingId, { type: "pane_probe_failed", confirmedMissing: true, orphanThreshold: 2 });
      if (binding.attachment !== "orphaned") return { outcome: "unchanged", binding, view: this.projections.loadTopicView(input.bindingId), updatedPromptIds: [], outboxReserved: false };
      this.database.prepare(`UPDATE prompt_jobs SET state = CASE state WHEN 'queued' THEN 'cancelled' ELSE 'failed' END, observation_state = 'completed', error = ?, updated_at = ? WHERE binding_id = ? AND state IN ('running', 'queued')`).run(input.reason, input.occurredAt, input.bindingId);
      const updatedPromptIds: string[] = [];
      let answerOutboxReserved = false;
      for (const view of this.dependencies.listRunCardsByPhases(input.bindingId, ["running", "blocked", "queued"])) {
        const next: RunCardView = { ...view, phase: "failed", notice: input.reason, finishedAt: input.occurredAt, queuePosition: 0, activityAt: input.occurredAt, viewVersion: view.viewVersion + 1, updatedAt: input.occurredAt };
        this.projections.saveRunCard(next);
        updatedPromptIds.push(next.promptId);
        if (!next.answerCardId && next.answerMessageId) {
          this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `run-card:update:${next.promptId}:answer:${next.viewVersion}`, bindingId: next.bindingId, promptId: next.promptId, viewVersion: next.viewVersion, cardRole: "answer", rootMessageId: next.answerMessageId, kind: "card_update", payload: JSON.stringify(input.renderRunCard(next)) });
          answerOutboxReserved = true;
        } else if (!next.answerCardId && !next.answerMessageId && input.rootMessageId) {
          this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `run-card:create:${next.promptId}:answer`, bindingId: next.bindingId, promptId: next.promptId, viewVersion: next.viewVersion, cardRole: "answer", rootMessageId: input.rootMessageId, kind: "stream_card_create", payload: JSON.stringify(input.renderRunCard(next)) });
          answerOutboxReserved = true;
        }
      }
      this.projections.saveTopicView(input.view);
      const reservation = this.projections.reserveMainCardIntent(input.view, input.rootMessageId, input.mainCard, undefined, input.paneEntryCard);
      return { outcome: "orphaned", binding, view: this.projections.loadTopicView(input.bindingId), updatedPromptIds, outboxReserved: answerOutboxReserved || reservation === "reserved" };
    });
  }

  recoverOrphanBindingWithProjection(input: RecoverOrphanBindingProjectionInput): RecoverOrphanBindingProjectionResult {
    return this.context.transaction(() => {
      let binding = this.requireBinding(input.bindingId);
      if (binding.paneId !== input.expectedPaneId || input.pane.paneId !== input.expectedPaneId || binding.generation !== input.expectedGeneration || binding.lifecycle !== "active" || binding.attachment !== "orphaned" || binding.workspaceId !== input.pane.workspaceId) return { outcome: "stale", binding, view: this.projections.loadTopicView(input.bindingId), outboxReserved: false };
      const persisted = binding.agentSessionSource && binding.agentSessionAgent && binding.agentSessionKind && binding.agentSessionValue ? { source: binding.agentSessionSource, agent: binding.agentSessionAgent, kind: binding.agentSessionKind, value: binding.agentSessionValue } : null;
      const observed = input.pane.agentSession ?? null;
      const sessionMatches = Boolean(persisted && observed && (binding.agentKind === "traex"
        ? isNativeTraexSession(persisted) && sameNativeTraexSession(persisted, observed)
        : persisted.source === observed.source && persisted.agent === observed.agent && persisted.kind === observed.kind && persisted.value === observed.value));
      const agentMatches = binding.agentKind === "traex" ? isTraexCompatibleNativeAgent(input.pane) : matchesAgentKind(binding.agentKind, input.pane.agentKind);
      if (!binding.traexSessionId || !input.pane.terminalId || binding.traexSessionId !== input.pane.terminalId || !sessionMatches || !agentMatches) return { outcome: "identity_mismatch", binding, view: this.projections.loadTopicView(input.bindingId), outboxReserved: false };
      binding = this.bindings.transitionBinding(input.bindingId, { type: "pane_reattached", replacement: false });
      binding = this.bindings.transitionBinding(input.bindingId, { type: "pane_observed", runtime: input.pane.agentState });
      this.projections.saveTopicView(input.view);
      const reservation = this.projections.reserveMainCardIntent(input.view, input.rootMessageId, input.mainCard, undefined, input.paneEntryCard);
      return { outcome: "recovered", binding, view: this.projections.loadTopicView(input.bindingId), outboxReserved: reservation === "reserved" };
    });
  }

  transitionBindingWithOutbox(input: { id: string; transition: SessionTransition; event: BridgeEvent; view: import("../../domain/topic-view.js").TopicViewState; messageId: string; card: object; paneEntryCard: object }): Binding {
    return this.context.transaction(() => {
      const binding = this.bindings.transitionBinding(input.id, input.transition);
      this.database.prepare("INSERT OR IGNORE INTO lifecycle_events(event_id, binding_id, event_type, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?)").run(input.event.eventId, input.id, input.event.type, JSON.stringify(input.event.payload), input.event.occurredAt);
      this.projections.saveTopicView(input.view);
      this.projections.reserveMainCardIntent(input.view, input.messageId, input.card, undefined, input.paneEntryCard);
      return binding;
    });
  }

  private requireBinding(id: string): Binding { const binding = this.bindings.getBinding(id); if (!binding) throw new Error(`Binding not found: ${id}`); return binding; }
}

function matchesRuntimeFence(binding: Binding, expectedPaneId: string, expectedGeneration: number): boolean { return binding.paneId === expectedPaneId && binding.generation === expectedGeneration && (binding.lifecycle === "active" || binding.lifecycle === "draining") && binding.attachment !== "orphaned"; }
function isTraexCompatibleNativeAgent(pane: RecoverOrphanBindingProjectionInput["pane"]): boolean { return pane.agentKind === "traex"; }
function now(): string { return new Date().toISOString(); }

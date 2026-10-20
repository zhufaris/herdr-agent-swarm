import { randomUUID } from "node:crypto";
import { primaryAnswerCreateIdempotencyKey } from "../../domain/delivery-intent.js";
import type { BridgeEvent } from "../../domain/events.js";
import { reduceRunCard, type RunCardView } from "../../domain/run-card-view.js";
import { initialTopicView } from "../../domain/topic-view.js";
import type { Binding, BindingTitleProjectionInput, BindingTitleProjectionResult, OrphanBindingProjectionInput, OrphanBindingProjectionResult, RecoverOrphanBindingProjectionInput, RecoverOrphanBindingProjectionResult, RuntimeDegradationInput, RuntimeDegradationResult } from "../../domain/types.js";
import type { SessionTransition } from "../../domain/pane-thread-lifecycle.js";
import { isNativeTraexSession, sameNativeTraexSession } from "../../domain/traex-session-identity.js";
import { matchesAgentKind } from "../../domain/agent-instance.js";
import type { SqliteContext } from "./context.js";
import type { SqliteBindingLifecycleStore } from "./binding-store.js";
import type { SqliteProjectionStore } from "./projection-store.js";
import { canMentionFeishuOpenId, type PrimaryPromptStateObservationInput, type PrimaryPromptStateObservationResult } from "../../domain/human-review.js";
import { SqliteHumanReviewCandidateStore } from "./human-review-candidate-store.js";
import { SqliteHumanReviewSurfaceStore } from "./human-review-surface-store.js";
import type { EnqueueOutboundReplyInput } from "./outbox-queue-store.js";
import type { PreparedDeliveryConsumer, PreparedDeliveryReservation } from "../../domain/ports/outbox.js";

export class SqliteBindingProjectionStore {
  private preparedDeliveryReservation: PreparedDeliveryReservation | null = null;
  private preparedDeliveryConsumer: PreparedDeliveryConsumer | null = null;

  constructor(
    private readonly context: SqliteContext,
    private readonly bindings: SqliteBindingLifecycleStore,
    private readonly projections: SqliteProjectionStore,
    private readonly dependencies: {
      listRunCardsByPhases(bindingId: string, phases: readonly RunCardView["phase"][]): RunCardView[];
    }
  ) {}
  private get database() { return this.context.database; }

  setPreparedDeliveryReservation(reservation: PreparedDeliveryReservation, consumer: PreparedDeliveryConsumer): void {
    this.preparedDeliveryReservation = reservation;
    this.preparedDeliveryConsumer = consumer;
  }

  backfillRunCardPaneToken(input: { bindingId: string; expectedGeneration: number; paneToken: string; occurredAt: string }): string[] {
    return this.context.transaction("sqlite.binding-projection-store.write", () => {
      const binding = this.requireBinding(input.bindingId);
      if (binding.generation !== input.expectedGeneration || binding.paneToken !== input.paneToken) return [];
      const updatedPromptIds: string[] = [];
      for (const view of this.dependencies.listRunCardsByPhases(input.bindingId, ["queued", "running", "blocked"])) {
        if (view.bindingGeneration !== input.expectedGeneration) continue;
        const next = reduceRunCard(view, { type: "pane-token-refreshed", occurredAt: input.occurredAt, paneToken: input.paneToken });
        if (next === view) continue;
        this.projections.saveRunCard(next);
        updatedPromptIds.push(view.promptId);
      }
      return updatedPromptIds;
    });
  }

  reconcileBindingTitleWithProjection(input: BindingTitleProjectionInput): BindingTitleProjectionResult {
    return this.context.transaction("sqlite.binding-projection-store.write", () => {
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
    return this.context.transaction("sqlite.binding-projection-store.write", () => {
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
    return this.context.transaction("sqlite.binding-projection-store.write", () => {
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
        const next = reduceRunCard(view, { type: "failed", occurredAt: input.occurredAt, notice: input.reason });
        this.projections.saveRunCard(next);
        updatedPromptIds.push(next.promptId);
        const answerPage = this.projections.listAnswerPages(next.promptId).find(({ pageIndex }) => pageIndex === next.answerPageIndex);
        if (!next.answerCardId && next.answerMessageId) {
          this.reservePrimaryAnswer({ id: randomUUID(), idempotencyKey: `run-card:update:${next.promptId}:answer:${next.viewVersion}`, bindingId: next.bindingId, bindingGeneration: next.bindingGeneration, promptId: next.promptId, viewVersion: next.viewVersion, streamPageIndex: answerPage?.pageIndex ?? null, cardRole: "answer", rootMessageId: next.answerMessageId, kind: "card_update", payload: JSON.stringify(input.renderRunCard(next)) });
          answerOutboxReserved = true;
        } else if (!next.answerCardId && !next.answerMessageId && input.rootMessageId) {
          const existing = this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE prompt_id = ? AND card_role = 'answer' AND kind = 'stream_card_create' AND state != 'dismissed' LIMIT 1").get(next.promptId);
          if (!existing) this.reservePrimaryAnswer({ id: randomUUID(), idempotencyKey: primaryAnswerCreateIdempotencyKey(next.promptId), bindingId: next.bindingId, bindingGeneration: next.bindingGeneration, promptId: next.promptId, viewVersion: next.viewVersion, cardRole: "answer", rootMessageId: input.rootMessageId, kind: "stream_card_create", payload: JSON.stringify(input.renderRunCard(next)) });
          answerOutboxReserved = true;
        }
      }
      this.projections.saveTopicView(input.view);
      const reservation = this.projections.reserveMainCardIntent(input.view, input.rootMessageId, input.mainCard, undefined, input.paneEntryCard);
      return { outcome: "orphaned", binding, view: this.projections.loadTopicView(input.bindingId), updatedPromptIds, outboxReserved: answerOutboxReserved || reservation === "reserved" };
    });
  }

  recoverOrphanBindingWithProjection(input: RecoverOrphanBindingProjectionInput): RecoverOrphanBindingProjectionResult {
    return this.context.transaction("sqlite.binding-projection-store.write", () => {
      let binding = this.requireBinding(input.bindingId);
      if (binding.paneId !== input.expectedPaneId || input.pane.paneId !== input.expectedPaneId || binding.generation !== input.expectedGeneration || binding.lifecycle !== "active" || binding.attachment !== "orphaned" || binding.workspaceId !== input.pane.workspaceId) return { outcome: "stale", binding, view: this.projections.loadTopicView(input.bindingId), outboxReserved: false };
      const current = this.projections.loadTopicView(input.bindingId);
      if (current && current.viewVersion > input.view.viewVersion) return { outcome: "stale", binding, view: current, outboxReserved: false };
      const persisted = binding.agentSessionSource && binding.agentSessionAgent && binding.agentSessionKind && binding.agentSessionValue ? { source: binding.agentSessionSource, agent: binding.agentSessionAgent, kind: binding.agentSessionKind, value: binding.agentSessionValue } : null;
      const observed = input.pane.agentSession ?? null;
      const sessionMatches = Boolean(persisted && observed && (binding.agentKind === "traex"
        ? isNativeTraexSession(persisted) && sameNativeTraexSession(persisted, observed)
        : persisted.source === observed.source && persisted.agent === observed.agent && persisted.kind === observed.kind && persisted.value === observed.value));
      const agentMatches = binding.agentKind === "traex" ? isTraexCompatibleNativeAgent(input.pane) : matchesAgentKind(binding.agentKind, input.pane.agentKind);
      if (!binding.traexSessionId || !input.pane.terminalId || !sessionMatches || !agentMatches) return { outcome: "identity_mismatch", binding, view: this.projections.loadTopicView(input.bindingId), outboxReserved: false };
      if (binding.traexSessionId !== input.pane.terminalId) binding = this.bindings.persistBindingPatch(binding.id, { traexSessionId: input.pane.terminalId });
      binding = this.bindings.transitionBinding(input.bindingId, { type: "pane_reattached", replacement: false });
      binding = this.bindings.transitionBinding(input.bindingId, { type: "pane_observed", runtime: input.pane.agentState });
      this.projections.saveTopicView(input.view);
      const reservation = this.projections.reserveMainCardIntent(input.view, input.rootMessageId, input.mainCard, undefined, input.paneEntryCard);
      return { outcome: "recovered", binding, view: this.projections.loadTopicView(input.bindingId), outboxReserved: reservation === "reserved" };
    });
  }

  observePrimaryPromptState(input: PrimaryPromptStateObservationInput): PrimaryPromptStateObservationResult {
    return this.context.transaction("sqlite.binding-projection-store.write", () => {
      let binding = this.bindings.getBinding(input.bindingId);
      const staleNotification = { outcome: "skipped", reason: "stale-routing" } as const;
      if (!binding || !binding.rootMessageId || !matchesRuntimeFence(binding, input.expectedPaneId, input.expectedGeneration)) {
        return { outcome: "stale", binding, notification: staleNotification };
      }
      const rootMessageId = binding.rootMessageId;
      const prompt = this.database.prepare(`SELECT p.state, p.body, p.transcript_turn_id, COALESCE(r.request_text, p.body) AS request_text
        FROM prompt_jobs p JOIN bindings current_binding ON current_binding.id = p.binding_id
        LEFT JOIN run_cards r ON r.prompt_id = p.id
        WHERE p.id = ? AND p.binding_id = ? AND p.state IN ('submitted','running')
          AND p.session_epoch = current_binding.session_epoch
          AND (r.prompt_id IS NULL OR r.binding_generation = ?)`
      ).get(input.promptId, input.bindingId, input.expectedGeneration) as { state: string; body: string; request_text: string; transcript_turn_id: string | null } | undefined;
      if (!prompt) return { outcome: "stale", binding, notification: staleNotification };

      const changed = binding.lastAgentState !== input.state;
      if (changed) binding = this.bindings.transitionBinding(input.bindingId, { type: "pane_observed", runtime: input.state });
      const open = this.database.prepare(`SELECT id, notice, surface_generation, view_version, message_id FROM primary_human_review_episodes
        WHERE binding_id = ? AND binding_generation = ? AND pane_id = ? AND prompt_id = ? AND state = 'open'
        ORDER BY requested_at DESC, id DESC LIMIT 1`
      ).get(input.bindingId, input.expectedGeneration, input.expectedPaneId, input.promptId) as { id: string; notice: string; surface_generation: number; view_version: number; message_id: string | null } | undefined;
      const candidates = new SqliteHumanReviewCandidateStore(this.context);
      const surfaces = new SqliteHumanReviewSurfaceStore(this.context);
      if (this.preparedDeliveryReservation && this.preparedDeliveryConsumer) {
        surfaces.setPreparedDeliveryReservation(this.preparedDeliveryReservation, this.preparedDeliveryConsumer);
      }

      if (input.state === "blocked") {
        if (open) {
          if (open.surface_generation < 1 || !binding.agentSessionValue || !prompt.transcript_turn_id) return { outcome: changed ? "applied" : "unchanged", binding, notification: { outcome: "skipped", reason: "not-transition" } };
          const additions = candidates.absorb({ owner: { kind: "binding", id: binding.id }, ownerGeneration: binding.generation, nativeSessionId: binding.agentSessionValue, turnId: prompt.transcript_turn_id, episodeId: open.id, occurredAt: input.occurredAt });
          if (additions.length === 0) return { outcome: changed ? "applied" : "unchanged", binding, notification: { outcome: "skipped", reason: "not-transition" } };
          const notice = appendNotices(open.notice, additions);
          const revision = open.view_version + 1;
          const updateCard = input.renderHumanReviewNotification({ state: "waiting", bindingId: binding.id, bindingGeneration: binding.generation, primaryName: binding.title, promptId: input.promptId, requestText: prompt.request_text, paneId: input.expectedPaneId, paneToken: binding.paneToken, notice, creatorOpenId: null });
          const createCard = input.renderHumanReviewNotification({ state: "waiting", bindingId: binding.id, bindingGeneration: binding.generation, primaryName: binding.title, promptId: input.promptId, requestText: prompt.request_text, paneId: input.expectedPaneId, paneToken: binding.paneToken, notice, creatorOpenId: binding.creatorOpenId });
          this.database.prepare("UPDATE primary_human_review_episodes SET notice = ?, view_version = ?, card_json = ?, updated_at = ? WHERE id = ? AND state = 'open'").run(notice, revision, JSON.stringify(updateCard), input.occurredAt, open.id);
          surfaces.reservePrimary({ episodeId: open.id, rootMessageId, createCard });
          return { outcome: changed ? "applied" : "unchanged", binding, notification: { outcome: "reserved", kind: "updated", mention: open.message_id ? "omitted" : canMentionFeishuOpenId(binding.creatorOpenId) ? "included" : "omitted", episodeId: open.id } };
        }
        const episodeId = randomUUID();
        const candidateNotices = binding.agentSessionValue && prompt.transcript_turn_id
          ? candidates.absorb({
            owner: { kind: "binding", id: binding.id }, ownerGeneration: binding.generation,
            nativeSessionId: binding.agentSessionValue, turnId: prompt.transcript_turn_id,
            episodeId, occurredAt: input.occurredAt
          })
          : [];
        const notice = [input.notice ?? "Primary 正在等待本地审批或交互输入。", ...candidateNotices]
          .filter(Boolean).join("\n\n").slice(0, 4_000);
        const mention = canMentionFeishuOpenId(binding.creatorOpenId) ? "included" as const : "omitted" as const;
        const createCard = input.renderHumanReviewNotification({
          state: "waiting", bindingId: binding.id, bindingGeneration: binding.generation, primaryName: binding.title,
          promptId: input.promptId, requestText: prompt.request_text, paneId: input.expectedPaneId,
          paneToken: binding.paneToken, notice, creatorOpenId: binding.creatorOpenId
        });
        const updateCard = input.renderHumanReviewNotification({
          state: "waiting", bindingId: binding.id, bindingGeneration: binding.generation, primaryName: binding.title,
          promptId: input.promptId, requestText: prompt.request_text, paneId: input.expectedPaneId,
          paneToken: binding.paneToken, notice, creatorOpenId: null
        });
        this.database.prepare(`INSERT INTO primary_human_review_episodes(
          id, binding_id, binding_generation, pane_id, prompt_id, state, notice, requested_at, resolved_at,
          surface_generation, view_version, delivered_version, card_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, NULL, 1, 1, 0, ?, ?)`).run(
          episodeId, binding.id, binding.generation, input.expectedPaneId, input.promptId, notice, input.occurredAt, JSON.stringify(updateCard), input.occurredAt
        );
        surfaces.reservePrimary({ episodeId, rootMessageId, createCard });
        return { outcome: changed ? "applied" : "unchanged", binding, notification: { outcome: "reserved", kind: "requested", mention, episodeId } };
      }

      if (!open) return { outcome: changed ? "applied" : "unchanged", binding, notification: { outcome: "skipped", reason: "not-transition" } };
      const notice = `Primary 已离开等待状态，当前状态：${input.state}。`;
      const card = input.renderHumanReviewNotification({
        state: "resolved", bindingId: binding.id, bindingGeneration: binding.generation, primaryName: binding.title,
        promptId: input.promptId, requestText: prompt.request_text, paneId: input.expectedPaneId,
        paneToken: binding.paneToken, notice, creatorOpenId: null
      });
      const revision = open.view_version + 1;
      const resolved = this.database.prepare(`UPDATE primary_human_review_episodes SET state = 'resolved', notice = ?, resolved_at = ?,
        view_version = CASE WHEN surface_generation > 0 THEN ? ELSE view_version END,
        card_json = CASE WHEN surface_generation > 0 THEN ? ELSE card_json END, updated_at = ?
        WHERE id = ? AND state = 'open'`).run(notice, input.occurredAt, revision, JSON.stringify(card), input.occurredAt, open.id);
      if (Number(resolved.changes) !== 1) return { outcome: changed ? "applied" : "unchanged", binding, notification: { outcome: "skipped", reason: "not-transition" } };
      if (open.surface_generation > 0) surfaces.reservePrimary({ episodeId: open.id, rootMessageId, createCard: card });
      return { outcome: changed ? "applied" : "unchanged", binding, notification: { outcome: "reserved", kind: "resolved", mention: "omitted", episodeId: open.id } };
    });
  }

  transitionBindingWithOutbox(input: { id: string; transition: SessionTransition; event: BridgeEvent; view: import("../../domain/topic-view.js").TopicViewState; messageId: string; card: object; paneEntryCard: object }): Binding {
    return this.context.transaction("sqlite.binding-projection-store.write", () => {
      const binding = this.bindings.transitionBinding(input.id, input.transition);
      this.database.prepare("INSERT OR IGNORE INTO lifecycle_events(event_id, binding_id, event_type, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?)").run(input.event.eventId, input.id, input.event.type, JSON.stringify(input.event.payload), input.event.occurredAt);
      this.projections.saveTopicView(input.view);
      this.projections.reserveMainCardIntent(input.view, input.messageId, input.card, undefined, input.paneEntryCard);
      return binding;
    });
  }

  private reservePrimaryAnswer(input: EnqueueOutboundReplyInput & { bindingGeneration: number }): void {
    if (!this.preparedDeliveryReservation || !this.preparedDeliveryConsumer) throw new Error("Binding Projection prepared delivery is not connected");
    const receipt = this.preparedDeliveryReservation.reservePreparedOutboundReply(input);
    queueMicrotask(() => {
      for (const delivery of receipt.consumeEffects()) this.preparedDeliveryConsumer!.enqueuePreparedDelivery(delivery);
    });
  }

  private requireBinding(id: string): Binding { const binding = this.bindings.getBinding(id); if (!binding) throw new Error(`Binding not found: ${id}`); return binding; }
}

function appendNotices(current: string, additions: readonly string[]): string {
  const parts = current.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  for (const addition of additions.map((value) => value.trim()).filter(Boolean)) if (!parts.includes(addition)) parts.push(addition);
  return [...parts.join("\n\n")].slice(0, 4_000).join("");
}

function matchesRuntimeFence(binding: Binding, expectedPaneId: string, expectedGeneration: number): boolean { return binding.paneId === expectedPaneId && binding.generation === expectedGeneration && (binding.lifecycle === "active" || binding.lifecycle === "draining") && binding.attachment !== "orphaned"; }
function isTraexCompatibleNativeAgent(pane: RecoverOrphanBindingProjectionInput["pane"]): boolean { return pane.agentKind === "traex"; }
function now(): string { return new Date().toISOString(); }

import { randomUUID } from "node:crypto";
import { InstanceTurnCapacityExceeded } from "../../domain/instance-turn-capacity-error.js";
import type { AcceptInstanceTurnWithCardInput } from "../../domain/ports.js";
import type { AcceptPromptInput } from "../../domain/ports/prompt.js";
import type { OutboxStore } from "../../domain/ports/outbox.js";
import type { AcceptTurnControlOperationInput, TurnControlOperation, TurnControlState, TurnTarget } from "../../domain/turn-control.js";
import type { AgentInstance } from "../../domain/agent-instance.js";
import type { Binding, OutboundReply, PromptJob } from "../../domain/types.js";
import type { RunCardView } from "../../domain/run-card-view.js";
import type { WorkerTurnCardView } from "../../domain/worker-turn-card-view.js";
import { mapTurnControlOperation, type OutboundReplyRow, type TurnControlOperationRow } from "../sqlite-records.js";
import type { SqliteContext } from "./context.js";
import { turnActorProvenance } from "./turn-actor-provenance.js";

export interface TurnControlDependencies {
  getBinding(id: string): Binding | null;
  getAgentInstance(id: string): AgentInstance | null;
  countPendingPrompts(bindingId: string): number;
  countPendingInstanceTurns(instanceId: string, expectedGeneration?: number): number;
  insertRunCard(view: RunCardView): void;
  saveWorkerTurnCard(view: WorkerTurnCardView): void;
  invalidateWorkerCardContexts(view: WorkerTurnCardView, reason: string): unknown;
  enqueueOutboundReply(input: Parameters<OutboxStore["enqueueOutboundReply"]>[0] & { laneKeyOverride?: string }): OutboundReply;
  getPrompt(id: string): PromptJob | null;
}

export class SqliteTurnControlStore {
  constructor(private readonly context: SqliteContext, private readonly dependencies: TurnControlDependencies) {}
  private get database() { return this.context.database; }

  accept(input: AcceptTurnControlOperationInput): { operation: TurnControlOperation; inserted: boolean } {
    if ((input.kind === "steer") !== (input.payload !== null)) throw new Error("Steer requires a payload and interrupt forbids one");
    const timestamp = now();
    return this.context.transaction(() => {
      if (!this.turnTargetExists(input.target)) throw new Error("Turn control target changed before acceptance");
      const inserted = this.database.prepare(`INSERT INTO turn_control_operations(id, idempotency_key, kind, owner_kind, owner_id, project_id, pane_id, generation, agent_session_source, agent_session_agent, agent_session_kind, agent_session_value, logical_turn_id, runtime_turn_id, actor_json, payload, source_message_id, source_card_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?) ON CONFLICT(idempotency_key) DO NOTHING`).run(input.id, input.idempotencyKey, input.kind, input.target.owner.kind, input.target.owner.id, input.target.projectId, input.target.paneId, input.target.generation, input.target.agentSession.source, input.target.agentSession.agent, input.target.agentSession.kind, input.target.agentSession.value, input.target.logicalTurnId, input.target.runtimeTurnId, JSON.stringify(input.actor), input.payload, input.sourceMessageId ?? null, input.sourceCardId ?? null, timestamp, timestamp).changes === 1;
      const operation = this.getByIdempotencyKey(input.idempotencyKey);
      if (!operation) throw new Error("Accepted turn control operation could not be loaded");
      if (!sameRequest(operation, input)) throw new Error("Idempotency key belongs to a different turn control operation");
      if (inserted && input.result) this.enqueueResult(operation, input.result.card, input.result.targetMessageId, input.result.bindingId ?? null);
      return { operation, inserted };
    });
  }

  get(id: string): TurnControlOperation | null { const row = this.database.prepare("SELECT * FROM turn_control_operations WHERE id = ?").get(id) as TurnControlOperationRow | undefined; return row ? mapTurnControlOperation(row) : null; }
  getByIdempotencyKey(key: string): TurnControlOperation | null { const row = this.database.prepare("SELECT * FROM turn_control_operations WHERE idempotency_key = ?").get(key) as TurnControlOperationRow | undefined; return row ? mapTurnControlOperation(row) : null; }
  listAccepted(owner: import("../../domain/turn-control.js").TurnControlOwner): TurnControlOperation[] {
    return (this.database.prepare("SELECT * FROM turn_control_operations WHERE owner_kind = ? AND owner_id = ? AND state = 'accepted' ORDER BY created_at, rowid").all(owner.kind, owner.id) as TurnControlOperationRow[]).map(mapTurnControlOperation);
  }
  getPrioritySteer(owner: import("../../domain/turn-control.js").TurnControlOwner, key: string): { logicalTurnId: string; text: string } | null {
    if (owner.kind === "binding") { const row = this.database.prepare("SELECT id, body FROM prompt_jobs WHERE binding_id = ? AND lark_message_id = ? AND priority = 'priority'").get(owner.id, `priority-steer:${key}`) as { id: string; body: string } | undefined; return row ? { logicalTurnId: row.id, text: row.body } : null; }
    const row = this.database.prepare("SELECT id, text FROM instance_turns WHERE instance_id = ? AND idempotency_key = ? AND priority = 'priority'").get(owner.id, key) as { id: string; text: string } | undefined;
    return row ? { logicalTurnId: row.id, text: row.text } : null;
  }

  claim(id: string): TurnControlOperation | null { return this.context.transaction(() => { const operation = this.get(id); if (!operation || operation.state !== "accepted" || !this.turnTargetExists(operation.target)) return null; const changed = this.database.prepare("UPDATE turn_control_operations SET state = 'dispatching', updated_at = ? WHERE id = ? AND state = 'accepted'").run(now(), id); return changed.changes === 1 ? this.get(id) : null; }); }
  rejectAccepted(input: { id: string; result: Record<string, unknown>; card?: object }): TurnControlOperation | null { return this.finishTransition(input.id, "accepted", "rejected", input.result, input.card); }
  finish(input: { id: string; state: Extract<TurnControlState, "delivered" | "rejected" | "uncertain">; result: Record<string, unknown>; card?: object }): TurnControlOperation | null { return this.finishTransition(input.id, "dispatching", input.state, input.result, input.card); }

  convertToPrimaryPriority(input: { operationId: string; prompt: AcceptPromptInput["prompt"]; view: RunCardView; rootMessageId: string; answerCard: object; maxQueueDepth: number; expectedBindingGeneration: number; result: Record<string, unknown>; card?: object }): { operation: TurnControlOperation; prompt: PromptJob } | null {
    return this.context.transaction(() => {
      const operation = this.get(input.operationId);
      if (!operation || operation.state !== "dispatching" || operation.kind !== "steer" || operation.target.owner.kind !== "binding" || operation.target.owner.id !== input.prompt.bindingId) return null;
      const binding = this.dependencies.getBinding(input.prompt.bindingId);
      if (!binding || binding.generation !== input.expectedBindingGeneration || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached" || binding.paneId !== operation.target.paneId || !bindingSessionMatches(binding, operation.target.agentSession)) return null;
      if (this.dependencies.countPendingPrompts(input.prompt.bindingId) >= input.maxQueueDepth) throw new Error("This topic's prompt queue is full");
      if (this.database.prepare("SELECT 1 FROM prompt_jobs WHERE binding_id = ? AND priority = 'priority' AND state IN ('queued','running') LIMIT 1").get(input.prompt.bindingId)) throw new Error("Primary binding already has a live priority turn");
      const timestamp = now();
      this.database.prepare("INSERT INTO prompt_jobs(id, binding_id, lark_message_id, actor_open_id, body, priority, was_detached, state, observation_state, attempt_count, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'priority', 0, 'queued', 'not_started', 0, NULL, ?, ?)").run(input.prompt.id, input.prompt.bindingId, input.prompt.larkMessageId, input.prompt.actorOpenId, input.prompt.body, timestamp, timestamp);
      this.dependencies.insertRunCard(input.view);
      this.database.prepare("INSERT INTO outbound_replies(id, gateway_id, idempotency_key, binding_id, prompt_id, view_version, card_role, root_message_id, kind, payload, lane_key, state, attempt_count, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'answer', ?, 'stream_card_create', ?, ?, 'pending', 0, ?, ?, ?)").run(randomUUID(), binding.gatewayId, `run-card:create:${input.prompt.id}:answer`, input.prompt.bindingId, input.prompt.id, input.view.viewVersion, input.rootMessageId, JSON.stringify(input.answerCard), `gateway:${binding.gatewayId}:answer:${input.prompt.id}`, timestamp, timestamp, timestamp);
      this.database.prepare("UPDATE turn_control_operations SET state = 'delivered', result_json = ?, updated_at = ? WHERE id = ? AND state = 'dispatching'").run(JSON.stringify(input.result), timestamp, input.operationId);
      const converted = this.get(input.operationId)!; if (input.card) this.updateResult(converted, input.card);
      const prompt = this.dependencies.getPrompt(input.prompt.id); if (!prompt) throw new Error(`Prompt not found: ${input.prompt.id}`);
      return { operation: converted, prompt };
    });
  }

  convertToWorkerPriority(input: { operationId: string; turn: Omit<AcceptInstanceTurnWithCardInput, "view" | "render"> & { view?: AcceptInstanceTurnWithCardInput["view"]; render?: AcceptInstanceTurnWithCardInput["render"] }; maxQueueDepth: number; result: Record<string, unknown>; card?: object }): { operation: TurnControlOperation; logicalTurnId: string } | null {
    return this.context.transaction(() => {
      const operation = this.get(input.operationId);
      if (!operation || operation.state !== "dispatching" || operation.kind !== "steer" || operation.target.owner.kind !== "instance" || operation.target.owner.id !== input.turn.instanceId) return null;
      const instance = this.dependencies.getAgentInstance(input.turn.instanceId);
      if (!instance || instance.generation !== input.turn.instanceGeneration || instance.projectId !== input.turn.projectId || instance.runtimeRef?.paneId !== operation.target.paneId || instance.runtimeRef.nativeSessionId !== operation.target.agentSession.value) return null;
      if (this.dependencies.countPendingInstanceTurns(input.turn.instanceId, input.turn.instanceGeneration) >= input.maxQueueDepth) throw new InstanceTurnCapacityExceeded();
      if (this.database.prepare("SELECT 1 FROM instance_turns WHERE instance_id = ? AND instance_generation = ? AND priority = 'priority' AND state IN ('queued','claimed','dispatching','running','blocked','dispatch-uncertain') LIMIT 1").get(input.turn.instanceId, input.turn.instanceGeneration)) throw new Error("Target instance already has a live priority turn");
      const timestamp = now();
      const actor = turnActorProvenance(input.turn.actor);
      this.database.prepare("INSERT INTO instance_turns(id, idempotency_key, project_id, instance_id, instance_generation, actor_json, actor_kind, source_binding_id, source_binding_generation, source_parent_prompt_id, kind, priority, text, state, parent_turn_id, source_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'priority', ?, 'queued', ?, ?, ?, ?)").run(input.turn.id, input.turn.idempotencyKey, input.turn.projectId, input.turn.instanceId, input.turn.instanceGeneration, JSON.stringify(input.turn.actor), actor.actorKind, actor.sourceBindingId, actor.sourceBindingGeneration, actor.sourceParentPromptId, input.turn.kind, input.turn.text, input.turn.parentTurnId, input.turn.sourceMessageId, timestamp, timestamp);
      this.database.prepare("INSERT INTO instance_events(project_id, instance_id, turn_id, kind, payload_json, created_at) VALUES (?, ?, ?, 'turn.accepted', ?, ?)").run(input.turn.projectId, input.turn.instanceId, input.turn.id, JSON.stringify({ kind: input.turn.kind }), timestamp);
      if ((input.turn.view === undefined) !== (input.turn.render === undefined)) throw new Error("Worker priority card view and renderer must be provided together");
      if (input.turn.view) { this.dependencies.saveWorkerTurnCard(input.turn.view); this.dependencies.invalidateWorkerCardContexts(input.turn.view, "turn.accepted"); }
      this.database.prepare("UPDATE turn_control_operations SET state = 'delivered', result_json = ?, updated_at = ? WHERE id = ? AND state = 'dispatching'").run(JSON.stringify(input.result), timestamp, input.operationId);
      const converted = this.get(input.operationId)!; if (input.card) this.updateResult(converted, input.card);
      return { operation: converted, logicalTurnId: input.turn.id };
    });
  }

  recover(renderResult?: (operation: TurnControlOperation) => object): { accepted: TurnControlOperation[]; uncertain: TurnControlOperation[] } { return this.context.transaction(() => { this.database.prepare("UPDATE turn_control_operations SET state = 'uncertain', result_json = ?, updated_at = ? WHERE state = 'dispatching'").run(JSON.stringify({ status: "delivery-uncertain", reason: "Bridge restarted after native control dispatch began" }), now()); const accepted = (this.database.prepare("SELECT * FROM turn_control_operations WHERE state = 'accepted' ORDER BY created_at, rowid").all() as TurnControlOperationRow[]).map(mapTurnControlOperation); const uncertain = (this.database.prepare("SELECT * FROM turn_control_operations WHERE state = 'uncertain' ORDER BY created_at, rowid").all() as TurnControlOperationRow[]).map(mapTurnControlOperation); if (renderResult) for (const operation of uncertain) this.updateResult(operation, renderResult(operation)); return { accepted, uncertain }; }); }

  private finishTransition(id: string, source: TurnControlState, state: Extract<TurnControlState, "delivered" | "rejected" | "uncertain">, result: Record<string, unknown>, card?: object): TurnControlOperation | null { return this.context.transaction(() => { const changed = this.database.prepare("UPDATE turn_control_operations SET state = ?, result_json = ?, updated_at = ? WHERE id = ? AND state = ?").run(state, JSON.stringify(result), now(), id, source); if (changed.changes !== 1) return null; const operation = this.get(id)!; if (card) this.updateResult(operation, card); return operation; }); }
  private enqueueResult(operation: TurnControlOperation, card: object, targetMessageId: string, bindingId: string | null): void { this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `turn-control:${operation.id}:result`, bindingId, targetRole: "operation_result", rootMessageId: targetMessageId, kind: "card_reply", payload: JSON.stringify(card) }); }
  private updateResult(operation: TurnControlOperation, card: object): void { const initial = this.database.prepare("SELECT * FROM outbound_replies WHERE idempotency_key = ?").get(`turn-control:${operation.id}:result`) as OutboundReplyRow | undefined; if (!initial) return; if (initial.state === "pending" && initial.root_message_id) { this.enqueueResult(operation, card, initial.root_message_id, initial.binding_id); return; } if (initial.state === "delivered" && initial.delivered_message_id) this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `turn-control:${operation.id}:result:${operation.state}`, bindingId: initial.binding_id, targetRole: "operation_result", rootMessageId: initial.delivered_message_id, kind: "card_update", payload: JSON.stringify(card) }); }
  private turnTargetExists(target: TurnTarget): boolean { if (target.owner.kind === "binding") return Boolean(this.database.prepare(`SELECT 1 FROM bindings b JOIN prompt_jobs p ON p.id = ? AND p.binding_id = b.id WHERE b.id = ? AND b.project_id = ? AND b.pane_id = ? AND b.generation = ? AND b.agent_session_source = ? AND b.agent_session_agent = ? AND b.agent_session_kind = ? AND b.agent_session_value = ? AND p.transcript_turn_id = ? AND p.state = 'running'`).get(target.logicalTurnId, target.owner.id, target.projectId, target.paneId, target.generation, target.agentSession.source, target.agentSession.agent, target.agentSession.kind, target.agentSession.value, target.runtimeTurnId)); return Boolean(this.database.prepare(`SELECT 1 FROM agent_instances i JOIN instance_turns t ON t.id = ? AND t.instance_id = i.id AND t.instance_generation = i.generation WHERE i.id = ? AND i.project_id = ? AND i.pane_id = ? AND i.generation = ? AND i.native_session_id = ? AND t.runtime_turn_id = ? AND t.state IN ('dispatching','running','blocked','dispatch-uncertain')`).get(target.logicalTurnId, target.owner.id, target.projectId, target.paneId, target.generation, target.agentSession.value, target.runtimeTurnId)); }
}

function sameRequest(operation: TurnControlOperation, input: AcceptTurnControlOperationInput): boolean { const left = operation.target; const right = input.target; return operation.kind === input.kind && operation.payload === input.payload && operation.sourceMessageId === (input.sourceMessageId ?? null) && operation.sourceCardId === (input.sourceCardId ?? null) && left.owner.kind === right.owner.kind && left.owner.id === right.owner.id && left.projectId === right.projectId && left.paneId === right.paneId && left.generation === right.generation && left.logicalTurnId === right.logicalTurnId && left.runtimeTurnId === right.runtimeTurnId && left.agentSession.source === right.agentSession.source && left.agentSession.agent === right.agentSession.agent && left.agentSession.kind === right.agentSession.kind && left.agentSession.value === right.agentSession.value; }
function bindingSessionMatches(binding: Binding, expected: import("../../domain/types.js").HerdrAgentSession): boolean { return binding.agentSessionSource === expected.source && binding.agentSessionAgent === expected.agent && binding.agentSessionKind === expected.kind && binding.agentSessionValue === expected.value; }
function now(): string { return new Date().toISOString(); }

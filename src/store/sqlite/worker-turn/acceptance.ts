import { randomUUID } from "node:crypto";
import type { AgentInstance } from "../../../domain/agent-instance.js";
import type { ControlActor } from "../../../domain/commands.js";
import type {
  InstanceEventKind,
  InstanceTurn,
} from "../../../domain/instance-turn.js";
import type { AcceptInstanceTurnWithCardInput } from "../../../domain/ports.js";
import type { OutboxStore } from "../../../domain/ports/outbox.js";
import { validateWorkerTurnAdmission } from "../../../domain/worker-turn-policies.js";
import type { WorkerTurnCardView } from "../../../domain/worker-turn-card-view.js";
import type { SqliteContext } from "../context.js";
import { turnActorProvenance } from "../turn-actor-provenance.js";
import type { WorkerTurnProjection } from "./projection.js";
import type { WorkerTurnQueue } from "./queue.js";
import { mapInstanceTurn } from "./records.js";

type BasicInput = {
  id: string;
  idempotencyKey: string;
  actor: ControlActor;
  projectId: string;
  instanceId: string;
  instanceGeneration: number;
  kind: InstanceTurn["kind"];
  priority?: InstanceTurn["priority"];
  text: string;
  maxQueueDepth?: number;
};

export class WorkerTurnAcceptance {
  constructor(
    private readonly context: SqliteContext,
    private readonly dependencies: {
      getAgentInstance(id: string): AgentInstance | null;
      queue: WorkerTurnQueue;
      projection: WorkerTurnProjection;
      enqueueOutboundReply(
        input: Parameters<OutboxStore["enqueueOutboundReply"]>[0] & {
          laneKeyOverride?: string;
        },
      ): unknown;
      invalidateWorkerCardContexts(
        view: WorkerTurnCardView,
        reason: string,
      ): void;
      insertInstanceEvent(
        projectId: string,
        instanceId: string,
        turnId: string | null,
        kind: InstanceEventKind,
        payload: Record<string, unknown>,
      ): number;
    },
  ) {}
  accept(input: BasicInput): { turn: InstanceTurn; inserted: boolean } {
    const current = this.dependencies.getAgentInstance(input.instanceId);
    const existing = this.byKey(input.idempotencyKey);
    const priority = input.priority ?? "normal";
    this.validateGeneration(input, current);
    if (existing) {
      this.validateDuplicate(existing, input, priority);
      return { turn: existing, inserted: false };
    }
    this.validate(input, current, priority);
    const actor = turnActorProvenance(input.actor);
    const timestamp = now();
    const inserted =
      this.context.database
        .prepare(
          `INSERT INTO instance_turns(id, idempotency_key, project_id, instance_id, instance_generation, actor_json, actor_kind, source_binding_id, source_binding_generation, source_parent_prompt_id, kind, priority, text, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?) ON CONFLICT(idempotency_key) DO NOTHING`,
        )
        .run(
          input.id,
          input.idempotencyKey,
          input.projectId,
          input.instanceId,
          input.instanceGeneration,
          JSON.stringify(input.actor),
          actor.actorKind,
          actor.sourceBindingId,
          actor.sourceBindingGeneration,
          actor.sourceParentPromptId,
          input.kind,
          priority,
          input.text,
          timestamp,
          timestamp,
        ).changes === 1;
    const turn = this.byKey(input.idempotencyKey);
    if (!turn) throw new Error("Accepted instance turn could not be loaded");
    this.validateDuplicate(turn, input, priority);
    if (inserted)
      this.dependencies.insertInstanceEvent(
        input.projectId,
        input.instanceId,
        turn.id,
        "turn.accepted",
        { kind: input.kind },
      );
    return { turn, inserted };
  }
  acceptWithCard(
    input: AcceptInstanceTurnWithCardInput & { maxQueueDepth?: number },
  ): { turn: InstanceTurn; view: WorkerTurnCardView; inserted: boolean } {
    const current = this.dependencies.getAgentInstance(input.instanceId);
    const existing = this.byKey(input.idempotencyKey);
    const priority = input.priority ?? "normal";
    this.validateGeneration(input, current);
    if (existing) {
      this.validateDuplicate(existing, input, priority, input.parentTurnId);
      const view = this.dependencies.projection.load(existing.id);
      if (!view)
        throw new Error("Accepted Worker turn card could not be loaded");
      return { turn: existing, view, inserted: false };
    }
    this.validate(input, current, priority, input.parentTurnId);
    if (
      input.view.turnId !== input.id ||
      input.view.instanceId !== input.instanceId ||
      input.view.instanceGeneration !== input.instanceGeneration ||
      input.view.parentTurnId !== input.parentTurnId ||
      input.view.rootMessageId.length === 0
    )
      throw new Error(
        "Worker turn card identity does not match the accepted turn",
      );
    const acceptedView = {
      ...input.view,
      queuePosition:
        priority === "priority"
          ? 0
          : this.dependencies.queue.nextNormalPosition(
              input.instanceId,
              input.instanceGeneration,
            ),
    };
    const actor = turnActorProvenance(input.actor);
    const timestamp = now();
    const inserted =
      this.context.database
        .prepare(
          `INSERT INTO instance_turns(id, idempotency_key, project_id, instance_id, instance_generation, actor_json, actor_kind, source_binding_id, source_binding_generation, source_parent_prompt_id, kind, priority, text, state, parent_turn_id, source_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?) ON CONFLICT(idempotency_key) DO NOTHING`,
        )
        .run(
          input.id,
          input.idempotencyKey,
          input.projectId,
          input.instanceId,
          input.instanceGeneration,
          JSON.stringify(input.actor),
          actor.actorKind,
          actor.sourceBindingId,
          actor.sourceBindingGeneration,
          actor.sourceParentPromptId,
          input.kind,
          priority,
          input.text,
          input.parentTurnId,
          input.sourceMessageId,
          timestamp,
          timestamp,
        ).changes === 1;
    const turn = this.byKey(input.idempotencyKey);
    if (!turn) throw new Error("Accepted instance turn could not be loaded");
    this.validateDuplicate(turn, input, priority, input.parentTurnId);
    if (inserted) {
      this.dependencies.projection.save(acceptedView);
      this.dependencies.insertInstanceEvent(
        input.projectId,
        input.instanceId,
        turn.id,
        "turn.accepted",
        { kind: input.kind },
      );
      if (current?.workerSessionLifecycle === "active")
        this.dependencies.enqueueOutboundReply({
          id: randomUUID(),
          idempotencyKey: `stream-card:${turn.id}:0`,
          bindingId: null,
          workerTurnId: turn.id,
          viewVersion: acceptedView.viewVersion,
          rootMessageId: acceptedView.rootMessageId,
          kind: "stream_card_create",
          payload: JSON.stringify({ card: input.render(acceptedView), stream: { pageIndex: 0, pageStart: 0, elementId: acceptedView.elementId } }),
        });
      this.dependencies.invalidateWorkerCardContexts(
        acceptedView,
        "turn.accepted",
      );
    }
    const view = this.dependencies.projection.load(turn.id);
    if (!view) throw new Error("Accepted Worker turn card could not be loaded");
    return { turn, view, inserted };
  }
  private validate(
    input: BasicInput,
    current: AgentInstance | null,
    priority: InstanceTurn["priority"],
    parentTurnId?: string | null,
  ): void {
    validateWorkerTurnAdmission({
      current,
      projectId: input.projectId,
      instanceGeneration: input.instanceGeneration,
      priority,
      pendingCount: this.dependencies.queue.countPending(
        input.instanceId,
        input.instanceGeneration,
      ),
      maxQueueDepth: input.maxQueueDepth,
      hasLivePriorityTurn: this.dependencies.queue.hasLivePriority(
        input.instanceId,
        input.instanceGeneration,
      ),
      hasActiveRuntimeTurn: this.dependencies.queue.hasActiveRuntime(
        input.instanceId,
        input.instanceGeneration,
      ),
      kind: parentTurnId === undefined ? undefined : input.kind,
      parentTurnId,
      parent: parentTurnId ? this.byId(parentTurnId) : null,
      instanceId: input.instanceId,
    });
  }
  private validateGeneration(
    input: BasicInput,
    current: AgentInstance | null,
  ): void {
    if (
      !current ||
      current.projectId !== input.projectId ||
      current.generation !== input.instanceGeneration
    )
      throw new Error("Instance generation changed before turn acceptance");
  }
  private validateDuplicate(
    turn: InstanceTurn,
    input: BasicInput,
    priority: InstanceTurn["priority"],
    parentTurnId?: string | null,
  ): void {
    if (
      turn.instanceId !== input.instanceId ||
      turn.text !== input.text ||
      turn.kind !== input.kind ||
      turn.priority !== priority ||
      (parentTurnId !== undefined && turn.parentTurnId !== parentTurnId)
    )
      throw new Error("Idempotency key belongs to a different instance turn");
  }
  private byKey(key: string): InstanceTurn | null {
    return mapInstanceTurn(
      this.context.database
        .prepare("SELECT * FROM instance_turns WHERE idempotency_key = ?")
        .get(key) as Record<string, unknown> | undefined,
    );
  }
  private byId(id: string): InstanceTurn | null {
    return mapInstanceTurn(
      this.context.database
        .prepare("SELECT * FROM instance_turns WHERE id = ?")
        .get(id) as Record<string, unknown> | undefined,
    );
  }
}
function now(): string {
  return new Date().toISOString();
}

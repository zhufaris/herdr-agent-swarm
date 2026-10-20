import type { ControlActor } from "../../../domain/commands.js";
import type {
  InstanceTurn,
  InstanceTurnState,
} from "../../../domain/instance-turn.js";
import type {
  RunProgressEvent,
  RunProgressSummary,
} from "../../../domain/run-card-view.js";
import type {
  WorkerTurnCardPage,
  WorkerTurnCardView,
} from "../../../domain/worker-turn-card-view.js";

export function mapWorkerTurnCard(
  row: Record<string, unknown> | undefined,
): WorkerTurnCardView | null {
  if (!row) return null;
  const progressEvents = parseWorkerProgress(row.progress_json);
  return {
    turnId: String(row.turn_id),
    instanceId: String(row.instance_id),
    instanceGeneration: Number(row.instance_generation),
    workerSessionGeneration: Number(row.worker_session_generation ?? 1),
    workerName: String(row.worker_name),
    parentTurnId:
      row.parent_turn_id === null ? null : String(row.parent_turn_id),
    rootMessageId: String(row.root_message_id),
    messageId: row.message_id === null ? null : String(row.message_id),
    cardId: row.card_id === null ? null : String(row.card_id),
    elementId: String(row.element_id),
    progressSequence: Number(row.progress_sequence ?? 0),
    phase: String(row.phase) as WorkerTurnCardView["phase"],
    requestText: String(row.request_text),
    answer: String(row.answer),
    timelineItems: [],
    statusTitle:
      row.status_title === null || row.status_title === undefined
        ? null
        : String(row.status_title),
    tokenCount:
      row.token_count === null || row.token_count === undefined
        ? null
        : Number(row.token_count),
    progressEvents,
    progressSummary: summarizeWorkerProgress(progressEvents),
    queuePosition: Number(row.queue_position),
    startedAt: row.started_at === null ? null : String(row.started_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
    notice: row.notice === null ? null : String(row.notice),
    resultCapture: String(
      row.result_capture,
    ) as WorkerTurnCardView["resultCapture"],
    workerMain: JSON.parse(
      String(row.worker_main_ref_json ?? "{}"),
    ) as WorkerTurnCardView["workerMain"],
    primaryAnswer:
      row.primary_answer_ref_json === null ||
      row.primary_answer_ref_json === undefined
        ? null
        : (JSON.parse(
            String(row.primary_answer_ref_json),
          ) as WorkerTurnCardView["primaryAnswer"]),
    pageIndex: Number(row.page_index),
    pageStart: Number(row.page_start),
    sequence: Number(row.sequence),
    viewVersion: Number(row.view_version),
    deliveredVersion: Number(row.delivered_version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function mapWorkerTurnCardPage(
  row: Record<string, unknown>,
): WorkerTurnCardPage {
  return {
    id: String(row.id),
    turnId: String(row.turn_id),
    pageIndex: Number(row.page_index),
    pageStart: Number(row.page_start),
    elementId: String(row.element_id),
    messageId: row.message_id === null ? null : String(row.message_id),
    cardId: row.card_id === null ? null : String(row.card_id),
    deliveryMode: "streaming",
    state: String(row.state) as WorkerTurnCardPage["state"],
    sequence: Number(row.sequence),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function mapInstanceTurn(
  row: Record<string, unknown> | undefined,
): InstanceTurn | null {
  return row
    ? {
        id: String(row.id),
        idempotencyKey: String(row.idempotency_key),
        projectId: String(row.project_id),
        instanceId: String(row.instance_id),
        instanceGeneration: Number(row.instance_generation),
        actor: JSON.parse(String(row.actor_json)) as ControlActor,
        kind: String(row.kind) as InstanceTurn["kind"],
        priority: String(row.priority ?? "normal") as InstanceTurn["priority"],
        text: String(row.text),
        state: String(row.state) as InstanceTurnState,
        result: row.result === null ? null : String(row.result),
        error: row.error === null ? null : String(row.error),
        parentTurnId:
          row.parent_turn_id === null || row.parent_turn_id === undefined
            ? null
            : String(row.parent_turn_id),
        sourceMessageId:
          row.source_message_id === null || row.source_message_id === undefined
            ? null
            : String(row.source_message_id),
        runtimeTurnId:
          row.runtime_turn_id === null || row.runtime_turn_id === undefined
            ? null
            : String(row.runtime_turn_id),
        runtimeTurnStartedAt:
          row.runtime_turn_started_at === null ||
          row.runtime_turn_started_at === undefined
            ? null
            : String(row.runtime_turn_started_at),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      }
    : null;
}

export function parseJsonRecord(payload: string): Record<string, unknown> {
  try {
    const value = JSON.parse(payload) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseWorkerProgress(value: unknown): RunProgressEvent[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]")) as unknown;
    return Array.isArray(parsed) ? (parsed as RunProgressEvent[]) : [];
  } catch {
    return [];
  }
}

function summarizeWorkerProgress(
  events: readonly RunProgressEvent[],
): RunProgressSummary {
  let stepTotal = 0;
  let stepDone = 0;
  for (const event of events)
    if (event.kind === "step") {
      stepTotal += 1;
      if (event.state === "done") stepDone += 1;
    }
  return { total: events.length, stepTotal, stepDone };
}

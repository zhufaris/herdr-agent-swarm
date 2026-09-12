import { randomUUID } from "node:crypto";
import type { AdoptExternalTurnInput } from "../../domain/ports/workflow.js";
import type { ExternalTurnAdoption, PromptJob } from "../../domain/types.js";
import { reduceRunCard } from "../../domain/run-card-view.js";
import { mapPrompt, type BindingRow, type PromptRow } from "../sqlite-records.js";
import type { SqliteContext } from "./context.js";
import type { SqliteProjectionStore } from "./projection-store.js";

export class SqliteExternalTurnAdoptionStore {
  constructor(
    private readonly context: SqliteContext,
    private readonly projections: SqliteProjectionStore,
    private readonly getPrompt: (id: string) => PromptJob | null
  ) {}

  getActiveExternalPrompt(bindingId: string, expectedGeneration: number): PromptJob | null {
    const rows = this.context.database.prepare(`SELECT p.* FROM prompt_jobs p JOIN bindings b ON b.id = p.binding_id JOIN run_cards r ON r.prompt_id = p.id
      WHERE p.binding_id = ? AND p.state = 'running' AND p.execution_origin = 'herdr'
        AND p.transcript_turn_id IS NOT NULL AND p.transcript_turn_started_at IS NOT NULL
        AND b.generation = ? AND r.binding_generation = b.generation AND b.state = 'active' AND b.lifecycle = 'active' AND b.attachment = 'attached'
      ORDER BY p.created_at, p.rowid LIMIT 2`).all(bindingId, expectedGeneration) as PromptRow[];
    return rows.length === 1 ? mapPrompt(rows[0]!) : null;
  }

  adoptExternalTurn(input: AdoptExternalTurnInput): ExternalTurnAdoption {
    return this.context.transaction(() => {
      const binding = this.context.database.prepare("SELECT * FROM bindings WHERE id = ?").get(input.bindingId) as BindingRow | undefined;
      if (!binding || !binding.root_message_id || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached" || Number(binding.generation) !== input.expectedGeneration || binding.pane_id !== input.expectedPaneId
        || binding.agent_session_source !== input.expectedSession.source || binding.agent_session_agent !== input.expectedSession.agent || binding.agent_session_kind !== input.expectedSession.kind || binding.agent_session_value !== input.expectedSession.value) {
        return { outcome: "stale_binding", prompt: null, supersededPromptIds: [], outboxReserved: false };
      }
      const owners = this.context.database.prepare("SELECT * FROM prompt_jobs WHERE transcript_turn_id = ? ORDER BY id LIMIT 2").all(input.turnId) as PromptRow[];
      const owned = owners[0];
      if (owned) return { outcome: owners.length === 1 && owned.binding_id === input.bindingId ? "already_owned" : "conflict", prompt: mapPrompt(owned), supersededPromptIds: [], outboxReserved: false };
      const active = this.context.database.prepare("SELECT * FROM prompt_jobs WHERE binding_id = ? AND state = 'running' ORDER BY created_at, id").all(input.bindingId) as PromptRow[];
      const superseded = input.supersede;
      const supersessionIsFenced = superseded !== undefined
        && active.length === 1
        && active[0]!.id === superseded.promptId
        && active[0]!.observation_state === "detached"
        && active[0]!.transcript_turn_id === superseded.turnId
        && active[0]!.transcript_turn_started_at === superseded.startedAt
        && Date.parse(input.startedAt) > Date.parse(superseded.startedAt);
      const identitylessDetached = active.every((row) => row.observation_state === "detached" && row.transcript_turn_id === null);
      if (!identitylessDetached && !supersessionIsFenced) return { outcome: "conflict", prompt: null, supersededPromptIds: [], outboxReserved: false };
      const timestamp = now();
      const gatewayId = typeof binding.gateway_id === "string" ? binding.gateway_id : "feishu:primary";
      const supersededPromptIds = active.map((row) => row.id);
      for (const row of active) {
        this.context.database.prepare("UPDATE prompt_jobs SET state = 'failed', observation_state = 'completed', error = ?, updated_at = ? WHERE id = ?").run("Superseded by a newer external Herdr turn; prior outcome is uncertain", timestamp, row.id);
        this.context.database.prepare("UPDATE run_cards SET phase = 'failed', finished_at = ?, notice = ?, queue_position = 0, view_version = view_version + 1, updated_at = ? WHERE prompt_id = ? AND phase IN ('running','blocked')").run(input.startedAt, "A newer Herdr turn started while this detached turn had an uncertain outcome.", timestamp, row.id);
      }
      const normalizedRequest = normalizeExternalRequest(input.requestText);
      const candidates = input.supersede ? [] : (this.context.database.prepare(`
        SELECT p.* FROM prompt_jobs p JOIN run_cards c ON c.prompt_id = p.id
        WHERE p.binding_id = ? AND p.state = 'queued' AND p.observation_state = 'not_started'
          AND c.binding_generation = ? AND c.pane_id = ? AND p.created_at <= ?
        ORDER BY p.created_at, p.id
      `).all(input.bindingId, input.expectedGeneration, input.expectedPaneId, input.startedAt) as PromptRow[])
        .filter((row) => normalizeExternalRequest(row.body) === normalizedRequest);
      let promptId: string;
      let outcome: ExternalTurnAdoption["outcome"];
      let outboxReserved = false;
      if (candidates.length === 1) {
        promptId = candidates[0]!.id;
        outcome = "adopted_queued";
        this.context.database.prepare(`UPDATE prompt_jobs SET execution_origin = 'herdr', state = 'running', observation_state = 'attached', dispatched_at = ?, transcript_turn_id = ?, transcript_turn_started_at = ?, error = NULL, updated_at = ? WHERE id = ?`).run(input.startedAt, input.turnId, input.startedAt, timestamp, promptId);
        const queuedView = this.projections.loadRunCard(promptId)!;
        const runningView = reduceRunCard(queuedView, { type: "started", occurredAt: input.startedAt });
        outboxReserved = Number(this.context.database.prepare("UPDATE outbound_replies SET payload = ?, view_version = ?, updated_at = ? WHERE prompt_id = ? AND kind = 'stream_card_create' AND card_role = 'answer' AND state = 'pending' AND first_claimed_at IS NULL AND attempt_count = 0 AND card_id_checkpoint IS NULL").run(JSON.stringify(input.answerCardFor(runningView)), runningView.viewVersion, timestamp, promptId).changes) > 0;
      } else {
        promptId = input.externalPromptId;
        outcome = "created_external";
        this.context.database.prepare(`INSERT INTO prompt_jobs(id, binding_id, lark_message_id, actor_open_id, body, execution_origin, state, observation_state, dispatched_at, transcript_turn_id, transcript_turn_started_at, attempt_count, created_at, updated_at) VALUES (?, ?, ?, 'herdr', ?, 'herdr', 'running', 'attached', ?, ?, ?, 1, ?, ?)`).run(promptId, input.bindingId, input.externalMessageId, input.requestText, input.startedAt, input.turnId, input.startedAt, input.startedAt, timestamp);
        const view = { ...input.externalView, promptId, bindingId: input.bindingId, bindingGeneration: input.expectedGeneration, paneId: input.expectedPaneId, requestText: input.requestText, queuePosition: 0 };
        const runningView = reduceRunCard(view, { type: "started", occurredAt: input.startedAt });
        this.projections.insertRunCard(view);
        this.context.database.prepare(`INSERT INTO outbound_replies(id, gateway_id, idempotency_key, binding_id, prompt_id, view_version, card_role, root_message_id, kind, payload, lane_key, state, attempt_count, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'answer', ?, 'stream_card_create', ?, ?, 'pending', 0, ?, ?, ?)`).run(randomUUID(), gatewayId, `run-card:create:${promptId}:answer`, input.bindingId, promptId, runningView.viewVersion, binding.root_message_id, JSON.stringify(input.answerCardFor(runningView)), `gateway:${gatewayId}:answer:${promptId}`, timestamp, timestamp, timestamp);
        outboxReserved = true;
      }
      const prompt = this.getPrompt(promptId);
      if (!prompt) throw new Error(`Prompt not found: ${promptId}`);
      return { outcome, prompt, supersededPromptIds, outboxReserved };
    });
  }
}

function now(): string { return new Date().toISOString(); }
function normalizeExternalRequest(value: string): string { return value.replace(/\r\n?/g, "\n"); }

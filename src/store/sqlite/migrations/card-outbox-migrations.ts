import { answerElementId } from "../../../domain/run-card-view.js";
import { outboundLaneKeySql } from "../../outbox-lanes.js";
import { canonicalizeAnswerPayload } from "../answer-payload.js";
import { confirmDeliveryRecoveries } from "../delivery-recovery-evidence.js";
import type { SqliteContext } from "../context.js";
import { runForeignKeySafeRebuild } from "./foreign-key-safe-rebuild.js";

export class CardOutboxMigrations {
  constructor(private readonly context: SqliteContext) {}

  finishLegacyDeliveredAnswerPages(timestamp: string): void {
    this.context.database.prepare(`
      UPDATE answer_pages AS page
      SET state = 'finished',
          sequence = MAX(sequence, COALESCE((
            SELECT MAX(COALESCE(reply.view_version, json_extract(reply.payload, '$.sequence'), 0))
            FROM outbound_replies AS reply
            WHERE reply.prompt_id = page.prompt_id AND reply.card_role = 'answer'
              AND reply.kind = 'stream_finish' AND reply.state = 'delivered'
              AND reply.root_message_id = page.card_id
              AND json_extract(reply.payload, '$.pageIndex') IS NULL
              AND json_extract(reply.payload, '$.summary') IN ('Completed', 'Failed')
          ), sequence)),
          updated_at = ?
      WHERE page.state = 'active'
        AND EXISTS (SELECT 1 FROM run_cards AS card WHERE card.prompt_id = page.prompt_id AND card.phase IN ('completed', 'failed'))
        AND EXISTS (
          SELECT 1 FROM outbound_replies AS reply
          WHERE reply.prompt_id = page.prompt_id AND reply.card_role = 'answer'
            AND reply.kind = 'stream_finish' AND reply.state = 'delivered'
            AND reply.root_message_id = page.card_id
            AND json_extract(reply.payload, '$.pageIndex') IS NULL
            AND json_extract(reply.payload, '$.summary') IN ('Completed', 'Failed')
        )
    `).run(timestamp);
    this.dismissStreamsForFinishedAnswerPages(timestamp);
  }

  dismissStreamsForFinishedAnswerPages(timestamp: string): void {
    this.context.database.prepare(`
      UPDATE outbound_replies
      SET state = 'dismissed', error = 'Answer stream targets a legacy page that was already finished', updated_at = ?
      WHERE state IN ('pending', 'dead_letter') AND kind IN ('stream_content', 'stream_finish')
        AND EXISTS (
          SELECT 1 FROM answer_pages AS page
          WHERE page.prompt_id = outbound_replies.prompt_id AND page.state = 'finished'
            AND page.card_id = outbound_replies.root_message_id
        )
    `).run(timestamp);
  }

  canonicalizeLegacyAnswerTargets(timestamp: string): void {
    let afterPromptId = "";
    while (true) {
      const cards = this.context.database.prepare("SELECT prompt_id, answer_element_id, answer_page_index FROM run_cards WHERE answer_element_id != '' AND prompt_id > ? ORDER BY prompt_id LIMIT 100")
        .all(afterPromptId) as Array<{ prompt_id: string; answer_element_id: string; answer_page_index: number }>;
      if (cards.length === 0) return;
      for (const card of cards) {
        const canonical = answerElementId(card.prompt_id, Number(card.answer_page_index));
        if (canonical !== card.answer_element_id) this.context.database.prepare("UPDATE run_cards SET answer_element_id = ?, updated_at = ? WHERE prompt_id = ?").run(canonical, timestamp, card.prompt_id);
        const replies = this.context.database.prepare("SELECT id, kind, payload FROM outbound_replies INDEXED BY outbound_replies_prompt_role_state WHERE prompt_id = ? AND card_role = 'answer' AND state IN ('pending','dead_letter')").all(card.prompt_id) as Array<{ id: string; kind: string; payload: string }>;
        for (const reply of replies) {
          const payload = canonicalizeAnswerPayload(reply.kind, reply.payload, card.prompt_id, canonical);
          if (payload !== reply.payload) this.context.database.prepare("UPDATE outbound_replies SET payload = ?, updated_at = ? WHERE id = ?").run(payload, timestamp, reply.id);
        }
      }
      afterPromptId = cards.at(-1)!.prompt_id;
    }
  }

  ensureOutboundTargetRole(): void {
    const columns = new Set((this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!columns.has("target_role")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN target_role TEXT CHECK(target_role IN ('session_status','operation_result'))");
    this.context.database.prepare("UPDATE outbound_replies SET target_role = 'session_status' WHERE target_role IS NULL AND kind = 'card_reply' AND idempotency_key LIKE 'status-card:%'").run();
    this.context.database.prepare("UPDATE outbound_replies SET target_role = 'operation_result' WHERE target_role IS NULL AND kind = 'card_reply' AND idempotency_key LIKE 'model:%'").run();
    this.context.database.prepare("UPDATE outbound_replies SET state = 'dismissed', error = 'Status update target was an operation result', updated_at = ? WHERE state = 'pending' AND kind = 'card_update' AND prompt_id IS NULL AND root_message_id IN (SELECT delivered_message_id FROM outbound_replies WHERE target_role = 'operation_result' AND delivered_message_id IS NOT NULL)").run(now());
    this.context.database.prepare("UPDATE bindings SET status_message_id = root_message_id, updated_at = ? WHERE root_message_id IS NOT NULL AND status_message_id IN (SELECT delivered_message_id FROM outbound_replies WHERE target_role = 'operation_result' AND delivered_message_id IS NOT NULL)").run(now());
  }

  ensureQueryIndexes(): void {
    this.context.database.exec(`
      CREATE INDEX IF NOT EXISTS bindings_state_created ON bindings(state, created_at, id);
      CREATE INDEX IF NOT EXISTS bindings_root_created ON bindings(root_message_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS run_cards_binding_phase_created ON run_cards(binding_id, phase, created_at, prompt_id);
      CREATE INDEX IF NOT EXISTS outbound_replies_prompt_role_state ON outbound_replies(prompt_id, card_role, state);
      CREATE INDEX IF NOT EXISTS outbound_replies_prompt_kind_state_updated ON outbound_replies(prompt_id, kind, state, updated_at);
      CREATE INDEX IF NOT EXISTS outbound_replies_binding_target_version ON outbound_replies(binding_id, target_role, view_version);
      CREATE INDEX IF NOT EXISTS outbound_replies_retention ON outbound_replies(state, updated_at, delivery_order);
      CREATE INDEX IF NOT EXISTS inbound_messages_retention ON inbound_messages(state, updated_at, event_id);
      CREATE INDEX IF NOT EXISTS prompt_jobs_priority_queue ON prompt_jobs(binding_id, state, priority, created_at);
    `);
  }

  ensureOutboundDismissedState(): void {
    const schema = this.context.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'outbound_replies'").get() as { sql: string } | undefined;
    if (schema?.sql.includes("'dismissed'") && schema.sql.includes("'stream_card_create'")) return;
    const columns = new Set((this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>).map(({ name }) => name));
    const workerTurnId = columns.has("worker_turn_id") ? "worker_turn_id" : "NULL";
    runForeignKeySafeRebuild(this.context, "Outbound-state migration", () => this.context.database.exec(`
      CREATE TABLE outbound_replies_next(
        id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, binding_id TEXT REFERENCES bindings(id), prompt_id TEXT, worker_turn_id TEXT REFERENCES instance_turns(id) ON DELETE CASCADE, view_version INTEGER, card_sequence INTEGER, selection_id TEXT, card_role TEXT CHECK(card_role IN ('task','answer')), target_role TEXT CHECK(target_role IN ('session_status','operation_result')), root_message_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('text','card_reply','card_update','stream_card_create','stream_content','stream_finish')), payload TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','delivered','dead_letter','dismissed')), attempt_count INTEGER NOT NULL DEFAULT 0, error TEXT, delivered_message_id TEXT, card_id_checkpoint TEXT, delivery_order INTEGER, lane_key TEXT, next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO outbound_replies_next(id, idempotency_key, binding_id, prompt_id, worker_turn_id, view_version, card_sequence, selection_id, card_role, target_role, root_message_id, kind, payload, state, attempt_count, error, delivered_message_id, card_id_checkpoint, delivery_order, lane_key, next_attempt_at, created_at, updated_at)
      SELECT id, idempotency_key, binding_id, prompt_id, ${workerTurnId}, view_version, card_sequence, selection_id, card_role, target_role, root_message_id, kind, payload, state, attempt_count, error, delivered_message_id, card_id_checkpoint, delivery_order, ${outboundLaneKeySql(workerTurnId, "NULL", "NULL")}, next_attempt_at, created_at, updated_at FROM outbound_replies;
      DROP TABLE outbound_replies; ALTER TABLE outbound_replies_next RENAME TO outbound_replies;
      CREATE INDEX outbound_replies_pending ON outbound_replies(state, next_attempt_at, created_at);
    `));
  }

  ensureStreamingCardColumns(): void {
    const columns = this.context.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("answer_card_id")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN answer_card_id TEXT");
    if (!names.has("answer_element_id")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN answer_element_id TEXT NOT NULL DEFAULT ''");
    if (!names.has("answer_sequence")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN answer_sequence INTEGER NOT NULL DEFAULT 0");
    if (!names.has("answer_page_index")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN answer_page_index INTEGER NOT NULL DEFAULT 0");
    if (!names.has("answer_page_start")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN answer_page_start INTEGER NOT NULL DEFAULT 0");
    this.context.database.exec("UPDATE run_cards SET answer_element_id = 'answer-content-' || replace(prompt_id, ':', '-') WHERE answer_element_id = ''");
  }

  ensureAnswerPages(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS answer_pages(
        prompt_id TEXT NOT NULL REFERENCES prompt_jobs(id), page_index INTEGER NOT NULL, message_id TEXT, card_id TEXT, element_id TEXT NOT NULL,
        source_start INTEGER NOT NULL, sequence INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL CHECK(state IN ('creating','active','frozen','finished')), delivery_mode TEXT NOT NULL DEFAULT 'streaming' CHECK(delivery_mode IN ('streaming','static')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(prompt_id, page_index)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS answer_pages_active ON answer_pages(prompt_id) WHERE state = 'active';
      INSERT OR IGNORE INTO answer_pages(prompt_id, page_index, message_id, card_id, element_id, source_start, sequence, state, delivery_mode, created_at, updated_at)
      SELECT prompt_id, answer_page_index, answer_message_id, answer_card_id, answer_element_id, answer_page_start, answer_sequence,
        CASE WHEN answer_card_id IS NULL THEN 'creating' ELSE 'active' END, 'streaming', created_at, updated_at FROM run_cards;
    `);
  }

  ensureAnswerPageDeliveryMode(): void {
    const columns = new Set((this.context.database.prepare("PRAGMA table_info(answer_pages)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!columns.has("delivery_mode")) this.context.database.exec("ALTER TABLE answer_pages ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'streaming' CHECK(delivery_mode IN ('streaming','static'))");
  }

  ensureMainCardSequences(): void {
    const bindingColumns = new Set((this.context.database.prepare("PRAGMA table_info(bindings)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!bindingColumns.has("status_card_sequence")) this.context.database.exec("ALTER TABLE bindings ADD COLUMN status_card_sequence INTEGER NOT NULL DEFAULT 0");
    const outboundColumns = new Set((this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!outboundColumns.has("card_sequence")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN card_sequence INTEGER");
  }

  ensureRequestCardOutboxColumns(): void {
    const columns = this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("prompt_id")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN prompt_id TEXT");
    if (!names.has("view_version")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN view_version INTEGER");
    if (!names.has("card_role")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN card_role TEXT CHECK(card_role IN ('task','answer'))");
  }

  ensureRunCardActivityColumn(): void {
    const columns = this.context.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === "activity_at")) return;
    this.context.database.exec("ALTER TABLE run_cards ADD COLUMN activity_at TEXT");
    this.context.database.exec("UPDATE run_cards SET activity_at = created_at WHERE activity_at IS NULL");
  }

  ensureRunCardQueueFeedbackColumn(): void {
    const names = new Set((this.context.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!names.has("queue_feedback_json")) {
      this.context.database.exec("ALTER TABLE run_cards ADD COLUMN queue_feedback_json TEXT");
    }
  }

  ensureOutboundCardCheckpoint(): void {
    const columns = this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "card_id_checkpoint")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN card_id_checkpoint TEXT");
  }

  ensureOutboundDeliveryOrder(): void {
    const columns = this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "delivery_order")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN delivery_order INTEGER");
    this.context.database.exec(`
      UPDATE outbound_replies SET delivery_order = rowid WHERE delivery_order IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS outbound_replies_delivery_order ON outbound_replies(delivery_order);
      CREATE TRIGGER IF NOT EXISTS outbound_replies_assign_delivery_order
      AFTER INSERT ON outbound_replies WHEN NEW.delivery_order IS NULL
      BEGIN
        UPDATE outbound_replies SET delivery_order = (SELECT COALESCE(MAX(delivery_order), 0) + 1 FROM outbound_replies WHERE id != NEW.id) WHERE id = NEW.id;
      END;
    `);
  }

  ensureOutboundLaneKey(): void {
    const columns = this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "lane_key")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN lane_key TEXT");
    this.context.database.exec(`
      UPDATE outbound_replies SET lane_key = ${outboundLaneKeySql()} WHERE lane_key IS NULL OR lane_key = '';
      CREATE INDEX IF NOT EXISTS outbound_replies_lane_order ON outbound_replies(state, lane_key, delivery_order);
    `);
  }

  ensureOutboxLaneHeads(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS outbox_lane_heads(
        lane_key TEXT PRIMARY KEY, reply_id TEXT NOT NULL UNIQUE REFERENCES outbound_replies(id) ON DELETE CASCADE,
        delivery_order INTEGER NOT NULL, next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outbox_lane_heads_delivery_order ON outbox_lane_heads(delivery_order);
      CREATE INDEX IF NOT EXISTS outbox_lane_heads_next_attempt ON outbox_lane_heads(next_attempt_at, delivery_order);
    `);
    const trigger = this.context.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'outbox_lane_heads_after_insert'").get() as { sql: string } | undefined;
    if (!trigger?.sql.includes("outbox_lane_quarantines")) this.context.database.exec(`
      DROP TRIGGER IF EXISTS outbox_lane_heads_after_insert;
      DROP TRIGGER IF EXISTS outbox_lane_heads_after_update;
      DROP TRIGGER IF EXISTS outbox_lane_heads_after_delete;
      CREATE TRIGGER outbox_lane_heads_after_insert AFTER INSERT ON outbound_replies
      WHEN NEW.delivery_order IS NOT NULL
      BEGIN
        DELETE FROM outbox_lane_heads WHERE lane_key = NEW.lane_key;
        INSERT INTO outbox_lane_heads(lane_key, reply_id, delivery_order, next_attempt_at, created_at)
          SELECT lane_key, id, delivery_order, next_attempt_at, created_at
          FROM outbound_replies
          WHERE lane_key = NEW.lane_key AND state = 'pending'
            AND NOT EXISTS (SELECT 1 FROM outbox_lane_quarantines q WHERE q.lane_key = NEW.lane_key AND q.state = 'active')
          ORDER BY delivery_order LIMIT 1;
      END;
      CREATE TRIGGER outbox_lane_heads_after_update AFTER UPDATE OF state, lane_key, delivery_order, next_attempt_at ON outbound_replies
      BEGIN
        DELETE FROM outbox_lane_heads WHERE lane_key = OLD.lane_key;
        INSERT INTO outbox_lane_heads(lane_key, reply_id, delivery_order, next_attempt_at, created_at)
          SELECT lane_key, id, delivery_order, next_attempt_at, created_at
          FROM outbound_replies
          WHERE lane_key = OLD.lane_key AND state = 'pending'
            AND NOT EXISTS (SELECT 1 FROM outbox_lane_quarantines q WHERE q.lane_key = OLD.lane_key AND q.state = 'active')
          ORDER BY delivery_order LIMIT 1;
        DELETE FROM outbox_lane_heads WHERE lane_key = NEW.lane_key;
        INSERT INTO outbox_lane_heads(lane_key, reply_id, delivery_order, next_attempt_at, created_at)
          SELECT lane_key, id, delivery_order, next_attempt_at, created_at
          FROM outbound_replies
          WHERE lane_key = NEW.lane_key AND state = 'pending'
            AND NOT EXISTS (SELECT 1 FROM outbox_lane_quarantines q WHERE q.lane_key = NEW.lane_key AND q.state = 'active')
          ORDER BY delivery_order LIMIT 1;
      END;
      CREATE TRIGGER outbox_lane_heads_after_delete AFTER DELETE ON outbound_replies
      BEGIN
        DELETE FROM outbox_lane_heads WHERE lane_key = OLD.lane_key;
        INSERT INTO outbox_lane_heads(lane_key, reply_id, delivery_order, next_attempt_at, created_at)
          SELECT lane_key, id, delivery_order, next_attempt_at, created_at
          FROM outbound_replies
          WHERE lane_key = OLD.lane_key AND state = 'pending'
            AND NOT EXISTS (SELECT 1 FROM outbox_lane_quarantines q WHERE q.lane_key = OLD.lane_key AND q.state = 'active')
          ORDER BY delivery_order LIMIT 1;
      END;
    `);
    this.context.database.exec(`
      DELETE FROM outbox_lane_heads;
      INSERT INTO outbox_lane_heads(lane_key, reply_id, delivery_order, next_attempt_at, created_at)
        SELECT pending.lane_key, pending.id, pending.delivery_order, pending.next_attempt_at, pending.created_at
        FROM outbound_replies pending
        WHERE pending.state = 'pending'
          AND NOT EXISTS (SELECT 1 FROM outbox_lane_quarantines q WHERE q.lane_key = pending.lane_key AND q.state = 'active')
          AND pending.delivery_order = (
            SELECT MIN(candidate.delivery_order)
            FROM outbound_replies candidate
            WHERE candidate.state = 'pending' AND candidate.lane_key = pending.lane_key
          );
    `);
  }

  ensureOutboxLaneQuarantines(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS outbox_lane_quarantines(
        lane_key TEXT PRIMARY KEY, failed_reply_id TEXT NOT NULL REFERENCES outbound_replies(id) ON DELETE CASCADE,
        lane_class TEXT NOT NULL CHECK(lane_class IN ('answer_stream','main_card','replaceable_card','immutable')),
        failure_class TEXT NOT NULL CHECK(failure_class IN ('transient','permanent','unknown')),
        state TEXT NOT NULL CHECK(state IN ('active','released')), action TEXT NOT NULL, reason TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, released_at TEXT
      );
      CREATE INDEX IF NOT EXISTS outbox_lane_quarantines_state ON outbox_lane_quarantines(state, created_at);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (5);
    `);
  }

  ensureIndependentReplyLanes(): void {
    const migrated = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 7").get();
    if (migrated) return;
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      this.context.database.exec(`
        UPDATE outbox_lane_quarantines
        SET lane_key = 'reply:' || failed_reply_id, updated_at = datetime('now')
        WHERE failed_reply_id IN (
          SELECT id FROM outbound_replies WHERE kind IN ('card_reply','text')
        );
        UPDATE outbound_replies
        SET lane_key = 'reply:' || id
        WHERE kind IN ('card_reply','text');
        DELETE FROM outbox_lane_heads;
        INSERT INTO outbox_lane_heads(lane_key, reply_id, delivery_order, next_attempt_at, created_at)
          SELECT pending.lane_key, pending.id, pending.delivery_order, pending.next_attempt_at, pending.created_at
          FROM outbound_replies pending
          WHERE pending.state = 'pending'
            AND NOT EXISTS (SELECT 1 FROM outbox_lane_quarantines q WHERE q.lane_key = pending.lane_key AND q.state = 'active')
            AND pending.delivery_order = (
              SELECT MIN(candidate.delivery_order)
              FROM outbound_replies candidate
              WHERE candidate.state = 'pending' AND candidate.lane_key = pending.lane_key
            );
        INSERT INTO schema_migrations(version) VALUES (7);
      `);
      this.context.database.exec("COMMIT");
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }
  }

  ensureCardContextOutboxLanes(): void {
    const migrated = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 22").get();
    if (migrated) return;
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      this.context.database.exec(`
        UPDATE outbound_replies
        SET lane_key = 'worker-main:' || worker_id || ':' || worker_session_generation
        WHERE worker_id IS NOT NULL AND worker_session_generation IS NOT NULL;

        UPDATE outbound_replies
        SET lane_key = 'primary-answer:' || prompt_id || ':' || (
          SELECT binding_generation FROM run_cards WHERE run_cards.prompt_id = outbound_replies.prompt_id
        )
        WHERE kind = 'card_update' AND card_role = 'answer' AND prompt_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM run_cards WHERE run_cards.prompt_id = outbound_replies.prompt_id);

        UPDATE outbound_replies
        SET lane_key = 'primary-main:' || binding_id || ':' || (
          SELECT generation FROM bindings WHERE bindings.id = outbound_replies.binding_id
        )
        WHERE kind = 'card_update' AND target_role = 'session_status' AND binding_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM bindings WHERE bindings.id = outbound_replies.binding_id);

        UPDATE OR REPLACE outbox_lane_quarantines
        SET lane_key = (
          SELECT lane_key FROM outbound_replies WHERE outbound_replies.id = outbox_lane_quarantines.failed_reply_id
        ), updated_at = datetime('now')
        WHERE EXISTS (
          SELECT 1 FROM outbound_replies
          WHERE outbound_replies.id = outbox_lane_quarantines.failed_reply_id
            AND outbound_replies.lane_key != outbox_lane_quarantines.lane_key
        );

        DELETE FROM outbox_lane_heads;
        INSERT INTO outbox_lane_heads(lane_key, reply_id, delivery_order, next_attempt_at, created_at)
          SELECT pending.lane_key, pending.id, pending.delivery_order, pending.next_attempt_at, pending.created_at
          FROM outbound_replies pending
          WHERE pending.state = 'pending'
            AND NOT EXISTS (SELECT 1 FROM outbox_lane_quarantines q WHERE q.lane_key = pending.lane_key AND q.state = 'active')
            AND pending.delivery_order = (
              SELECT MIN(candidate.delivery_order) FROM outbound_replies candidate
              WHERE candidate.state = 'pending' AND candidate.lane_key = pending.lane_key
            );
        INSERT INTO schema_migrations(version) VALUES (22);
      `);
      this.context.database.exec("COMMIT");
    } catch (error) { if (this.context.database.isTransaction) this.context.database.exec("ROLLBACK"); throw error; }
  }

  ensureOutboundClaims(): void {
    this.context.transaction(() => {
      const names = new Set((this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>).map((column) => column.name));
      for (const [name, type] of [["claim_attempt_id", "TEXT"], ["claimed_fence", "INTEGER"], ["claimed_owner_id", "TEXT"], ["claimed_at", "TEXT"], ["first_claimed_at", "TEXT"], ["payload_hash", "TEXT"], ["projection_key", "TEXT"], ["snapshot_revision", "INTEGER NOT NULL DEFAULT 1"]]) {
        if (!names.has(name!)) this.context.database.exec(`ALTER TABLE outbound_replies ADD COLUMN ${name} ${type}`);
      }
      const immutableClaim = this.context.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'outbound_replies_immutable_claim'").get() as { sql: string } | undefined;
      const groupTargets = names.has("target_chat_id") && names.has("thread_alias_id");
      const workerTarget = names.has("worker_thread_id");
      if (immutableClaim && (!immutableClaim.sql.includes("work_class") || groupTargets && !immutableClaim.sql.includes("target_chat_id") || workerTarget && !immutableClaim.sql.includes("worker_thread_id"))) this.context.database.exec("DROP TRIGGER outbound_replies_immutable_claim");
      const groupTargetColumns = groupTargets ? `target_chat_id, thread_alias_id, ${workerTarget ? "worker_thread_id, " : ""}` : "";
      const groupTargetChanges = groupTargets ? `NEW.target_chat_id IS NOT OLD.target_chat_id OR NEW.thread_alias_id IS NOT OLD.thread_alias_id OR ${workerTarget ? "NEW.worker_thread_id IS NOT OLD.worker_thread_id OR " : ""}` : "";
      this.context.database.exec(`
        CREATE INDEX IF NOT EXISTS outbound_replies_projection_revision ON outbound_replies(projection_key, snapshot_revision DESC);
        CREATE INDEX IF NOT EXISTS outbound_replies_claims ON outbound_replies(claim_attempt_id) WHERE claim_attempt_id IS NOT NULL;
        CREATE TRIGGER IF NOT EXISTS outbound_replies_immutable_claim
        BEFORE UPDATE OF payload, intent_json, intent_kind, renderer_revision, root_message_id, ${groupTargetColumns}kind, view_version, card_sequence, idempotency_key, lane_key, work_class, binding_id, prompt_id, worker_turn_id, worker_id, worker_session_generation, card_role, target_role, selection_id, stream_page_index, stream_element_id, snapshot_revision, first_claimed_at ON outbound_replies
        WHEN OLD.first_claimed_at IS NOT NULL AND (
          NEW.payload IS NOT OLD.payload OR NEW.intent_json IS NOT OLD.intent_json OR NEW.intent_kind IS NOT OLD.intent_kind OR NEW.renderer_revision IS NOT OLD.renderer_revision
          OR NEW.root_message_id IS NOT OLD.root_message_id OR ${groupTargetChanges}NEW.kind IS NOT OLD.kind OR NEW.view_version IS NOT OLD.view_version OR NEW.card_sequence IS NOT OLD.card_sequence
          OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.lane_key IS NOT OLD.lane_key OR NEW.work_class IS NOT OLD.work_class OR NEW.binding_id IS NOT OLD.binding_id OR NEW.prompt_id IS NOT OLD.prompt_id
          OR NEW.worker_turn_id IS NOT OLD.worker_turn_id OR NEW.worker_id IS NOT OLD.worker_id OR NEW.worker_session_generation IS NOT OLD.worker_session_generation
          OR NEW.card_role IS NOT OLD.card_role OR NEW.target_role IS NOT OLD.target_role OR NEW.selection_id IS NOT OLD.selection_id
          OR NEW.stream_page_index IS NOT OLD.stream_page_index OR NEW.stream_element_id IS NOT OLD.stream_element_id
          OR NEW.snapshot_revision IS NOT OLD.snapshot_revision OR NEW.first_claimed_at IS NOT OLD.first_claimed_at
        ) BEGIN SELECT RAISE(ABORT, 'immutable_outbound_revision'); END;
        CREATE TRIGGER IF NOT EXISTS outbound_replies_claim_delete
        BEFORE DELETE ON outbound_replies WHEN OLD.claim_attempt_id IS NOT NULL
        BEGIN SELECT RAISE(ABORT, 'active_outbound_claim'); END;
      `);
    });
  }

  ensureDeliveryRecoveries(): void {
    if (this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 31").get()) return;
    this.context.transaction(() => {
      this.context.database.exec(`
        CREATE TABLE delivery_recoveries(
          failed_reply_id TEXT PRIMARY KEY, snapshot_revision INTEGER NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('unresolved','replacement_pending','recovered','dismissed')),
          failure_class TEXT NOT NULL, http_status INTEGER, lark_error_code TEXT, reason TEXT NOT NULL,
          action TEXT NOT NULL, replacement_reply_id TEXT, resolved_by_reply_id TEXT, resolved_message_id TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT
        );
        CREATE INDEX delivery_recoveries_state ON delivery_recoveries(state, created_at);
        CREATE TRIGGER delivery_recoveries_dead_letter AFTER UPDATE OF state ON outbound_replies
        WHEN NEW.state = 'dead_letter' AND OLD.state != 'dead_letter'
        BEGIN
          INSERT INTO delivery_recoveries(failed_reply_id, snapshot_revision, state, failure_class, http_status, lark_error_code, reason, action, created_at, updated_at)
          VALUES (NEW.id, NEW.snapshot_revision, 'unresolved', COALESCE(NEW.failure_class, 'unknown'), NEW.http_status, NEW.lark_error_code, substr(COALESCE(NEW.error, 'Unknown failure'), 1, 500), 'blocked', NEW.updated_at, NEW.updated_at)
          ON CONFLICT(failed_reply_id) DO UPDATE SET state = 'unresolved', action = 'blocked', replacement_reply_id = NULL,
            resolved_by_reply_id = NULL, resolved_message_id = NULL, resolved_at = NULL, updated_at = excluded.updated_at;
        END;
        INSERT INTO delivery_recoveries(failed_reply_id, snapshot_revision, state, failure_class, http_status, lark_error_code, reason, action, created_at, updated_at)
        SELECT o.id, o.snapshot_revision, 'unresolved', COALESCE(o.failure_class, 'legacy'), o.http_status, o.lark_error_code,
          substr(COALESCE(o.error, 'Unknown legacy failure'), 1, 500),
          CASE WHEN o.kind = 'card_update' AND q.action = 'released_newer_snapshot' THEN 'released_newer_snapshot' ELSE 'legacy_unproven' END,
          COALESCE(o.dead_lettered_at, o.updated_at), o.updated_at
        FROM outbound_replies o LEFT JOIN outbox_lane_quarantines q ON q.failed_reply_id = o.id
        WHERE o.state = 'dead_letter';
      `);
      const delivered = this.context.database.prepare("SELECT id FROM outbound_replies WHERE state = 'delivered' ORDER BY delivery_order").all() as Array<{ id: string }>;
      for (const reply of delivered) confirmDeliveryRecoveries(this.context, reply.id);
      this.context.database.prepare("INSERT INTO schema_migrations(version) VALUES (31)").run();
    });
  }

  ensureAnswerRecoveryEvidence(): void {
    if (this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 32").get()) return;
    this.context.transaction(() => {
      this.context.database.exec(`
        CREATE TABLE answer_delivery_coverage(
          reply_id TEXT PRIMARY KEY REFERENCES outbound_replies(id) ON DELETE CASCADE,
          prompt_id TEXT NOT NULL, binding_generation INTEGER NOT NULL, page_index INTEGER NOT NULL,
          source_start INTEGER NOT NULL, source_end INTEGER NOT NULL, source_hash TEXT NOT NULL
        );
        CREATE TABLE answer_recovery_links(
          failed_reply_id TEXT PRIMARY KEY REFERENCES delivery_recoveries(failed_reply_id),
          prompt_id TEXT NOT NULL, binding_generation INTEGER NOT NULL,
          source_page_index INTEGER NOT NULL, replacement_page_index INTEGER NOT NULL,
          source_start INTEGER NOT NULL, source_end INTEGER NOT NULL, source_hash TEXT NOT NULL
        );
        CREATE INDEX answer_recovery_links_page ON answer_recovery_links(prompt_id, binding_generation, replacement_page_index);
        CREATE TABLE answer_recovery_candidates(
          failed_reply_id TEXT NOT NULL REFERENCES answer_recovery_links(failed_reply_id),
          reply_id TEXT NOT NULL REFERENCES outbound_replies(id) ON DELETE CASCADE,
          PRIMARY KEY(failed_reply_id, reply_id)
        );
        CREATE INDEX answer_recovery_candidates_reply ON answer_recovery_candidates(reply_id);
        CREATE TRIGGER answer_delivery_coverage_immutable BEFORE UPDATE ON answer_delivery_coverage
        BEGIN SELECT RAISE(ABORT, 'immutable_answer_coverage'); END;
        CREATE TRIGGER answer_delivery_coverage_before_claim BEFORE INSERT ON answer_delivery_coverage
        WHEN EXISTS (SELECT 1 FROM outbound_replies WHERE id = NEW.reply_id AND (first_claimed_at IS NOT NULL OR state != 'pending'))
        BEGIN SELECT RAISE(ABORT, 'immutable_answer_coverage'); END;
        CREATE TRIGGER answer_recovery_candidate_before_claim BEFORE INSERT ON answer_recovery_candidates
        WHEN EXISTS (SELECT 1 FROM outbound_replies WHERE id = NEW.reply_id AND (first_claimed_at IS NOT NULL OR state != 'pending'))
        BEGIN SELECT RAISE(ABORT, 'immutable_answer_coverage'); END;
        INSERT INTO schema_migrations(version) VALUES (32);
      `);
    });
  }

  ensureOutboundWorkClass(): void {
    const names = new Set((this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>).map((column) => column.name));
    const applied = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 33").get();
    if (names.has("work_class") && applied) return;
    if (!names.has("work_class")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN work_class TEXT NOT NULL DEFAULT 'live' CHECK(work_class IN ('live','history'))");
    this.context.database.exec(`UPDATE outbound_replies SET work_class = 'history' WHERE idempotency_key LIKE 'main-card:rebuild:%' OR idempotency_key LIKE 'answer-static-rebuild:%' OR idempotency_key LIKE 'stream-rebuild:%' OR idempotency_key LIKE 'startup-lite:%' OR idempotency_key LIKE 'startup-lite-content:%'`);
    this.context.database.exec("CREATE INDEX IF NOT EXISTS outbound_replies_work_class_delivery ON outbound_replies(work_class, state, delivery_order)");
    this.context.database.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (33)").run();
  }

  ensureGroupCardCreates(): void {
    const schema = this.context.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'outbound_replies'").get() as { sql: string } | undefined;
    const names = new Set((this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>).map((column) => column.name));
    if (schema?.sql.includes("'group_card_create'") && names.has("target_chat_id") && names.has("thread_alias_id")) { this.context.database.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (34)").run(); return; }
    runForeignKeySafeRebuild(this.context, "Group-card migration", () => this.context.database.exec(`
      DROP TRIGGER IF EXISTS answer_delivery_coverage_before_claim;
      DROP TRIGGER IF EXISTS answer_recovery_candidate_before_claim;
      CREATE TABLE outbound_replies_next(
        id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, binding_id TEXT REFERENCES bindings(id), prompt_id TEXT, worker_turn_id TEXT REFERENCES instance_turns(id) ON DELETE CASCADE, worker_id TEXT REFERENCES agent_instances(id) ON DELETE CASCADE, worker_session_generation INTEGER, view_version INTEGER, card_sequence INTEGER, selection_id TEXT, stream_page_index INTEGER, stream_element_id TEXT, card_role TEXT CHECK(card_role IN ('task','answer')), target_role TEXT CHECK(target_role IN ('session_status','operation_result')), thread_alias_id TEXT REFERENCES binding_thread_aliases(id), target_chat_id TEXT, work_class TEXT NOT NULL DEFAULT 'live' CHECK(work_class IN ('live','history')), root_message_id TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('text','card_reply','card_update','group_card_create','stream_card_create','stream_content','stream_finish')), payload TEXT NOT NULL, intent_kind TEXT, intent_json TEXT, renderer_revision INTEGER, state TEXT NOT NULL CHECK(state IN ('pending','delivered','dead_letter','dismissed')), attempt_count INTEGER NOT NULL DEFAULT 0, error TEXT, delivered_message_id TEXT, card_id_checkpoint TEXT, delivery_order INTEGER, lane_key TEXT, next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, failure_class TEXT CHECK(failure_class IN ('transient','permanent','unknown')), http_status INTEGER, lark_error_code TEXT, auto_recovery_count INTEGER NOT NULL DEFAULT 0, dead_lettered_at TEXT, claim_attempt_id TEXT, claimed_fence INTEGER, claimed_owner_id TEXT, claimed_at TEXT, first_claimed_at TEXT, payload_hash TEXT, projection_key TEXT, snapshot_revision INTEGER NOT NULL DEFAULT 1,
        CHECK((kind = 'group_card_create' AND root_message_id IS NULL AND target_chat_id IS NOT NULL AND thread_alias_id IS NOT NULL) OR (kind != 'group_card_create' AND root_message_id IS NOT NULL AND target_chat_id IS NULL AND thread_alias_id IS NULL))
      );
      INSERT INTO outbound_replies_next(id, idempotency_key, binding_id, prompt_id, worker_turn_id, worker_id, worker_session_generation, view_version, card_sequence, selection_id, stream_page_index, stream_element_id, card_role, target_role, thread_alias_id, target_chat_id, work_class, root_message_id, kind, payload, intent_kind, intent_json, renderer_revision, state, attempt_count, error, delivered_message_id, card_id_checkpoint, delivery_order, lane_key, next_attempt_at, created_at, updated_at, failure_class, http_status, lark_error_code, auto_recovery_count, dead_lettered_at, claim_attempt_id, claimed_fence, claimed_owner_id, claimed_at, first_claimed_at, payload_hash, projection_key, snapshot_revision)
      SELECT id, idempotency_key, binding_id, prompt_id, worker_turn_id, worker_id, worker_session_generation, view_version, card_sequence, selection_id, stream_page_index, stream_element_id, card_role, target_role, NULL, NULL, work_class, root_message_id, kind, payload, intent_kind, intent_json, renderer_revision, state, attempt_count, error, delivered_message_id, card_id_checkpoint, delivery_order, lane_key, next_attempt_at, created_at, updated_at, failure_class, http_status, lark_error_code, auto_recovery_count, dead_lettered_at, claim_attempt_id, claimed_fence, claimed_owner_id, claimed_at, first_claimed_at, payload_hash, projection_key, snapshot_revision FROM outbound_replies;
      DROP TABLE outbound_replies; ALTER TABLE outbound_replies_next RENAME TO outbound_replies;
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (34);
    `));
    this.ensureOutboundDeliveryOrder(); this.ensureOutboundLaneKey(); this.ensureOutboundFailureMetadata(); this.ensureTypedDeliveryIntents(); this.ensureOutboundClaims(); this.ensureDeliveryRecoveryTrigger(); this.ensureQueryIndexes();
    if (this.context.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'answer_delivery_coverage'").get()) this.context.database.exec(`CREATE TRIGGER IF NOT EXISTS answer_delivery_coverage_before_claim BEFORE INSERT ON answer_delivery_coverage WHEN EXISTS (SELECT 1 FROM outbound_replies WHERE id = NEW.reply_id AND (first_claimed_at IS NOT NULL OR state != 'pending')) BEGIN SELECT RAISE(ABORT, 'immutable_answer_coverage'); END;`);
    if (this.context.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'answer_recovery_candidates'").get()) this.context.database.exec(`CREATE TRIGGER IF NOT EXISTS answer_recovery_candidate_before_claim BEFORE INSERT ON answer_recovery_candidates WHEN EXISTS (SELECT 1 FROM outbound_replies WHERE id = NEW.reply_id AND (first_claimed_at IS NOT NULL OR state != 'pending')) BEGIN SELECT RAISE(ABORT, 'immutable_answer_coverage'); END;`);
    this.context.database.exec(`CREATE INDEX IF NOT EXISTS outbound_replies_pending ON outbound_replies(state, next_attempt_at, created_at); CREATE INDEX IF NOT EXISTS outbound_replies_work_class_delivery ON outbound_replies(work_class, state, delivery_order); CREATE INDEX IF NOT EXISTS outbound_replies_worker_pending ON outbound_replies(worker_turn_id, state) WHERE worker_turn_id IS NOT NULL; CREATE INDEX IF NOT EXISTS outbound_replies_worker_stream ON outbound_replies(worker_turn_id, kind, stream_page_index, selection_id, delivery_order DESC) WHERE worker_turn_id IS NOT NULL AND state IN ('pending','delivered','dead_letter');`);
    this.ensureOutboxLaneHeads();
  }

  ensureWorkerThreadTargets(): void {
    const schema = this.context.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'outbound_replies'").get() as { sql: string } | undefined;
    const names = new Set((this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>).map((column) => column.name));
    if (names.has("worker_thread_id") && schema?.sql.includes("worker_thread_id IS NOT NULL")) {
      this.context.database.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (36)").run();
      this.ensureOutboundClaims();
      return;
    }
    runForeignKeySafeRebuild(this.context, "Worker-thread outbox migration", () => this.context.database.exec(`
      DROP TRIGGER IF EXISTS answer_delivery_coverage_before_claim;
      DROP TRIGGER IF EXISTS answer_recovery_candidate_before_claim;
      CREATE TABLE outbound_replies_next(
        id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, binding_id TEXT REFERENCES bindings(id), prompt_id TEXT, worker_turn_id TEXT REFERENCES instance_turns(id) ON DELETE CASCADE, worker_id TEXT REFERENCES agent_instances(id) ON DELETE CASCADE, worker_session_generation INTEGER, view_version INTEGER, card_sequence INTEGER, selection_id TEXT, stream_page_index INTEGER, stream_element_id TEXT, card_role TEXT CHECK(card_role IN ('task','answer')), target_role TEXT CHECK(target_role IN ('session_status','operation_result')), thread_alias_id TEXT REFERENCES binding_thread_aliases(id), worker_thread_id TEXT REFERENCES worker_session_threads(id), target_chat_id TEXT, work_class TEXT NOT NULL DEFAULT 'live' CHECK(work_class IN ('live','history')), root_message_id TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('text','card_reply','card_update','group_card_create','stream_card_create','stream_content','stream_finish')), payload TEXT NOT NULL, intent_kind TEXT, intent_json TEXT, renderer_revision INTEGER, state TEXT NOT NULL CHECK(state IN ('pending','delivered','dead_letter','dismissed')), attempt_count INTEGER NOT NULL DEFAULT 0, error TEXT, delivered_message_id TEXT, card_id_checkpoint TEXT, delivery_order INTEGER, lane_key TEXT, next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, failure_class TEXT CHECK(failure_class IN ('transient','permanent','unknown')), http_status INTEGER, lark_error_code TEXT, auto_recovery_count INTEGER NOT NULL DEFAULT 0, dead_lettered_at TEXT, claim_attempt_id TEXT, claimed_fence INTEGER, claimed_owner_id TEXT, claimed_at TEXT, first_claimed_at TEXT, payload_hash TEXT, projection_key TEXT, snapshot_revision INTEGER NOT NULL DEFAULT 1,
        CHECK((kind = 'group_card_create' AND root_message_id IS NULL AND target_chat_id IS NOT NULL AND ((thread_alias_id IS NOT NULL AND worker_thread_id IS NULL) OR (thread_alias_id IS NULL AND worker_thread_id IS NOT NULL))) OR (kind != 'group_card_create' AND root_message_id IS NOT NULL AND target_chat_id IS NULL AND thread_alias_id IS NULL AND worker_thread_id IS NULL))
      );
      INSERT INTO outbound_replies_next(id, idempotency_key, binding_id, prompt_id, worker_turn_id, worker_id, worker_session_generation, view_version, card_sequence, selection_id, stream_page_index, stream_element_id, card_role, target_role, thread_alias_id, worker_thread_id, target_chat_id, work_class, root_message_id, kind, payload, intent_kind, intent_json, renderer_revision, state, attempt_count, error, delivered_message_id, card_id_checkpoint, delivery_order, lane_key, next_attempt_at, created_at, updated_at, failure_class, http_status, lark_error_code, auto_recovery_count, dead_lettered_at, claim_attempt_id, claimed_fence, claimed_owner_id, claimed_at, first_claimed_at, payload_hash, projection_key, snapshot_revision)
      SELECT id, idempotency_key, binding_id, prompt_id, worker_turn_id, worker_id, worker_session_generation, view_version, card_sequence, selection_id, stream_page_index, stream_element_id, card_role, target_role, thread_alias_id, NULL, target_chat_id, work_class, root_message_id, kind, payload, intent_kind, intent_json, renderer_revision, state, attempt_count, error, delivered_message_id, card_id_checkpoint, delivery_order, lane_key, next_attempt_at, created_at, updated_at, failure_class, http_status, lark_error_code, auto_recovery_count, dead_lettered_at, claim_attempt_id, claimed_fence, claimed_owner_id, claimed_at, first_claimed_at, payload_hash, projection_key, snapshot_revision FROM outbound_replies;
      DROP TABLE outbound_replies; ALTER TABLE outbound_replies_next RENAME TO outbound_replies;
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (36);
    `));
    this.ensureOutboundDeliveryOrder(); this.ensureOutboundLaneKey(); this.ensureOutboundFailureMetadata(); this.ensureTypedDeliveryIntents(); this.ensureOutboundClaims(); this.ensureDeliveryRecoveryTrigger(); this.ensureQueryIndexes();
    if (this.context.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'answer_delivery_coverage'").get()) this.context.database.exec(`CREATE TRIGGER IF NOT EXISTS answer_delivery_coverage_before_claim BEFORE INSERT ON answer_delivery_coverage WHEN EXISTS (SELECT 1 FROM outbound_replies WHERE id = NEW.reply_id AND (first_claimed_at IS NOT NULL OR state != 'pending')) BEGIN SELECT RAISE(ABORT, 'immutable_answer_coverage'); END;`);
    if (this.context.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'answer_recovery_candidates'").get()) this.context.database.exec(`CREATE TRIGGER IF NOT EXISTS answer_recovery_candidate_before_claim BEFORE INSERT ON answer_recovery_candidates WHEN EXISTS (SELECT 1 FROM outbound_replies WHERE id = NEW.reply_id AND (first_claimed_at IS NOT NULL OR state != 'pending')) BEGIN SELECT RAISE(ABORT, 'immutable_answer_coverage'); END;`);
    this.context.database.exec(`CREATE INDEX IF NOT EXISTS outbound_replies_pending ON outbound_replies(state, next_attempt_at, created_at); CREATE INDEX IF NOT EXISTS outbound_replies_work_class_delivery ON outbound_replies(work_class, state, delivery_order); CREATE INDEX IF NOT EXISTS outbound_replies_worker_pending ON outbound_replies(worker_turn_id, state) WHERE worker_turn_id IS NOT NULL; CREATE INDEX IF NOT EXISTS outbound_replies_worker_stream ON outbound_replies(worker_turn_id, kind, stream_page_index, selection_id, delivery_order DESC) WHERE worker_turn_id IS NOT NULL AND state IN ('pending','delivered','dead_letter');`);
    this.ensureOutboxLaneHeads();
  }

  private ensureDeliveryRecoveryTrigger(): void {
    this.context.database.exec(`CREATE TRIGGER IF NOT EXISTS delivery_recoveries_dead_letter AFTER UPDATE OF state ON outbound_replies WHEN NEW.state = 'dead_letter' AND OLD.state != 'dead_letter' BEGIN INSERT INTO delivery_recoveries(failed_reply_id, snapshot_revision, state, failure_class, http_status, lark_error_code, reason, action, created_at, updated_at) VALUES (NEW.id, NEW.snapshot_revision, 'unresolved', COALESCE(NEW.failure_class, 'unknown'), NEW.http_status, NEW.lark_error_code, substr(COALESCE(NEW.error, 'Unknown failure'), 1, 500), 'blocked', NEW.updated_at, NEW.updated_at) ON CONFLICT(failed_reply_id) DO UPDATE SET state = 'unresolved', action = 'blocked', replacement_reply_id = NULL, resolved_by_reply_id = NULL, resolved_message_id = NULL, resolved_at = NULL, updated_at = excluded.updated_at; END;`);
  }

  ensureOutboundFailureMetadata(): void {
    const names = new Set((this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!names.has("failure_class")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN failure_class TEXT CHECK(failure_class IN ('transient','permanent','unknown'))");
    if (!names.has("http_status")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN http_status INTEGER");
    if (!names.has("lark_error_code")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN lark_error_code TEXT");
    if (!names.has("auto_recovery_count")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN auto_recovery_count INTEGER NOT NULL DEFAULT 0");
    if (!names.has("dead_lettered_at")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN dead_lettered_at TEXT");
    this.context.database.exec("CREATE INDEX IF NOT EXISTS outbound_replies_auto_recovery ON outbound_replies(state, failure_class, auto_recovery_count, dead_lettered_at)");
  }

  ensureDualRequestCardColumns(): void {
    const columns = this.context.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("answer_message_id")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN answer_message_id TEXT");
    if (!names.has("answer_delivered_version")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN answer_delivered_version INTEGER NOT NULL DEFAULT 0");
  }

  ensureRunCardAnswerState(): void {
    const columns = this.context.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("answer_segments_json")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN answer_segments_json TEXT NOT NULL DEFAULT '[]'");
    if (!names.has("answer_draft")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN answer_draft TEXT NOT NULL DEFAULT ''");
    if (!names.has("answer_draft_transient")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN answer_draft_transient INTEGER NOT NULL DEFAULT 0");
    this.context.database.exec("UPDATE run_cards SET answer_segments_json = json_array(answer) WHERE answer <> '' AND answer_segments_json = '[]' AND answer_draft = ''");
  }

  ensureRunCardProgressSummary(): void {
    const names = new Set((this.context.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!names.has("progress_summary_json")) this.context.database.exec(`ALTER TABLE run_cards ADD COLUMN progress_summary_json TEXT NOT NULL DEFAULT '{"total":0,"stepTotal":0,"stepDone":0}'`);
    const migrated = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 6").get();
    if (migrated) return;
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.context.database.prepare("SELECT prompt_id, progress_events_json FROM run_cards").all() as Array<{ prompt_id: string; progress_events_json: string }>;
      const update = this.context.database.prepare("UPDATE run_cards SET progress_events_json = ?, progress_summary_json = ? WHERE prompt_id = ?");
      for (const row of rows) {
        const events = JSON.parse(row.progress_events_json) as Array<{ kind?: unknown; state?: unknown }>;
        let stepTotal = 0; let stepDone = 0;
        for (const event of events) if (event.kind === "step") { stepTotal += 1; if (event.state === "done") stepDone += 1; }
        update.run(JSON.stringify(events.slice(-8)), JSON.stringify({ total: events.length, stepTotal, stepDone }), row.prompt_id);
      }
      this.context.database.prepare("INSERT INTO schema_migrations(version) VALUES (6)").run();
      this.context.database.exec("COMMIT");
    } catch (error) { this.context.database.exec("ROLLBACK"); throw error; }
  }

  ensureRunCardInteractionColumns(): void {
    const columns = this.context.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("binding_generation")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN binding_generation INTEGER NOT NULL DEFAULT 1");
    if (!names.has("conversion_parent_prompt_id")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN conversion_parent_prompt_id TEXT");
  }

  ensureRunCardRequestText(): void {
    const columns = this.context.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "request_text")) {
      this.context.database.exec("ALTER TABLE run_cards ADD COLUMN request_text TEXT NOT NULL DEFAULT ''");
    }
    this.context.database.exec("UPDATE run_cards SET request_text = COALESCE((SELECT body FROM prompt_jobs WHERE prompt_jobs.id = run_cards.prompt_id), '') WHERE request_text = ''");
  }

  ensureRunCardSpaceName(): void {
    const columns = this.context.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "space_name")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN space_name TEXT NOT NULL DEFAULT 'unknown'");
  }

  ensureRunCardSessionTitle(): void {
    const columns = this.context.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "session_title")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN session_title TEXT");
  }

  recreateRunCardsView(): void {
    this.context.database.exec(`
      DROP VIEW IF EXISTS run_cards_view;
      CREATE VIEW run_cards_view AS SELECT *, json_object(
        'promptId', prompt_id, 'bindingId', binding_id, 'bindingGeneration', binding_generation, 'conversionParentPromptId', conversion_parent_prompt_id, 'queueFeedback', CASE WHEN queue_feedback_json IS NULL THEN NULL ELSE json(queue_feedback_json) END, 'larkMessageId', lark_message_id, 'answerMessageId', answer_message_id, 'answerCardId', answer_card_id, 'answerElementId', answer_element_id, 'answerSequence', answer_sequence, 'answerPageIndex', answer_page_index, 'answerPageStart', answer_page_start, 'phase', phase, 'title', title, 'sessionTitle', session_title, 'requestText', request_text,
        'workspaceId', workspace_id, 'spaceName', space_name, 'paneId', pane_id, 'answer', answer, 'answerSegments', json(answer_segments_json), 'answerDraft', answer_draft, 'answerDraftTransient', CASE WHEN answer_draft_transient = 1 THEN json('true') ELSE json('false') END, 'progressEvents', json(progress_events_json), 'progressSummary', json(progress_summary_json),
        'queuePosition', queue_position, 'startedAt', started_at, 'finishedAt', finished_at, 'notice', notice, 'workerActivity', json(worker_activity_json), 'workerDependencyRevision', worker_dependency_revision, 'workerContextFrozenAt', worker_context_frozen_at, 'activityAt', activity_at,
        'viewVersion', view_version, 'deliveredVersion', delivered_version, 'answerDeliveredVersion', answer_delivered_version, 'createdAt', created_at, 'updatedAt', updated_at
      ) AS state_json FROM run_cards;
    `);
  }

  runCardViewNeedsRebuild(): boolean {
    const view = this.context.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = 'run_cards_view'").get();
    if (!view) return true;
    const columns = new Set((this.context.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>).map((column) => column.name));
    return [
      "binding_generation", "conversion_parent_prompt_id", "queue_feedback_json",
      "answer_message_id", "answer_card_id", "answer_element_id", "answer_sequence", "answer_page_index", "answer_page_start",
      "request_text", "space_name", "session_title", "answer_segments_json", "answer_draft", "answer_draft_transient", "progress_summary_json", "worker_activity_json", "worker_dependency_revision", "worker_context_frozen_at", "activity_at", "answer_delivered_version"
    ].some((column) => !columns.has(column));
  }

  ensureOutboundReplyColumns(): void {
    const columns = this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (names.has("binding_id") && names.has("next_attempt_at")) return;
    this.context.database.exec(`
      BEGIN;
      ALTER TABLE outbound_replies RENAME TO outbound_replies_legacy;
      CREATE TABLE outbound_replies(
        id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, binding_id TEXT REFERENCES bindings(id), root_message_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('text','card_reply','card_update','stream_card_create','stream_content','stream_finish')), payload TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','delivered','dead_letter')), attempt_count INTEGER NOT NULL DEFAULT 0,
        error TEXT, delivered_message_id TEXT, next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO outbound_replies(id, idempotency_key, binding_id, root_message_id, kind, payload, state, attempt_count, error, delivered_message_id, next_attempt_at, created_at, updated_at)
      SELECT id, idempotency_key, NULL, root_message_id, CASE kind WHEN 'card' THEN 'card_reply' ELSE kind END, payload, state, attempt_count, error, delivered_message_id, updated_at, created_at, updated_at
      FROM outbound_replies_legacy;
      DROP TABLE outbound_replies_legacy;
      CREATE INDEX IF NOT EXISTS outbound_replies_pending ON outbound_replies(state, next_attempt_at, created_at);
      COMMIT;
    `);
  }

  ensureTypedDeliveryIntents(): void {
    const names = new Set((this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!names.has("intent_kind")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN intent_kind TEXT");
    if (!names.has("intent_json")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN intent_json TEXT");
    if (!names.has("renderer_revision")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN renderer_revision INTEGER");
    this.context.database.exec(`
      CREATE TRIGGER IF NOT EXISTS outbound_replies_typed_intent_insert AFTER INSERT ON outbound_replies WHEN NEW.intent_json IS NULL BEGIN
        UPDATE outbound_replies SET intent_kind = CASE NEW.kind WHEN 'text' THEN 'text' WHEN 'group_card_create' THEN 'group-card' WHEN 'stream_card_create' THEN 'stream-card' WHEN 'stream_content' THEN 'stream-content' WHEN 'stream_finish' THEN 'stream-finish' ELSE 'card' END, intent_json = json_object('schemaVersion', 1, 'kind', CASE NEW.kind WHEN 'text' THEN 'text' WHEN 'group_card_create' THEN 'group-card' WHEN 'stream_card_create' THEN 'stream-card' WHEN 'stream_content' THEN 'stream-content' WHEN 'stream_finish' THEN 'stream-finish' ELSE 'card' END, 'materializedPayload', NEW.payload), renderer_revision = 1 WHERE id = NEW.id;
      END;
      CREATE TRIGGER IF NOT EXISTS outbound_replies_typed_intent_payload_update AFTER UPDATE OF payload ON outbound_replies BEGIN
        UPDATE outbound_replies SET intent_kind = CASE NEW.kind WHEN 'text' THEN 'text' WHEN 'group_card_create' THEN 'group-card' WHEN 'stream_card_create' THEN 'stream-card' WHEN 'stream_content' THEN 'stream-content' WHEN 'stream_finish' THEN 'stream-finish' ELSE 'card' END, intent_json = json_object('schemaVersion', 1, 'kind', CASE NEW.kind WHEN 'text' THEN 'text' WHEN 'group_card_create' THEN 'group-card' WHEN 'stream_card_create' THEN 'stream-card' WHEN 'stream_content' THEN 'stream-content' WHEN 'stream_finish' THEN 'stream-finish' ELSE 'card' END, 'materializedPayload', NEW.payload), renderer_revision = 1 WHERE id = NEW.id;
      END;
    `);
    this.context.database.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (29)").run();
  }
}

function now(): string { return new Date().toISOString(); }

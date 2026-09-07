import { answerElementId } from "../../../domain/run-card-view.js";
import { outboundLaneKeySql } from "../../outbox-lanes.js";
import { canonicalizeAnswerPayload } from "../answer-payload.js";
import type { SqliteContext } from "../context.js";

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
    this.context.database.exec(`
      PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;
      CREATE TABLE outbound_replies_next(
        id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, binding_id TEXT REFERENCES bindings(id), prompt_id TEXT, worker_turn_id TEXT REFERENCES instance_turns(id) ON DELETE CASCADE, view_version INTEGER, card_sequence INTEGER, selection_id TEXT, card_role TEXT CHECK(card_role IN ('task','answer')), target_role TEXT CHECK(target_role IN ('session_status','operation_result')), root_message_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('text','card_reply','card_update','stream_card_create','stream_content','stream_finish')), payload TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','delivered','dead_letter','dismissed')), attempt_count INTEGER NOT NULL DEFAULT 0, error TEXT, delivered_message_id TEXT, card_id_checkpoint TEXT, delivery_order INTEGER, lane_key TEXT, next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO outbound_replies_next(id, idempotency_key, binding_id, prompt_id, worker_turn_id, view_version, card_sequence, selection_id, card_role, target_role, root_message_id, kind, payload, state, attempt_count, error, delivered_message_id, card_id_checkpoint, delivery_order, lane_key, next_attempt_at, created_at, updated_at)
      SELECT id, idempotency_key, binding_id, prompt_id, ${workerTurnId}, view_version, card_sequence, selection_id, card_role, target_role, root_message_id, kind, payload, state, attempt_count, error, delivered_message_id, card_id_checkpoint, delivery_order, ${outboundLaneKeySql(workerTurnId, "NULL", "NULL")}, next_attempt_at, created_at, updated_at FROM outbound_replies;
      DROP TABLE outbound_replies; ALTER TABLE outbound_replies_next RENAME TO outbound_replies;
      CREATE INDEX outbound_replies_pending ON outbound_replies(state, next_attempt_at, created_at); COMMIT; PRAGMA foreign_keys = ON;
    `);
    const violation = this.context.database.prepare("PRAGMA foreign_key_check").get();
    if (violation) throw new Error(`Outbound-state migration produced a foreign-key violation: ${JSON.stringify(violation)}`);
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
        UPDATE outbound_replies SET intent_kind = CASE NEW.kind WHEN 'text' THEN 'text' WHEN 'stream_card_create' THEN 'stream-card' WHEN 'stream_content' THEN 'stream-content' WHEN 'stream_finish' THEN 'stream-finish' ELSE 'card' END, intent_json = json_object('schemaVersion', 1, 'kind', CASE NEW.kind WHEN 'text' THEN 'text' WHEN 'stream_card_create' THEN 'stream-card' WHEN 'stream_content' THEN 'stream-content' WHEN 'stream_finish' THEN 'stream-finish' ELSE 'card' END, 'materializedPayload', NEW.payload), renderer_revision = 1 WHERE id = NEW.id;
      END;
      CREATE TRIGGER IF NOT EXISTS outbound_replies_typed_intent_payload_update AFTER UPDATE OF payload ON outbound_replies BEGIN
        UPDATE outbound_replies SET intent_kind = CASE NEW.kind WHEN 'text' THEN 'text' WHEN 'stream_card_create' THEN 'stream-card' WHEN 'stream_content' THEN 'stream-content' WHEN 'stream_finish' THEN 'stream-finish' ELSE 'card' END, intent_json = json_object('schemaVersion', 1, 'kind', CASE NEW.kind WHEN 'text' THEN 'text' WHEN 'stream_card_create' THEN 'stream-card' WHEN 'stream_content' THEN 'stream-content' WHEN 'stream_finish' THEN 'stream-finish' ELSE 'card' END, 'materializedPayload', NEW.payload), renderer_revision = 1 WHERE id = NEW.id;
      END;
    `);
    this.context.database.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (29)").run();
  }
}

function now(): string { return new Date().toISOString(); }

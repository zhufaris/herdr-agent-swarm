import type { SqliteContext } from "../context.js";

export class ConversationSegmentMigrations {
  constructor(private readonly context: SqliteContext) {}

  ensureConversationSegments(): void {
    createConversationSegmentSchema(this.context);
    this.context.database.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (95)").run();
    this.ensureWorkerCanonicalIntentColumns();
    this.ensureAcknowledgedPageState();
    this.ensureTaskListProjection();
    this.ensureCurrentGoalProjection();
    this.ensureModelProjection();
    this.ensureHistoricalPageRecovery();
    this.ensureHistoricalPageRecoveryParts();
    this.ensureActionableConversationSegmentPageIndex();
  }

  ensureActionableConversationSegmentPageIndex(): void {
    const table = this.context.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_segments'").get();
    if (!table) return;
    this.context.database.exec(`CREATE INDEX IF NOT EXISTS conversation_segments_actionable_page_keyset
      ON conversation_segments(updated_at,id) WHERE root_message_id <> ''`);
  }

  private ensureWorkerCanonicalIntentColumns(): void {
    const columns = new Set((this.context.database.prepare("PRAGMA table_info(instance_turns)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!columns.has("canonical_segment_id")) this.context.database.exec("ALTER TABLE instance_turns ADD COLUMN canonical_segment_id TEXT");
    if (!columns.has("canonical_submission_id")) this.context.database.exec("ALTER TABLE instance_turns ADD COLUMN canonical_submission_id TEXT");
    if (!columns.has("canonical_agent_kind")) this.context.database.exec("ALTER TABLE instance_turns ADD COLUMN canonical_agent_kind TEXT CHECK(canonical_agent_kind IN ('traex','pi'))");
    if (!columns.has("canonical_expected_session_id")) this.context.database.exec("ALTER TABLE instance_turns ADD COLUMN canonical_expected_session_id TEXT");
    if (!columns.has("canonical_root_message_id")) this.context.database.exec("ALTER TABLE instance_turns ADD COLUMN canonical_root_message_id TEXT");
    if (!columns.has("canonical_gateway_id")) this.context.database.exec("ALTER TABLE instance_turns ADD COLUMN canonical_gateway_id TEXT");
    this.context.database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS instance_turns_canonical_submission
      ON instance_turns(canonical_submission_id) WHERE canonical_submission_id IS NOT NULL`);
    this.context.database.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (97)").run();
  }

  private ensureAcknowledgedPageState(): void {
    const columns = new Set((this.context.database.prepare("PRAGMA table_info(conversation_segment_pages)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!columns.has("delivered_sequence")) this.context.database.exec("ALTER TABLE conversation_segment_pages ADD COLUMN delivered_sequence INTEGER NOT NULL DEFAULT 0 CHECK(delivered_sequence >= 0)");
    if (!columns.has("pending_cursor_json")) this.context.database.exec("ALTER TABLE conversation_segment_pages ADD COLUMN pending_cursor_json TEXT CHECK(pending_cursor_json IS NULL OR json_valid(pending_cursor_json))");
    this.context.database.prepare(`UPDATE conversation_segment_pages SET delivered_sequence=sequence
      WHERE pending_reply_id IS NULL AND message_id IS NOT NULL AND delivered_sequence < sequence`).run();
    this.context.database.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (98)").run();
  }

  private ensureTaskListProjection(): void {
    const columns = new Set((this.context.database.prepare("PRAGMA table_info(conversation_segments)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!columns.has("task_list_json")) this.context.database.exec("ALTER TABLE conversation_segments ADD COLUMN task_list_json TEXT CHECK(task_list_json IS NULL OR json_valid(task_list_json))");
    this.context.database.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (99)").run();
  }

  private ensureCurrentGoalProjection(): void {
    const columns = new Set((this.context.database.prepare("PRAGMA table_info(conversation_segments)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!columns.has("current_goal_json")) this.context.database.exec("ALTER TABLE conversation_segments ADD COLUMN current_goal_json TEXT CHECK(current_goal_json IS NULL OR json_valid(current_goal_json))");
    this.context.database.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (108)").run();
  }

  private ensureModelProjection(): void {
    const columns = new Set((this.context.database.prepare("PRAGMA table_info(conversation_segments)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!columns.has("model")) this.context.database.exec("ALTER TABLE conversation_segments ADD COLUMN model TEXT");
    this.context.database.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (110)").run();
  }

  private ensureHistoricalPageRecovery(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS conversation_segment_page_recoveries(
        segment_id TEXT NOT NULL REFERENCES conversation_segments(id) ON DELETE CASCADE,
        source_page_index INTEGER NOT NULL CHECK(source_page_index > 0),
        start_cursor_json TEXT NOT NULL CHECK(json_valid(start_cursor_json)),
        end_cursor_json TEXT NOT NULL CHECK(json_valid(end_cursor_json)),
        reply_id TEXT NOT NULL UNIQUE REFERENCES outbound_replies(id) ON DELETE RESTRICT,
        message_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('pending','delivered')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(segment_id, source_page_index)
      );
      CREATE INDEX IF NOT EXISTS conversation_segment_page_recoveries_state
        ON conversation_segment_page_recoveries(state, updated_at, segment_id, source_page_index);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (100);
    `);
  }

  private ensureHistoricalPageRecoveryParts(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS conversation_segment_page_recovery_parts(
        segment_id TEXT NOT NULL REFERENCES conversation_segments(id) ON DELETE CASCADE,
        source_page_index INTEGER NOT NULL CHECK(source_page_index > 0),
        part_index INTEGER NOT NULL CHECK(part_index >= 0),
        start_cursor_json TEXT NOT NULL CHECK(json_valid(start_cursor_json)),
        end_cursor_json TEXT NOT NULL CHECK(json_valid(end_cursor_json)),
        reply_id TEXT NOT NULL UNIQUE REFERENCES outbound_replies(id) ON DELETE RESTRICT,
        message_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('pending','delivered')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        end_lane_sequence INTEGER,end_item_ordinal INTEGER,
        end_anchor_inclusive INTEGER NOT NULL DEFAULT 1 CHECK(end_anchor_inclusive IN (0,1)),
        PRIMARY KEY(segment_id, source_page_index, part_index)
      );
      CREATE INDEX IF NOT EXISTS conversation_segment_page_recovery_parts_state
        ON conversation_segment_page_recovery_parts(state, updated_at, segment_id, source_page_index, part_index);
      INSERT OR IGNORE INTO conversation_segment_page_recovery_parts(
        segment_id,source_page_index,part_index,start_cursor_json,end_cursor_json,reply_id,message_id,state,created_at,updated_at
      ) SELECT segment_id,source_page_index,0,start_cursor_json,end_cursor_json,reply_id,message_id,state,created_at,updated_at
        FROM conversation_segment_page_recoveries;
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (101);
    `);
  }
}

export function createConversationSegmentSchema(context: SqliteContext): void {
  context.database.exec(`
    CREATE TABLE IF NOT EXISTS conversation_segments(
      id TEXT PRIMARY KEY, producer_key TEXT NOT NULL,
      owner_kind TEXT NOT NULL CHECK(owner_kind IN ('primary','worker')),
      owner_id TEXT NOT NULL, owner_generation INTEGER NOT NULL CHECK(owner_generation >= 1),
      submission_id TEXT UNIQUE, human_event_id TEXT UNIQUE,
      agent_kind TEXT NOT NULL CHECK(agent_kind IN ('traex','pi')), session_id TEXT,
      request_text TEXT NOT NULL,
      start_lane_sequence INTEGER, start_item_ordinal INTEGER,
      end_lane_sequence INTEGER, end_item_ordinal INTEGER,
      state TEXT NOT NULL CHECK(state IN ('pending','working','completed','failed','cancelled','needs_human','closed')),
      view_version INTEGER NOT NULL CHECK(view_version >= 1),
      root_message_id TEXT NOT NULL, task_list_json TEXT CHECK(task_list_json IS NULL OR json_valid(task_list_json)),
      current_goal_json TEXT CHECK(current_goal_json IS NULL OR json_valid(current_goal_json)),
      model TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      timeline_item_count INTEGER NOT NULL DEFAULT 0 CHECK(timeline_item_count >= 0),
      has_visible_assistant_content INTEGER NOT NULL DEFAULT 0 CHECK(has_visible_assistant_content IN (0,1)),
      CHECK((start_lane_sequence IS NULL) = (start_item_ordinal IS NULL)),
      CHECK((end_lane_sequence IS NULL) = (end_item_ordinal IS NULL)),
      CHECK(start_lane_sequence IS NULL OR (start_lane_sequence >= 0 AND start_item_ordinal >= 0)),
      CHECK(end_lane_sequence IS NULL OR (end_lane_sequence >= 0 AND end_item_ordinal >= 0)),
      CHECK(
        start_lane_sequence IS NULL OR end_lane_sequence IS NULL
        OR end_lane_sequence > start_lane_sequence
        OR (end_lane_sequence = start_lane_sequence AND end_item_ordinal > start_item_ordinal)
      )
    );
    CREATE INDEX IF NOT EXISTS conversation_segments_producer
      ON conversation_segments(producer_key, owner_kind, owner_id, owner_generation, created_at, id);
    CREATE INDEX IF NOT EXISTS conversation_segments_actionable_page_keyset
      ON conversation_segments(updated_at,id) WHERE root_message_id <> '';
    CREATE TABLE IF NOT EXISTS conversation_segment_items(
      segment_id TEXT NOT NULL REFERENCES conversation_segments(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL, lane_sequence INTEGER NOT NULL CHECK(lane_sequence >= 0),
      item_ordinal INTEGER NOT NULL CHECK(item_ordinal >= 0),
      item_json TEXT NOT NULL CHECK(json_valid(item_json)), payload_compacted_at TEXT,
      PRIMARY KEY(segment_id, item_id),
      UNIQUE(segment_id, lane_sequence, item_ordinal)
    );
    CREATE INDEX IF NOT EXISTS conversation_segment_items_position
      ON conversation_segment_items(segment_id, lane_sequence, item_ordinal, item_id);
    CREATE INDEX IF NOT EXISTS conversation_segment_items_item_segment
      ON conversation_segment_items(item_id, segment_id);
    CREATE TABLE IF NOT EXISTS conversation_segment_pages(
      id TEXT PRIMARY KEY, segment_id TEXT NOT NULL REFERENCES conversation_segments(id) ON DELETE CASCADE,
      page_index INTEGER NOT NULL CHECK(page_index >= 0),
      message_id TEXT, card_id TEXT, element_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('creating','active','frozen','finished')),
      sequence INTEGER NOT NULL CHECK(sequence >= 0), delivered_sequence INTEGER NOT NULL DEFAULT 0 CHECK(delivered_sequence >= 0),
      start_cursor_json TEXT CHECK(start_cursor_json IS NULL OR json_valid(start_cursor_json)),
      delivered_cursor_json TEXT CHECK(delivered_cursor_json IS NULL OR json_valid(delivered_cursor_json)),
      pending_cursor_json TEXT CHECK(pending_cursor_json IS NULL OR json_valid(pending_cursor_json)),
      pending_reply_id TEXT REFERENCES outbound_replies(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      start_lane_sequence INTEGER, start_item_ordinal INTEGER,
      cursor_base INTEGER NOT NULL DEFAULT 0 CHECK(cursor_base >= 0),
      start_anchor_inclusive INTEGER NOT NULL DEFAULT 1 CHECK(start_anchor_inclusive IN (0,1)),
      continuation_lane_sequence INTEGER, continuation_item_ordinal INTEGER,
      continuation_anchor_inclusive INTEGER NOT NULL DEFAULT 1 CHECK(continuation_anchor_inclusive IN (0,1)),
      continuation_cursor_base INTEGER,
      UNIQUE(segment_id, page_index)
    );
    CREATE INDEX IF NOT EXISTS conversation_segment_pages_segment
      ON conversation_segment_pages(segment_id, state, page_index);
    CREATE UNIQUE INDEX IF NOT EXISTS conversation_segment_pages_one_current
      ON conversation_segment_pages(segment_id) WHERE state IN ('creating','active');
    CREATE INDEX IF NOT EXISTS conversation_segment_pages_current_lookup
      ON conversation_segment_pages(segment_id,page_index) WHERE state IN ('creating','active');
    CREATE UNIQUE INDEX IF NOT EXISTS conversation_segment_pages_pending_reply
      ON conversation_segment_pages(pending_reply_id) WHERE pending_reply_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS conversation_segment_page_recoveries(
      segment_id TEXT NOT NULL REFERENCES conversation_segments(id) ON DELETE CASCADE,
      source_page_index INTEGER NOT NULL CHECK(source_page_index > 0),
      start_cursor_json TEXT NOT NULL CHECK(json_valid(start_cursor_json)),
      end_cursor_json TEXT NOT NULL CHECK(json_valid(end_cursor_json)),
      reply_id TEXT NOT NULL UNIQUE REFERENCES outbound_replies(id) ON DELETE RESTRICT,
      message_id TEXT,
      state TEXT NOT NULL CHECK(state IN ('pending','delivered')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(segment_id, source_page_index)
    );
    CREATE INDEX IF NOT EXISTS conversation_segment_page_recoveries_state
      ON conversation_segment_page_recoveries(state, updated_at, segment_id, source_page_index);
    CREATE TABLE IF NOT EXISTS conversation_segment_page_recovery_parts(
      segment_id TEXT NOT NULL REFERENCES conversation_segments(id) ON DELETE CASCADE,
      source_page_index INTEGER NOT NULL CHECK(source_page_index > 0),
      part_index INTEGER NOT NULL CHECK(part_index >= 0),
      start_cursor_json TEXT NOT NULL CHECK(json_valid(start_cursor_json)),
      end_cursor_json TEXT NOT NULL CHECK(json_valid(end_cursor_json)),
      reply_id TEXT NOT NULL UNIQUE REFERENCES outbound_replies(id) ON DELETE RESTRICT,
      message_id TEXT,
      state TEXT NOT NULL CHECK(state IN ('pending','delivered')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      end_lane_sequence INTEGER,end_item_ordinal INTEGER,
      end_anchor_inclusive INTEGER NOT NULL DEFAULT 1 CHECK(end_anchor_inclusive IN (0,1)),
      PRIMARY KEY(segment_id, source_page_index, part_index)
    );
    CREATE INDEX IF NOT EXISTS conversation_segment_page_recovery_parts_state
      ON conversation_segment_page_recovery_parts(state, updated_at, segment_id, source_page_index, part_index);
    CREATE TABLE IF NOT EXISTS conversation_segment_late_recoveries(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      segment_id TEXT NOT NULL REFERENCES conversation_segments(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL,
      lane_sequence INTEGER NOT NULL CHECK(lane_sequence >= 0),
      item_ordinal INTEGER NOT NULL CHECK(item_ordinal >= 0),
      source_event_id TEXT NOT NULL,
      part_index INTEGER NOT NULL DEFAULT 0 CHECK(part_index >= 0),
      start_cursor_json TEXT CHECK(start_cursor_json IS NULL OR json_valid(start_cursor_json)),
      pending_cursor_json TEXT CHECK(pending_cursor_json IS NULL OR json_valid(pending_cursor_json)),
      reply_id TEXT UNIQUE REFERENCES outbound_replies(id) ON DELETE RESTRICT,
      message_id TEXT,
      state TEXT NOT NULL CHECK(state IN ('queued','pending','delivered','failed')),
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS conversation_segment_late_recoveries_open_item
      ON conversation_segment_late_recoveries(segment_id,item_id) WHERE state IN ('queued','pending');
    CREATE INDEX IF NOT EXISTS conversation_segment_late_recoveries_state
      ON conversation_segment_late_recoveries(state,segment_id,id);
  `);
}

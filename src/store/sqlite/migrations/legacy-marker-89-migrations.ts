import type { DatabaseSync } from "node:sqlite";
import type { SqliteContext } from "../context.js";

export type LegacyMarker89ObligationId = "input-card-view" | "conversation-turn-projection";

export interface LegacyMarker89Obligation {
  readonly id: LegacyMarker89ObligationId;
  readonly marker: 89;
  isSatisfied(database: DatabaseSync): boolean;
  repair(context: SqliteContext): void;
}

export const legacyMarker89Obligations: readonly LegacyMarker89Obligation[] = Object.freeze([
  Object.freeze({
    id: "input-card-view" as const,
    marker: 89 as const,
    isSatisfied: (database: DatabaseSync) => hasObjects(database, [["table", "input_card_views"], ["index", "input_card_views_state"]]),
    repair(context: SqliteContext) {
      context.database.exec(`
        CREATE TABLE IF NOT EXISTS input_card_views(
          submission_id TEXT PRIMARY KEY REFERENCES submission_intents(submission_id) ON DELETE CASCADE,
          state TEXT NOT NULL CHECK(state IN ('pending','working')), root_message_id TEXT NOT NULL,
          message_id TEXT, card_id TEXT, card_json TEXT NOT NULL CHECK(json_valid(card_json)),
          working_card_json TEXT NOT NULL CHECK(json_valid(working_card_json)), observed_event_id TEXT UNIQUE,
          revision INTEGER NOT NULL CHECK(revision >= 1), delivered_revision INTEGER NOT NULL DEFAULT 0 CHECK(delivered_revision >= 0),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS input_card_views_state ON input_card_views(state, updated_at);
      `);
    }
  }),
  Object.freeze({
    id: "conversation-turn-projection" as const,
    marker: 89 as const,
    isSatisfied: (database: DatabaseSync) => hasObjects(database, [
      ["table", "conversation_turn_projections"], ["table", "conversation_turn_projection_events"], ["index", "conversation_turn_projection_events_order"]
    ]),
    repair(context: SqliteContext) {
      context.database.exec(`
        CREATE TABLE IF NOT EXISTS conversation_turn_projections(
          agent_kind TEXT NOT NULL CHECK(agent_kind IN ('traex','pi')), session_id TEXT NOT NULL,
          turn_id TEXT NOT NULL, started_at TEXT NOT NULL, source_lane_id TEXT NOT NULL,
          projection_id TEXT UNIQUE, origin TEXT CHECK(origin IN ('herdr','feishu')),
          binding_id TEXT REFERENCES bindings(id) ON DELETE CASCADE,
          binding_generation INTEGER CHECK(binding_generation >= 1), pane_id TEXT,
          state_json TEXT CHECK(state_json IS NULL OR json_valid(state_json)), answer_card_json TEXT CHECK(answer_card_json IS NULL OR json_valid(answer_card_json)),
          answer_message_id TEXT, answer_card_id TEXT, delivered_revision INTEGER NOT NULL DEFAULT 0 CHECK(delivered_revision >= 0),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY(agent_kind, session_id, turn_id, started_at)
        );
        CREATE TABLE IF NOT EXISTS conversation_turn_projection_events(
          agent_kind TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT NOT NULL, started_at TEXT NOT NULL,
          event_id TEXT NOT NULL UNIQUE REFERENCES core_event_inbox(event_id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL CHECK(sequence > 0), created_at TEXT NOT NULL,
          PRIMARY KEY(agent_kind, session_id, turn_id, started_at, event_id),
          UNIQUE(agent_kind, session_id, turn_id, started_at, sequence),
          FOREIGN KEY(agent_kind, session_id, turn_id, started_at)
            REFERENCES conversation_turn_projections(agent_kind, session_id, turn_id, started_at) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS conversation_turn_projection_events_order
          ON conversation_turn_projection_events(agent_kind, session_id, turn_id, started_at, sequence);
      `);
    }
  })
]);

/** Physical marker 89 is historical evidence, never proof of either obligation. */
export function repairLegacyMarker89Obligations(context: SqliteContext): void {
  for (const obligation of legacyMarker89Obligations) {
    if (!obligation.isSatisfied(context.database)) obligation.repair(context);
  }
  const incomplete = legacyMarker89Obligations.filter((obligation) => !obligation.isSatisfied(context.database));
  if (incomplete.length) {
    throw new Error(`Legacy marker 89 obligations remain incomplete: ${incomplete.map((obligation) => obligation.id).join(",")}`);
  }
  context.database.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (89)").run();
}

function hasObjects(database: DatabaseSync, objects: readonly (readonly [type: string, name: string])[]): boolean {
  return objects.every(([type, name]) => database.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get(type, name) !== undefined);
}

import type { SqliteContext } from "../context.js";
import { runForeignKeySafeRebuild } from "./foreign-key-safe-rebuild.js";

/** Expands historical inline buttons into the Completion Review schema without changing legacy behavior. */
export function rebuildCompletionActionSetsForCompletionReview(context: SqliteContext): void {
  const definition = (context.database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='completion_action_sets'").get() as { sql: string } | undefined)?.sql ?? "";
  if (!definition || (definition.includes("presentation_kind") && definition.includes("presentation_generation"))) return;
  runForeignKeySafeRebuild(context, "completion review action-set lifecycle", () => {
    context.database.exec(`
      DROP INDEX IF EXISTS completion_action_sets_available;
      DROP INDEX IF EXISTS completion_action_sets_owner_state;
      DROP INDEX IF EXISTS completion_action_sets_presentation_reply;
      ALTER TABLE completion_action_sets RENAME TO completion_action_sets_legacy;
      CREATE TABLE completion_action_sets(
        id TEXT PRIMARY KEY,
        owner_kind TEXT NOT NULL CHECK(owner_kind IN ('primary-prompt','worker-turn','primary-segment')),
        owner_id TEXT NOT NULL, owner_generation INTEGER NOT NULL CHECK(owner_generation>=1),
        binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE,
        binding_generation INTEGER NOT NULL CHECK(binding_generation>=1),
        page_index INTEGER NOT NULL CHECK(page_index>=0), card_id TEXT, card_message_id TEXT,
        mention_open_id TEXT,
        presentation_kind TEXT NOT NULL CHECK(presentation_kind IN ('legacy-inline','fresh-card')),
        presentation_generation INTEGER NOT NULL CHECK(presentation_generation>=1),
        presentation_reply_id TEXT REFERENCES outbound_replies(id) ON DELETE SET NULL,
        presentation_message_id TEXT, presentation_card_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('available','provisional','presenting','active','consumed','superseded','unavailable')),
        selected_action TEXT CHECK(selected_action IN ('default','approve','continue','reject')),
        result_source_key TEXT, reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, decided_at TEXT,
        choice_specification_id TEXT REFERENCES completion_choice_specifications(id), selected_choice_option_id TEXT,
        UNIQUE(owner_kind,owner_id,owner_generation)
      );
      INSERT INTO completion_action_sets(
        id,owner_kind,owner_id,owner_generation,binding_id,binding_generation,page_index,card_id,card_message_id,
        mention_open_id,presentation_kind,presentation_generation,presentation_reply_id,presentation_message_id,presentation_card_id,
        state,selected_action,result_source_key,reason,created_at,updated_at,decided_at,choice_specification_id,selected_choice_option_id
      ) SELECT
        legacy.id,legacy.owner_kind,legacy.owner_id,legacy.owner_generation,legacy.binding_id,legacy.binding_generation,legacy.page_index,
        legacy.card_id,legacy.card_message_id,legacy.mention_open_id,'legacy-inline',1,
        NULL,
        legacy.card_message_id,legacy.card_id,
        legacy.state,
        legacy.selected_action,legacy.result_source_key,legacy.reason,legacy.created_at,legacy.updated_at,legacy.decided_at,
        legacy.choice_specification_id,legacy.selected_choice_option_id
      FROM completion_action_sets_legacy legacy;
      DROP TABLE completion_action_sets_legacy;
      CREATE INDEX completion_action_sets_owner_state
        ON completion_action_sets(state,owner_kind,binding_id,binding_generation,updated_at,owner_id);
      CREATE UNIQUE INDEX completion_action_sets_presentation_reply
        ON completion_action_sets(presentation_reply_id) WHERE presentation_reply_id IS NOT NULL;
    `);
  });
}

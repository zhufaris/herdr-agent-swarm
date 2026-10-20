import type { DatabaseSync } from "node:sqlite";
import type { SqliteIntegrityInspection, SqliteIntegrityIssue } from "../domain/types.js";
import { invalidPromptIdentityCorrectionPredicateSql, registerPromptIdentitySqlFunctions, resolvedPromptReferenceSql } from "./sqlite/prompt-identity-corrections.js";
import { CURRENT_TABLE_MANIFEST, type CurrentTableName } from "./sqlite/schema-manifest.js";

export function inspectSqliteIntegrity(database: DatabaseSync, limit: number, options: { includePhysical?: boolean } = {}): SqliteIntegrityInspection {
  registerPromptIdentitySqlFunctions(database);
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const findings: SqliteIntegrityIssue[] = [];
  let findingCount = 0;
  const add = (issue: SqliteIntegrityIssue): void => {
    findingCount += 1;
    if (findings.length < boundedLimit) findings.push(issue);
  };
  const count = (sql: string): number => Number((database.prepare(sql).get() as { count: number }).count);

  const includePhysical = options.includePhysical ?? true;
  const quickRows = includePhysical ? database.prepare(`PRAGMA quick_check(${boundedLimit + 1})`).all() as Array<Record<string, unknown>> : [];
  const quickFailures = quickRows.filter((row) => String(Object.values(row)[0]) !== "ok");
  if (quickFailures.length > 0) add({ rule: "sqlite_quick_check", table: "database", count: quickFailures.length });

  if (includePhysical) {
    const foreignKeys = database.prepare(`SELECT "table", rowid FROM pragma_foreign_key_check LIMIT ${boundedLimit + 1}`).all() as Array<{ table: string; rowid: number | null }>;
    for (const row of foreignKeys) add({ rule: "sqlite_foreign_key", table: row.table, count: 1, ...(row.rowid === null ? {} : { rowId: Number(row.rowid) }) });
  }

  const outboundPromptReferenceSql = `SELECT COUNT(*) AS count
    FROM outbound_replies o
    LEFT JOIN prompt_jobs p ON p.id = ${resolvedPromptReferenceSql("o.prompt_id", { bindingIdColumn: "o.binding_id" })}
    WHERE o.prompt_id IS NOT NULL AND p.id IS NULL
      AND (o.state='pending' OR (o.state='dead_letter' AND (
        NOT EXISTS (SELECT 1 FROM delivery_recoveries recovery
          WHERE recovery.failed_reply_id=o.id AND recovery.state IN ('recovered','dismissed'))
        OR EXISTS (SELECT 1 FROM outbox_lane_quarantines active_quarantine
          WHERE active_quarantine.failed_reply_id=o.id AND active_quarantine.state='active')
      )))
      AND NOT EXISTS (
        SELECT 1 FROM outbox_lane_quarantines quarantine
        JOIN delivery_debt_classifications classified
          ON classified.debt_kind = 'delivery_recovery' AND classified.debt_id = quarantine.failed_reply_id
          AND classified.scope = 'historical' AND classified.source_updated_at >= quarantine.updated_at
          AND classified.source_updated_at >= o.updated_at
        WHERE quarantine.lane_key = o.lane_key AND quarantine.state = 'active'
      )`;
  const invalidPromptIdentityCorrectionSql = `SELECT COUNT(*) AS count
    FROM prompt_identity_corrections correction
    WHERE ${invalidPromptIdentityCorrectionPredicateSql("correction")}`;
  const rules: Array<{ rule: string; table: CurrentTableName; sql: string }> = [
    { rule: "core_event_lane_without_checkpoint", table: "core_event_lane_items", sql: "SELECT COUNT(*) AS count FROM core_event_lane_items l LEFT JOIN core_event_lane_checkpoints c ON c.lane_id = l.lane_id WHERE c.lane_id IS NULL" },
    { rule: "core_event_lane_identity_mismatch", table: "core_event_lane_items", sql: "SELECT COUNT(*) AS count FROM core_event_lane_items l JOIN core_event_inbox i ON i.event_id = l.event_id JOIN core_event_lane_checkpoints c ON c.lane_id = l.lane_id WHERE i.agent_kind != c.agent_kind OR i.session_id != c.session_id" },
    { rule: "core_event_quarantine_without_failure", table: "core_event_lane_items", sql: "SELECT COUNT(*) AS count FROM core_event_lane_items WHERE state = 'quarantined' AND (failure_fingerprint IS NULL OR length(failure_fingerprint) != 64 OR attempt_count < 3)" },
    { rule: "outbound_prompt_reference", table: "outbound_replies", sql: outboundPromptReferenceSql },
    { rule: "prompt_identity_correction_invalid", table: "prompt_identity_corrections", sql: invalidPromptIdentityCorrectionSql },
    { rule: "outbound_selection_reference", table: "outbound_replies", sql: "SELECT COUNT(*) AS count FROM outbound_replies o LEFT JOIN project_selections s ON s.id = o.selection_id WHERE o.kind = 'card_reply' AND o.selection_id IS NOT NULL AND s.id IS NULL" },
    { rule: "outbound_group_target_invalid", table: "outbound_replies", sql: "SELECT COUNT(*) AS count FROM outbound_replies WHERE (kind = 'group_card_create' AND (root_message_id IS NOT NULL OR target_chat_id IS NULL OR ((thread_alias_id IS NOT NULL) + (worker_thread_id IS NOT NULL) + (shortcut_panel_id IS NOT NULL)) != 1)) OR (kind != 'group_card_create' AND (root_message_id IS NULL OR target_chat_id IS NOT NULL OR thread_alias_id IS NOT NULL OR worker_thread_id IS NOT NULL OR shortcut_panel_id IS NOT NULL))" },
    { rule: "thread_alias_binding_mismatch", table: "binding_thread_aliases", sql: "SELECT COUNT(*) AS count FROM binding_thread_aliases a LEFT JOIN bindings b ON b.id = a.binding_id WHERE b.id IS NULL OR (a.state = 'active' AND (b.chat_id != a.chat_id OR b.generation != a.binding_generation OR b.pane_id IS NOT a.pane_id OR b.lifecycle NOT IN ('active','draining')))" },
    { rule: "worker_thread_owner_mismatch", table: "worker_session_threads", sql: "SELECT COUNT(*) AS count FROM worker_session_threads t LEFT JOIN agent_instances w ON w.id = t.worker_id LEFT JOIN bindings b ON b.id = t.parent_binding_id WHERE t.state = 'active' AND (w.id IS NULL OR b.id IS NULL OR w.role != 'worker' OR w.worker_session_lifecycle != 'active' OR w.worker_session_generation != t.worker_session_generation OR w.parent_binding_id IS NOT t.parent_binding_id OR w.parent_binding_generation IS NOT t.parent_binding_generation OR w.parent_pane_id IS NOT t.parent_pane_id OR b.chat_id != t.chat_id OR b.generation != t.parent_binding_generation OR b.pane_id IS NOT t.parent_pane_id OR b.lifecycle NOT IN ('active','draining'))" },
    { rule: "multiple_running_turns", table: "prompt_jobs", sql: "SELECT COUNT(*) AS count FROM (SELECT binding_id FROM prompt_jobs WHERE state = 'running' AND NOT (observation_state = 'detached' AND native_submission_id IS NOT NULL AND transcript_turn_id IS NULL) GROUP BY binding_id HAVING COUNT(*) > 1)" },
    { rule: "open_delivery_gap_without_reply", table: "projection_gaps", sql: "SELECT COUNT(*) AS count FROM projection_gaps g LEFT JOIN outbound_replies o ON o.id = g.source_item_id WHERE g.state = 'open' AND g.stage IN ('answer_delivery','main_delivery','worker_delivery') AND o.id IS NULL" },
    { rule: "projection_gap_compensation_mismatch", table: "projection_gaps", sql: "SELECT COUNT(*) AS count FROM projection_gaps WHERE (state = 'compensated' AND (compensated_by_version IS NULL OR compensated_at IS NULL)) OR (state = 'open' AND (compensated_by_version IS NOT NULL OR compensated_at IS NOT NULL))" },
    { rule: "external_turn_recovery_orphan", table: "external_turn_recovery_attempts", sql: "SELECT COUNT(*) AS count FROM external_turn_recovery_attempts r LEFT JOIN prompt_jobs p ON p.id = r.prompt_id LEFT JOIN bindings b ON b.id = r.binding_id WHERE p.id IS NULL OR b.id IS NULL OR p.binding_id != r.binding_id OR p.state != 'running'" },
    { rule: "external_turn_recovery_identity_mismatch", table: "external_turn_recovery_attempts", sql: "SELECT COUNT(*) AS count FROM external_turn_recovery_attempts r JOIN prompt_jobs p ON p.id = r.prompt_id JOIN bindings b ON b.id = r.binding_id WHERE p.transcript_turn_id IS NOT r.turn_id OR p.transcript_turn_started_at IS NOT r.started_at OR b.generation != r.binding_generation OR b.pane_id IS NOT r.pane_id OR b.agent_session_value IS NOT r.session_value" },
    { rule: "external_turn_recovery_invalid_failure", table: "external_turn_recovery_attempts", sql: "SELECT COUNT(*) AS count FROM external_turn_recovery_attempts WHERE length(failure_fingerprint) != 64 OR attempt_count < 1 OR next_attempt_at < last_attempt_at" }
  ];
  const semanticTables = new Set<CurrentTableName>(CURRENT_TABLE_MANIFEST
    .filter(({ integrity }) => integrity === "semantic")
    .map(({ name }) => name));
  for (const rule of rules) {
    if (!semanticTables.has(rule.table)) throw new Error(`SQLite semantic integrity rule ${rule.rule} targets unclassified table ${rule.table}`);
    const matches = count(rule.sql);
    if (matches > 0) add({ rule: rule.rule, table: rule.table, count: matches });
  }

  return { quickCheck: quickFailures.length === 0 ? "ok" : "failed", issues: findings, truncated: findingCount > boundedLimit };
}

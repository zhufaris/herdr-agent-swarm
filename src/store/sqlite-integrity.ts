import type { DatabaseSync } from "node:sqlite";
import type { SqliteIntegrityInspection, SqliteIntegrityIssue } from "../domain/types.js";

export function inspectSqliteIntegrity(database: DatabaseSync, limit: number): SqliteIntegrityInspection {
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const findings: SqliteIntegrityIssue[] = [];
  let findingCount = 0;
  const add = (issue: SqliteIntegrityIssue): void => {
    findingCount += 1;
    if (findings.length < boundedLimit) findings.push(issue);
  };
  const count = (sql: string): number => Number((database.prepare(sql).get() as { count: number }).count);

  const quickRows = database.prepare(`PRAGMA quick_check(${boundedLimit + 1})`).all() as Array<Record<string, unknown>>;
  const quickFailures = quickRows.filter((row) => String(Object.values(row)[0]) !== "ok");
  if (quickFailures.length > 0) add({ rule: "sqlite_quick_check", table: "database", count: quickFailures.length });

  const foreignKeys = database.prepare(`SELECT "table", rowid FROM pragma_foreign_key_check LIMIT ${boundedLimit + 1}`).all() as Array<{ table: string; rowid: number | null }>;
  for (const row of foreignKeys) add({ rule: "sqlite_foreign_key", table: row.table, count: 1, ...(row.rowid === null ? {} : { rowId: Number(row.rowid) }) });

  const rules: Array<{ rule: string; table: string; sql: string }> = [
    { rule: "outbound_prompt_reference", table: "outbound_replies", sql: "SELECT COUNT(*) AS count FROM outbound_replies o LEFT JOIN prompt_jobs p ON p.id = o.prompt_id WHERE o.prompt_id IS NOT NULL AND p.id IS NULL" },
    { rule: "outbound_selection_reference", table: "outbound_replies", sql: "SELECT COUNT(*) AS count FROM outbound_replies o LEFT JOIN project_selections s ON s.id = o.selection_id WHERE o.selection_id IS NOT NULL AND s.id IS NULL" },
    { rule: "multiple_running_turns", table: "prompt_jobs", sql: "SELECT COUNT(*) AS count FROM (SELECT binding_id FROM prompt_jobs WHERE state = 'running' GROUP BY binding_id HAVING COUNT(*) > 1)" },
    { rule: "outbox_lane_head_mismatch", table: "outbox_lane_heads", sql: `SELECT COUNT(*) AS count FROM outbox_lane_heads h LEFT JOIN outbound_replies o ON o.id = h.reply_id WHERE o.id IS NULL OR o.state != 'pending' OR o.lane_key != h.lane_key OR o.delivery_order != h.delivery_order OR o.next_attempt_at != h.next_attempt_at OR o.created_at != h.created_at OR EXISTS (SELECT 1 FROM outbound_replies earlier WHERE earlier.state = 'pending' AND earlier.lane_key = h.lane_key AND earlier.delivery_order < h.delivery_order)` },
    { rule: "outbox_lane_missing_head", table: "outbox_lane_heads", sql: `SELECT COUNT(*) AS count FROM (SELECT o.lane_key FROM outbound_replies o WHERE o.state = 'pending' AND NOT EXISTS (SELECT 1 FROM outbox_lane_quarantines q WHERE q.lane_key = o.lane_key AND q.state = 'active') GROUP BY o.lane_key) pending LEFT JOIN outbox_lane_heads h ON h.lane_key = pending.lane_key WHERE h.lane_key IS NULL` },
    { rule: "quarantined_lane_has_head", table: "outbox_lane_heads", sql: "SELECT COUNT(*) AS count FROM outbox_lane_quarantines q JOIN outbox_lane_heads h ON h.lane_key = q.lane_key WHERE q.state = 'active'" }
  ];
  for (const rule of rules) {
    const matches = count(rule.sql);
    if (matches > 0) add({ rule: rule.rule, table: rule.table, count: matches });
  }

  return { quickCheck: quickFailures.length === 0 ? "ok" : "failed", issues: findings, truncated: findingCount > boundedLimit };
}

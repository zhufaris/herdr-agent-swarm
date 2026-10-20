import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { orderedMigrations, RELEASED_LEGACY_MARKERS } from "./migration-registry.js";
import { legacyMarker89Obligations, type LegacyMarker89Obligation } from "./migrations/legacy-marker-89-migrations.js";

export const CURRENT_SCHEMA_EPOCH = "2026-10-20.3";

export type TableLeasePolicy =
  | { readonly kind: "fenced" }
  | { readonly kind: "exempt"; readonly reason: string };
export type TableRetentionClass = "bootstrap" | "hot-state" | "durable-evidence" | "audit";
export type TableIntegrityClass = "structural" | "semantic";

export interface CurrentTablePolicy {
  readonly name: string;
  readonly lease: TableLeasePolicy;
  readonly retention: TableRetentionClass;
  readonly integrity: TableIntegrityClass;
}

const fenced = <const Name extends string>(
  name: Name,
  retention: Exclude<TableRetentionClass, "bootstrap"> = "hot-state",
  integrity: TableIntegrityClass = "structural"
): CurrentTablePolicy & { readonly name: Name } => Object.freeze({ name, lease: Object.freeze({ kind: "fenced" }), retention, integrity });

const exempt = <const Name extends string>(name: Name, reason: string): CurrentTablePolicy & { readonly name: Name } => Object.freeze({
  name,
  lease: Object.freeze({ kind: "exempt", reason }),
  retention: "bootstrap",
  integrity: "structural"
});

/**
 * The single policy source for every application-owned durable table in the
 * canonical schema. DDL remains owned by schema/migration modules; validation
 * below proves this policy and the converged sqlite_master catalog agree.
 */
export const CURRENT_TABLE_MANIFEST = Object.freeze([
  exempt("instance_lease", "Lease ownership must remain writable for acquire, renew, release, and takeover"),
  exempt("schema_metadata", "Canonical schema metadata is written only by lease-guarded bootstrap migrations"),
  exempt("schema_migrations", "Migration markers are written only by lease-guarded bootstrap migrations"),

  fenced("bindings"),
  fenced("runtime_identity_claims", "durable-evidence", "semantic"),
  fenced("binding_thread_aliases", "hot-state", "semantic"),
  fenced("agent_instances"),
  fenced("worker_session_threads", "hot-state", "semantic"),
  fenced("worker_thread_entry_requests"),
  fenced("workspace_leases"),
  fenced("instance_removal_plans"),
  fenced("instance_turns", "durable-evidence"),
  fenced("worker_turn_cards"),
  fenced("worker_turn_card_pages"),
  fenced("worker_main_views"),
  fenced("card_context_invalidations"),
  fenced("instance_operations", "durable-evidence"),
  fenced("instance_events", "durable-evidence"),
  fenced("primary_tool_capabilities"),
  fenced("worker_card_display_requests"),
  fenced("approval_requests", "durable-evidence"),
  fenced("approval_grants", "durable-evidence"),
  fenced("conversation_targets"),
  fenced("inbound_messages", "durable-evidence"),
  fenced("bridge_messages", "durable-evidence"),
  fenced("prompt_jobs", "durable-evidence", "semantic"),
  fenced("outbound_replies", "durable-evidence", "semantic"),
  fenced("outbox_lane_quarantines", "durable-evidence"),
  fenced("outbound_reply_prerequisites", "durable-evidence"),
  fenced("delivery_recoveries", "durable-evidence"),
  fenced("delivery_debt_classifications", "durable-evidence"),
  fenced("delivery_ring_checkpoints"),
  fenced("answer_delivery_coverage", "durable-evidence"),
  fenced("answer_recovery_links", "durable-evidence"),
  fenced("answer_recovery_candidates", "durable-evidence"),
  fenced("lark_delivery_cooldowns"),
  fenced("shortcut_panels"),
  fenced("completion_notification_obligations", "durable-evidence"),
  fenced("completion_action_sets", "durable-evidence"),
  fenced("completion_choice_specifications", "durable-evidence"),
  fenced("completion_choice_options", "durable-evidence"),
  fenced("project_selections"),
  fenced("card_interactions", "durable-evidence"),
  fenced("session_operations", "durable-evidence"),
  fenced("orchestrator_clear_operations", "durable-evidence"),
  fenced("orchestrator_clear_answer_targets", "durable-evidence"),
  fenced("orchestrator_clear_result_publications", "durable-evidence"),
  fenced("orchestrator_identity_migrations", "durable-evidence"),
  fenced("swarm_command_intents", "durable-evidence"),
  fenced("submission_intents", "durable-evidence"),
  fenced("agent_input_recovery_scan", "durable-evidence"),
  fenced("input_card_views"),
  fenced("legacy_input_card_retirements", "durable-evidence"),
  fenced("card_dismissals", "durable-evidence"),
  fenced("canonical_human_message_submissions", "durable-evidence"),
  fenced("canonical_input_recovery_attempts", "durable-evidence"),
  fenced("canonical_input_recovery_scan", "durable-evidence"),
  fenced("conversation_segments", "durable-evidence"),
  fenced("conversation_segment_items", "durable-evidence"),
  fenced("conversation_segment_pages", "durable-evidence"),
  fenced("semantic_delivery_rollout", "durable-evidence", "semantic"),
  fenced("semantic_delivery_shadow_evidence", "durable-evidence", "semantic"),
  fenced("semantic_delivery_backup_rehearsals", "durable-evidence", "semantic"),
  fenced("conversation_segment_page_recoveries", "durable-evidence"),
  fenced("conversation_segment_page_recovery_parts", "durable-evidence"),
  fenced("conversation_segment_late_recoveries", "durable-evidence"),
  fenced("command_status_views"),
  fenced("primary_card_redeliveries", "durable-evidence"),
  fenced("natural_language_command_confirmations", "durable-evidence"),
  fenced("controller_interpretation_jobs", "durable-evidence"),
  fenced("controller_runtime"),
  fenced("pane_close_requests", "durable-evidence"),
  fenced("worker_pane_close_steps", "durable-evidence"),
  fenced("pane_topology_intents", "durable-evidence"),
  fenced("pane_control_operations", "durable-evidence"),
  fenced("turn_control_operations", "durable-evidence"),
  fenced("retired_pane_cleanup_operations", "durable-evidence"),
  fenced("binding_model_preferences"),
  fenced("audit_log", "audit"),
  fenced("lifecycle_events", "audit"),
  fenced("primary_human_review_episodes", "durable-evidence"),
  fenced("worker_human_review_episodes", "durable-evidence"),
  fenced("human_review_candidates", "durable-evidence"),
  fenced("topic_views"),
  fenced("run_cards"),
  fenced("answer_pages", "durable-evidence"),
  fenced("answer_segments", "durable-evidence"),
  fenced("answer_timeline_items", "durable-evidence"),
  fenced("answer_timeline_page_checkpoints", "durable-evidence"),
  fenced("prompt_inputs", "durable-evidence"),
  fenced("native_input_batches", "durable-evidence"),
  fenced("native_input_batch_members", "durable-evidence"),
  fenced("prompt_transcript_turns", "durable-evidence"),
  fenced("prompt_identity_corrections", "durable-evidence", "semantic"),
  fenced("core_event_inbox", "durable-evidence"),
  fenced("core_event_owner_projections", "durable-evidence", "semantic"),
  fenced("session_activity_snapshots"),
  fenced("session_activity_agent_identities"),
  fenced("session_activity_items"),
  fenced("audit_skeletons", "audit", "semantic"),
  fenced("audit_skeleton_links", "audit", "semantic"),
  fenced("retention_compaction_cursors", "durable-evidence", "semantic"),
  fenced("core_event_discriminator_backfill", "durable-evidence"),
  fenced("core_event_lane_items", "durable-evidence", "semantic"),
  fenced("core_event_lane_checkpoints", "durable-evidence"),
  fenced("conversation_turn_projections", "durable-evidence"),
  fenced("conversation_turn_projection_events", "durable-evidence"),
  fenced("authoritative_turn_snapshots", "durable-evidence"),
  fenced("authoritative_turn_snapshot_pages", "durable-evidence"),
  fenced("authoritative_turn_snapshot_events", "durable-evidence"),
  fenced("projection_gaps", "durable-evidence", "semantic"),
  fenced("external_turn_recovery_attempts", "durable-evidence", "semantic"),
  fenced("detached_prompt_recovery_attempts", "durable-evidence")
]);

export type CurrentTableName = (typeof CURRENT_TABLE_MANIFEST)[number]["name"];

export const LEASE_FENCED_TABLES = Object.freeze(
  CURRENT_TABLE_MANIFEST.filter((table) => table.lease.kind === "fenced")
);

export interface CanonicalSchemaCatalog {
  readonly tables: readonly string[];
  readonly indexes: readonly string[];
  readonly triggers: readonly string[];
  readonly views: readonly string[];
  readonly markers: readonly number[];
}

export interface SchemaMetadata {
  readonly epoch: string;
  readonly fingerprint: string;
  readonly markers: readonly number[];
}

export interface SchemaMigrationResult {
  readonly route: "fresh-baseline" | "current-fast" | "compatibility";
  readonly compatibilityStepCount: number;
  readonly epoch: string;
  readonly fingerprint: string;
}

export type LegacyMigrationRequirement = LegacyMarker89Obligation;

/**
 * Marker 69 was emitted by a released compatibility migration that collided
 * with a later retired migration.  It is evidence we must retain, but is not
 * part of the logical current marker set.  Do not "repair" old databases by
 * deleting it: fingerprinting deliberately canonicalises this alias.
 */
export const ACCEPTED_LEGACY_MARKER_ALIASES = Object.freeze([69]);

export const legacyMigrationRequirements: readonly LegacyMigrationRequirement[] = legacyMarker89Obligations;

export function canonicalMigrationMarkers(): number[] {
  return [...RELEASED_LEGACY_MARKERS, ...orderedMigrations.map((migration) => migration.id)];
}

export function canonicalSchemaCatalog(database: DatabaseSync): CanonicalSchemaCatalog {
  const rows = database.prepare(`
    SELECT type, name, tbl_name AS tableName, sql
    FROM sqlite_master
    WHERE type IN ('table','index','trigger','view')
      AND name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all() as Array<{ type: "table" | "index" | "trigger" | "view"; name: string; tableName: string; sql: string | null }>;
  const catalog = {
    tables: [] as string[],
    indexes: [] as string[],
    triggers: [] as string[],
    views: [] as string[],
    markers: logicalMigrationMarkers(readMigrationMarkers(database))
  };
  for (const row of rows) {
    const entry = `${row.name}\u0000${row.tableName}\u0000${normalizeSchemaSql(row.sql)}`;
    if (row.type === "table") catalog.tables.push(entry);
    else if (row.type === "index") catalog.indexes.push(entry);
    else if (row.type === "trigger") catalog.triggers.push(entry);
    else catalog.views.push(entry);
  }
  catalog.tables.sort();
  catalog.indexes.sort();
  catalog.triggers.sort();
  catalog.views.sort();
  return catalog;
}

export function schemaFingerprint(database: DatabaseSync): string {
  const catalog = canonicalSchemaCatalog(database);
  const fingerprintInput = JSON.stringify({
    epoch: CURRENT_SCHEMA_EPOCH,
    catalog: {
      tables: catalog.tables,
      indexes: catalog.indexes,
      triggers: catalog.triggers,
      views: catalog.views
    },
    tablePolicy: CURRENT_TABLE_MANIFEST.map((table) => ({
      name: table.name,
      lease: table.lease,
      retention: table.retention,
      integrity: table.integrity
    })).sort((left, right) => left.name.localeCompare(right.name)),
    requiredMarkers: canonicalMigrationMarkers()
  });
  return createHash("sha256").update(fingerprintInput).digest("hex");
}

export function readSchemaMetadata(database: DatabaseSync): SchemaMetadata {
  const metadata = readOptionalSchemaMetadata(database);
  if (!metadata) throw new Error("SQLite schema metadata is absent");
  return metadata;
}

export function readOptionalSchemaMetadata(database: DatabaseSync): SchemaMetadata | null {
  if (!hasObject(database, "table", "schema_metadata")) return null;
  const row = database.prepare(`
    SELECT epoch, fingerprint FROM schema_metadata WHERE singleton_id = 1
  `).get() as { epoch: string; fingerprint: string } | undefined;
  if (!row) return null;
  // Metadata describes the canonical target, rather than becoming a second
  // mutable view of schema_migrations. Validation below compares the live
  // logical marker set before any fast-open is accepted.
  return { epoch: row.epoch, fingerprint: row.fingerprint, markers: canonicalMigrationMarkers() };
}

export function validateCanonicalSchema(database: DatabaseSync): string {
  const markers = logicalMigrationMarkers(readMigrationMarkers(database));
  const expectedMarkers = canonicalMigrationMarkers();
  if (!equalNumbers(markers, expectedMarkers)) {
    throw new Error(`SQLite schema marker drift: expected ${expectedMarkers.join(",")}, received ${markers.join(",")}`);
  }
  const missingLegacyRequirements = legacyMigrationRequirements
    .filter((requirement) => !requirement.isSatisfied(database))
    .map((requirement) => requirement.id);
  if (missingLegacyRequirements.length) {
    throw new Error(`SQLite schema legacy marker 89 obligations are incomplete: ${missingLegacyRequirements.join(",")}`);
  }
  validateCurrentTablePolicies(database);
  return schemaFingerprint(database);
}

export function validateCurrentTablePolicies(database: DatabaseSync): void {
  const manifestNames = CURRENT_TABLE_MANIFEST.map(({ name }) => name).sort();
  const duplicateNames = manifestNames.filter((name, index) => index > 0 && name === manifestNames[index - 1]);
  const liveNames = (database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>).map(({ name }) => name);
  const manifestSet = new Set<string>(manifestNames);
  const liveSet = new Set(liveNames);
  const missing = manifestNames.filter((name) => !liveSet.has(name));
  const unclassified = liveNames.filter((name) => !manifestSet.has(name));
  const invalidExemptions = CURRENT_TABLE_MANIFEST
    .filter((table) => table.lease.kind === "exempt" && table.lease.reason.trim().length === 0)
    .map(({ name }) => name);
  const incomplete = CURRENT_TABLE_MANIFEST.filter((table) =>
    !["fenced", "exempt"].includes(table.lease.kind)
      || !["bootstrap", "hot-state", "durable-evidence", "audit"].includes(table.retention)
      || !["structural", "semantic"].includes(table.integrity)
      || (table.lease.kind === "fenced" && table.retention === "bootstrap")
      || (table.lease.kind === "exempt" && table.retention !== "bootstrap")
  ).map(({ name }) => name);
  if (duplicateNames.length || missing.length || unclassified.length || invalidExemptions.length || incomplete.length) {
    const details = [
      duplicateNames.length ? `duplicate=${[...new Set(duplicateNames)].join(",")}` : "",
      missing.length ? `missing=${missing.join(",")}` : "",
      unclassified.length ? `unclassified=${unclassified.join(",")}` : "",
      invalidExemptions.length ? `exemption-reason=${invalidExemptions.join(",")}` : "",
      incomplete.length ? `incomplete=${incomplete.join(",")}` : ""
    ].filter(Boolean).join("; ");
    throw new Error(`SQLite schema policy drift: ${details}`);
  }
}

export function validateCurrentSchema(database: DatabaseSync, metadata: SchemaMetadata): string {
  if (metadata.epoch !== CURRENT_SCHEMA_EPOCH) {
    throw new Error(`SQLite schema epoch mismatch: expected ${CURRENT_SCHEMA_EPOCH}, received ${metadata.epoch}`);
  }
  const fingerprint = validateCanonicalSchema(database);
  if (metadata.fingerprint !== fingerprint) {
    throw new Error(`SQLite schema fingerprint drift: expected ${metadata.fingerprint}, received ${fingerprint}`);
  }
  return fingerprint;
}

export function recordSchemaMetadata(database: DatabaseSync, fingerprint: string): void {
  ensureSchemaMetadataTable(database);
  database.prepare(`
    INSERT INTO schema_metadata(singleton_id, epoch, fingerprint) VALUES (1, ?, ?)
    ON CONFLICT(singleton_id) DO UPDATE SET epoch=excluded.epoch, fingerprint=excluded.fingerprint
  `).run(CURRENT_SCHEMA_EPOCH, fingerprint);
}

/** Create the metadata table before fingerprinting so its DDL is protected. */
export function ensureSchemaMetadataTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_metadata(
      singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
      epoch TEXT NOT NULL,
      fingerprint TEXT NOT NULL
    )
  `);
}

export function isFreshSchema(database: DatabaseSync): boolean {
  const objects = database.prepare(`
    SELECT type, name FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' AND name NOT IN ('instance_lease', 'schema_metadata')
  `).all() as Array<{ type: string; name: string }>;
  return objects.length === 0;
}

export function countCompatibilitySteps(database: DatabaseSync): number {
  const presentMarkers = new Set(readMigrationMarkers(database));
  const ordinaryMissing = canonicalMigrationMarkers().filter((marker) => marker !== 89 && !presentMarkers.has(marker)).length;
  const marker89ObligationsMissing = legacyMigrationRequirements.filter((requirement) => !requirement.isSatisfied(database)).length;
  return ordinaryMissing + marker89ObligationsMissing;
}

/** The marker representation used for current-schema validation and hashes. */
export function logicalMigrationMarkers(markers: readonly number[]): number[] {
  return markers.filter((marker) => !ACCEPTED_LEGACY_MARKER_ALIASES.includes(marker));
}

function readMigrationMarkers(database: DatabaseSync): number[] {
  if (!hasObject(database, "table", "schema_migrations")) return [];
  return (database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>)
    .map(({ version }) => version);
}

function hasObject(database: DatabaseSync, type: string, name: string): boolean {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get(type, name) !== undefined;
}

function normalizeSchemaSql(sql: string | null): string {
  if (!sql) return "";
  return sql.trim()
    .replace(/\s+/g, " ")
    .replace(/\s*([(),=])\s*/g, "$1");
}

function equalNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

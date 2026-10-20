import type { DatabaseSync } from "node:sqlite";
import { nativeTurnPromptId, nativeTurnSourceKey } from "../../domain/native-turn-identity.js";
import type { SqliteContext } from "./context.js";

export type PromptIdentityCorrection = {
  aliasPromptId: string;
  canonicalPromptId: string;
  bindingId: string;
  bindingGeneration: number;
  paneId: string;
  nativeSessionId: string;
  turnId: string;
  legacyStartedAt: string;
  canonicalStartedAt: string;
  reason: "canonical_start_correction";
  createdAt: string;
};

/**
 * Alias rows intentionally outlive their legacy Prompt.  SQLite readers must
 * therefore be able to re-derive both prompt identities from the persisted
 * labelled tuple instead of trusting the IDs recorded in a correction row.
 */
export function registerPromptIdentitySqlFunctions(database: DatabaseSync): void {
  database.function("native_turn_prompt_id", { deterministic: true }, (bindingId: unknown, bindingGeneration: unknown, paneId: unknown, nativeSessionId: unknown, turnId: unknown, startedAt: unknown) =>
    nativeTurnPromptId(nativeTurnIdentityFromSql([bindingId, bindingGeneration, paneId, nativeSessionId, turnId, startedAt])));
  database.function("native_turn_source_key", { deterministic: true }, (bindingId: unknown, bindingGeneration: unknown, paneId: unknown, nativeSessionId: unknown, turnId: unknown, startedAt: unknown) =>
    nativeTurnSourceKey(nativeTurnIdentityFromSql([bindingId, bindingGeneration, paneId, nativeSessionId, turnId, startedAt])));
}

function nativeTurnIdentityFromSql(values: readonly unknown[]) {
  const [bindingId, bindingGeneration, paneId, nativeSessionId, turnId, startedAt] = values;
  return {
    bindingId: String(bindingId), bindingGeneration: Number(bindingGeneration), paneId: String(paneId),
    nativeSessionId: String(nativeSessionId), turnId: String(turnId), startedAt: String(startedAt)
  };
}

export function loadPromptIdentityCorrection(context: SqliteContext, aliasPromptId: string): PromptIdentityCorrection | null {
  const row = context.database.prepare(`
    SELECT alias_prompt_id, canonical_prompt_id, binding_id, binding_generation, pane_id, native_session_id, turn_id,
      legacy_started_at, canonical_started_at, reason, created_at
    FROM prompt_identity_corrections
    WHERE alias_prompt_id = ?
      AND EXISTS (${validPromptIdentityCorrectionExistsSql("prompt_identity_corrections")})
  `).get(aliasPromptId) as {
    alias_prompt_id: string;
    canonical_prompt_id: string;
    binding_id: string;
    binding_generation: number;
    pane_id: string;
    native_session_id: string;
    turn_id: string;
    legacy_started_at: string;
    canonical_started_at: string;
    reason: "canonical_start_correction";
    created_at: string;
  } | undefined;
  return row ? mapPromptIdentityCorrection(row) : null;
}

export function recordPromptIdentityCorrection(context: SqliteContext, input: PromptIdentityCorrection): void {
  const identity = {
    bindingId: input.bindingId,
    bindingGeneration: input.bindingGeneration,
    paneId: input.paneId,
    nativeSessionId: input.nativeSessionId,
    turnId: input.turnId
  };
  if (input.aliasPromptId !== nativeTurnPromptId({ ...identity, startedAt: input.legacyStartedAt })
    || input.canonicalPromptId !== nativeTurnPromptId({ ...identity, startedAt: input.canonicalStartedAt })) {
    throw new Error(`Prompt identity correction proof mismatch for alias ${input.aliasPromptId}`);
  }
  const existing = loadPromptIdentityCorrection(context, input.aliasPromptId);
  if (existing) {
    if (existing.canonicalPromptId !== input.canonicalPromptId
      || existing.bindingId !== input.bindingId
      || existing.bindingGeneration !== input.bindingGeneration
      || existing.paneId !== input.paneId
      || existing.nativeSessionId !== input.nativeSessionId
      || existing.turnId !== input.turnId
      || existing.legacyStartedAt !== input.legacyStartedAt
      || existing.canonicalStartedAt !== input.canonicalStartedAt
      || existing.reason !== input.reason) {
      throw new Error(`Prompt identity correction conflict for alias ${input.aliasPromptId}`);
    }
    return;
  }
  context.database.prepare(`
    INSERT INTO prompt_identity_corrections(
      alias_prompt_id, canonical_prompt_id, binding_id, binding_generation, pane_id, native_session_id, turn_id,
      legacy_started_at, canonical_started_at, reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.aliasPromptId,
    input.canonicalPromptId,
    input.bindingId,
    input.bindingGeneration,
    input.paneId,
    input.nativeSessionId,
    input.turnId,
    input.legacyStartedAt,
    input.canonicalStartedAt,
    input.reason,
    input.createdAt
  );
}

export function resolveCanonicalPromptId(context: SqliteContext, promptId: string): string {
  return (context.database.prepare(`
    SELECT correction.canonical_prompt_id
    FROM prompt_identity_corrections correction
    WHERE correction.alias_prompt_id = ?
      AND EXISTS (${validPromptIdentityCorrectionExistsSql("correction")})
    LIMIT 1
  `).get(promptId) as { canonical_prompt_id: string } | undefined)?.canonical_prompt_id ?? promptId;
}

export function validPromptIdentityCorrectionExistsSql(correctionAlias: string): string {
  return `SELECT 1
    FROM prompt_jobs canonical
    JOIN run_cards canonical_card ON canonical_card.prompt_id = canonical.id
    JOIN prompt_transcript_turns canonical_turn ON canonical_turn.prompt_id = canonical.id
    WHERE canonical.id = ${correctionAlias}.canonical_prompt_id
      AND ${correctionAlias}.alias_prompt_id = native_turn_prompt_id(
        ${correctionAlias}.binding_id, ${correctionAlias}.binding_generation, ${correctionAlias}.pane_id,
        ${correctionAlias}.native_session_id, ${correctionAlias}.turn_id, ${correctionAlias}.legacy_started_at
      )
      AND ${correctionAlias}.canonical_prompt_id = native_turn_prompt_id(
        ${correctionAlias}.binding_id, ${correctionAlias}.binding_generation, ${correctionAlias}.pane_id,
        ${correctionAlias}.native_session_id, ${correctionAlias}.turn_id, ${correctionAlias}.canonical_started_at
      )
      AND canonical.execution_origin = 'herdr'
      AND canonical.ingress_source = 'herdr'
      AND canonical.binding_id = ${correctionAlias}.binding_id
      AND canonical.source_message_key = native_turn_source_key(
        ${correctionAlias}.binding_id, ${correctionAlias}.binding_generation, ${correctionAlias}.pane_id,
        ${correctionAlias}.native_session_id, ${correctionAlias}.turn_id, ${correctionAlias}.canonical_started_at
      )
      AND canonical.transcript_turn_id = ${correctionAlias}.turn_id
      AND canonical.transcript_turn_started_at = ${correctionAlias}.canonical_started_at
      AND canonical_card.binding_generation = ${correctionAlias}.binding_generation
      AND canonical_card.binding_id = ${correctionAlias}.binding_id
      AND canonical_card.pane_id = ${correctionAlias}.pane_id
      AND canonical_turn.binding_id = ${correctionAlias}.binding_id
      AND canonical_turn.binding_generation = ${correctionAlias}.binding_generation
      AND canonical_turn.pane_id = ${correctionAlias}.pane_id
      AND canonical_turn.native_session_id = ${correctionAlias}.native_session_id
      AND canonical_turn.turn_id = ${correctionAlias}.turn_id
      AND canonical_turn.started_at = ${correctionAlias}.canonical_started_at
      AND canonical_turn.origin = 'prompt'
      AND canonical_turn.ordinal = 0
      AND ${correctionAlias}.alias_prompt_id != ${correctionAlias}.canonical_prompt_id
      AND NOT EXISTS (
        SELECT 1
        FROM prompt_identity_corrections chained
        WHERE chained.alias_prompt_id = ${correctionAlias}.canonical_prompt_id
      )`;
}

export function invalidPromptIdentityCorrectionPredicateSql(correctionAlias: string): string {
  return `${correctionAlias}.alias_prompt_id = ${correctionAlias}.canonical_prompt_id
    OR NOT EXISTS (${validPromptIdentityCorrectionExistsSql(correctionAlias)})`;
}

export function resolvedPromptReferenceSql(promptIdColumn: string, options?: { bindingIdColumn?: string }): string {
  const bindingFence = options?.bindingIdColumn
    ? `AND (${options.bindingIdColumn} IS NULL OR ${options.bindingIdColumn} = correction.binding_id)`
    : "";
  return `COALESCE(
    (
      SELECT correction.canonical_prompt_id
      FROM prompt_identity_corrections correction
      WHERE correction.alias_prompt_id = ${promptIdColumn}
        ${bindingFence}
        AND EXISTS (${validPromptIdentityCorrectionExistsSql("correction")})
      LIMIT 1
    ),
    ${promptIdColumn}
  )`;
}

export function listPromptIdentityPromptIds(context: SqliteContext, promptId: string): string[] {
  const canonicalPromptId = resolveCanonicalPromptId(context, promptId);
  const aliases = (context.database.prepare(`
    SELECT alias_prompt_id
    FROM prompt_identity_corrections correction
    WHERE correction.canonical_prompt_id = ?
      AND EXISTS (${validPromptIdentityCorrectionExistsSql("correction")})
    ORDER BY created_at, alias_prompt_id
  `).all(canonicalPromptId) as Array<{ alias_prompt_id: string }>).map((row) => row.alias_prompt_id);
  return uniquePromptIds([canonicalPromptId, promptId, ...aliases]);
}

function uniquePromptIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  return unique;
}

function mapPromptIdentityCorrection(row: {
  alias_prompt_id: string;
  canonical_prompt_id: string;
  binding_id: string;
  binding_generation: number;
  pane_id: string;
  native_session_id: string;
  turn_id: string;
  legacy_started_at: string;
  canonical_started_at: string;
  reason: "canonical_start_correction";
  created_at: string;
}): PromptIdentityCorrection {
  return {
    aliasPromptId: row.alias_prompt_id,
    canonicalPromptId: row.canonical_prompt_id,
    bindingId: row.binding_id,
    bindingGeneration: Number(row.binding_generation),
    paneId: row.pane_id,
    nativeSessionId: row.native_session_id,
    turnId: row.turn_id,
    legacyStartedAt: row.legacy_started_at,
    canonicalStartedAt: row.canonical_started_at,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

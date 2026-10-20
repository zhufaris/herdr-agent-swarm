import { createHash } from "node:crypto";
import type { AuditSkeletonSourceKind } from "../../domain/retention-barrier.js";
import type { SqliteContext } from "./context.js";

export function assertCompactedPayloadCompatible(
  context: SqliteContext,
  sourceKind: AuditSkeletonSourceKind,
  sourceId: string,
  payload: string
): void {
  const skeleton = context.database.prepare(`SELECT payload_hash FROM audit_skeletons
    WHERE source_kind=? AND source_id=? AND state='compacted'`).get(sourceKind, sourceId) as { payload_hash: string } | undefined;
  const payloadHash = createHash("sha256").update(payload).digest("hex");
  if (!skeleton || skeleton.payload_hash !== payloadHash) throw new Error("compacted_payload_conflict");
}

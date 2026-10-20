import type { SemanticPaneSnapshotRead, SemanticSnapshotCursor } from "../runtime-observation.js";

export interface RuntimeObservationPort {
  readSemanticSnapshot(input: { cursor: SemanticSnapshotCursor | null; workspaceIds: readonly string[] }): Promise<SemanticPaneSnapshotRead>;
  canAcknowledgeSemanticGeneration(cursor: SemanticSnapshotCursor): boolean;
}

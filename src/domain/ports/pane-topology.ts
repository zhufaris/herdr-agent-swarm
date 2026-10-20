import type { PaneTopologyIntent, PaneTopologyMoveReceipt, PaneTopologyRuntimeIdentity, ReservePaneTopologyIntentInput } from "../pane-topology-intent.js";
import type { HerdrPane, ProjectConfig } from "../types.js";

export interface PaneTopologyIntentStore {
  reserve(input: ReservePaneTopologyIntentInput): { intent: PaneTopologyIntent; inserted: boolean };
  get(id: string): PaneTopologyIntent | null;
  listRecoverable(): PaneTopologyIntent[];
  claim(id: string, at: string): PaneTopologyIntent | null;
  claimNext(at: string): PaneTopologyIntent | null;
  markUncertain(input: { id: string; expectedAttemptCount: number; detail: string; at: string }): PaneTopologyIntent | null;
  rearmIfStillExpected(input: { id: string; expectedAttemptCount: number; observed: PaneTopologyRuntimeIdentity; at: string }): PaneTopologyIntent | null;
  finishSucceeded(input: { id: string; expectedAttemptCount: number; receipt: PaneTopologyMoveReceipt; at: string }): PaneTopologyIntent | null;
  finishWorkerMoveSucceeded(input: {
    id: string; expectedAttemptCount: number; receipt: PaneTopologyMoveReceipt; at: string;
    worker: { id: string; generation: number; sessionGeneration: number; expectedNativeSessionId: string | null };
  }): PaneTopologyIntent | null;
}

export interface PaneTopologyReconciliationPort {
  reconcileWorkspace(input: { project: ProjectConfig; panes: readonly HerdrPane[] }): Promise<{ topologyChanged: boolean }>;
}

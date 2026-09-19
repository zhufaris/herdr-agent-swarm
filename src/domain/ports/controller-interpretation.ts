import type { ControllerInterpretationJob, ControllerRuntimeRecord } from "../controller-interpretation.js";
import type { NaturalLanguageCommandResult } from "../natural-language-command.js";
import type { IncomingLarkMessage } from "../types.js";

export interface ControllerInterpretationStore {
  acceptControllerInterpretation(input: { id: string; message: IncomingLarkMessage; controllerGeneration: number; capabilityHash: string; acceptedAt: string }): { job: ControllerInterpretationJob; inserted: boolean };
  claimNextControllerInterpretation(controllerGeneration: number, capabilityHash: string, claimedAt: string): ControllerInterpretationJob | null;
  markControllerInterpretationDispatched(id: string, controllerGeneration: number, runtimeTurnId: string | null, dispatchedAt: string): ControllerInterpretationJob | null;
  finishControllerInterpretation(id: string, controllerGeneration: number, result: Exclude<NaturalLanguageCommandResult, { outcome: "unresolved" }>, finishedAt: string): ControllerInterpretationJob | null;
  failControllerInterpretation(id: string, controllerGeneration: number, state: "failed" | "uncertain", error: string, finishedAt: string): ControllerInterpretationJob | null;
  getControllerInterpretation(id: string): ControllerInterpretationJob | null;
  recoverControllerInterpretations(recoveredAt: string): number;
  getControllerRuntime(): ControllerRuntimeRecord | null;
  saveControllerRuntime(input: Omit<ControllerRuntimeRecord, "createdAt" | "updatedAt">, savedAt: string): ControllerRuntimeRecord;
  markControllerRuntimeStale(generation: number, updatedAt: string): boolean;
}

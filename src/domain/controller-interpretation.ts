import { z } from "zod";
import { naturalLanguageCommandEnvelopeSchema } from "./natural-language-command-confirmation.js";
import type { NaturalLanguageCommandResult } from "./natural-language-command.js";
import type { IncomingLarkMessage } from "./types.js";

export type ControllerInterpretationJobState = "accepted" | "dispatching" | "observing" | "succeeded" | "clarification" | "unsupported" | "task" | "failed" | "uncertain";
export interface ControllerInterpretationJob { id: string; sourceMessageId: string; message: IncomingLarkMessage; controllerGeneration: number; capabilityHash: string; state: ControllerInterpretationJobState; result: NaturalLanguageCommandResult | null; runtimeTurnId: string | null; dispatchedAt: string | null; error: string | null; createdAt: string; updatedAt: string; }
export interface ControllerRuntimeRecord { generation: number; paneId: string; terminalId: string; nativeSessionId: string; state: "active" | "stale"; createdAt: string; updatedAt: string; }

export const controllerInterpretationResultSchema = z.union([
  z.object({ outcome: z.literal("command"), source: z.literal("controller"), family: z.literal("swarm"), command: naturalLanguageCommandEnvelopeSchema.options[0].shape.command }).strict(),
  z.object({ outcome: z.literal("command"), source: z.literal("controller"), family: z.literal("instance"), command: naturalLanguageCommandEnvelopeSchema.options[1].shape.command }).strict(),
  z.object({ outcome: z.literal("task"), source: z.literal("controller") }).strict(),
  z.object({ outcome: z.literal("clarification"), message: z.string().min(1).max(1000), examples: z.array(z.string().min(1).max(300)).max(3) }).strict(),
  z.object({ outcome: z.literal("unsupported"), message: z.string().min(1).max(1000), examples: z.array(z.string().min(1).max(300)).max(3) }).strict()
]);

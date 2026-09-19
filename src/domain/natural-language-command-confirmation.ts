import type { BridgeCommand, InstanceCommand } from "./types.js";
import type { AcceptCommandIntentInput, AcceptCommandIntentResult } from "./command-intent.js";
import { z } from "zod";

export type NaturalLanguageCommandConfirmationState = "pending" | "consumed" | "expired" | "cancelled";

export type NaturalLanguageCommandEnvelope =
  | { version: 1; family: "swarm"; command: BridgeCommand }
  | { version: 1; family: "instance"; command: InstanceCommand };

const agentKind = z.enum(["pi", "claude-code", "codex", "traex"]);
const bridgeCommand = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stop") }), z.object({ kind: z.literal("steer"), text: z.string().min(1) }),
  z.object({ kind: z.literal("model"), name: z.string().min(1).nullable() }), z.object({ kind: z.literal("reset"), title: z.string().min(1).nullable() }),
  z.object({ kind: z.literal("new"), title: z.string().min(1).nullable(), agentKind }), z.object({ kind: z.literal("projects") }),
  z.object({ kind: z.literal("spaces") }), z.object({ kind: z.literal("panes") }), z.object({ kind: z.literal("sessions"), cursor: z.string().min(1).nullable() }),
  z.object({ kind: z.literal("failures") }), z.object({ kind: z.literal("status") }),
  z.object({ kind: z.literal("attach"), spaceName: z.string().min(1), paneId: z.string().min(1) }), z.object({ kind: z.literal("rename"), title: z.string().min(1) }),
  z.object({ kind: z.literal("close") }), z.object({ kind: z.literal("pane_close_request") }), z.object({ kind: z.literal("pane_close_confirm"), code: z.string().min(1) }),
  z.object({ kind: z.literal("reattach"), paneId: z.string().min(1) }), z.object({ kind: z.literal("replace") }), z.object({ kind: z.literal("resume") }),
  z.object({ kind: z.literal("awake") }), z.object({ kind: z.literal("skip") }),
  z.object({ kind: z.literal("worker_create"), name: z.string().min(1), agentKind, model: z.string().min(1).nullable(), start: z.boolean() }), z.object({ kind: z.literal("help") })
]);
const instanceCommand = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("projects") }), z.object({ kind: z.literal("project"), projectId: z.string().min(1) }), z.object({ kind: z.literal("instances") }),
  z.object({ kind: z.literal("instance"), name: z.string().min(1) }), z.object({ kind: z.literal("to"), name: z.string().min(1), text: z.string().min(1) }),
  z.object({ kind: z.literal("steer_instance"), name: z.string().min(1), text: z.string().min(1) }), z.object({ kind: z.literal("stop_instance"), name: z.string().min(1) })
]);
export const naturalLanguageCommandEnvelopeSchema = z.discriminatedUnion("family", [
  z.object({ version: z.literal(1), family: z.literal("swarm"), command: bridgeCommand }),
  z.object({ version: z.literal(1), family: z.literal("instance"), command: instanceCommand })
]);

export interface NaturalLanguageCommandConfirmation {
  id: string;
  sourceMessageId: string;
  actorOpenId: string;
  chatId: string;
  topicId: string | null;
  rootMessageId: string;
  envelope: NaturalLanguageCommandEnvelope;
  expectedBindingId: string | null;
  expectedBindingGeneration: number | null;
  expectedInstanceId: string | null;
  expectedInstanceGeneration: number | null;
  state: NaturalLanguageCommandConfirmationState;
  expiresAt: string;
  resultDetail: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface StageNaturalLanguageCommandConfirmationInput {
  confirmation: Omit<NaturalLanguageCommandConfirmation, "state" | "resultDetail" | "updatedAt" | "resolvedAt">;
  outbox: { id: string; idempotencyKey: string; card: object };
}

export type StageNaturalLanguageCommandConfirmationResult =
  | { outcome: "staged" | "duplicate"; confirmation: NaturalLanguageCommandConfirmation }
  | { outcome: "conflict"; confirmation: NaturalLanguageCommandConfirmation };

export type DecideNaturalLanguageCommandConfirmationResult =
  | { outcome: "consumed" | "cancelled"; confirmation: NaturalLanguageCommandConfirmation }
  | { outcome: "unauthorized" | "expired" | "stale" | "already-resolved" | "missing"; confirmation: NaturalLanguageCommandConfirmation | null };

export type ConfirmNaturalLanguageSwarmCommandResult =
  | { outcome: "consumed"; confirmation: NaturalLanguageCommandConfirmation; commandIntent: AcceptCommandIntentResult }
  | Exclude<DecideNaturalLanguageCommandConfirmationResult, { outcome: "consumed" | "cancelled" }>;

export interface ConfirmNaturalLanguageSwarmCommandInput {
  id: string; actorOpenId: string; chatId: string; decidedAt: string; commandIntent: AcceptCommandIntentInput;
}

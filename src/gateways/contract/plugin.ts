import type { Logger } from "pino";

export const GATEWAY_PROTOCOL_VERSION = 1 as const;

export type GatewayKind = "feishu" | "telegram" | "discord";
export type GatewayId = string;
export type GatewayRefKind = "actor" | "conversation" | "thread" | "message" | "surface";

export interface GatewayPluginManifest {
  kind: string;
  pluginVersion: string;
  protocolVersion: number;
}

export interface GatewayCapabilities {
  conversations: { threads: "native" | "synthetic" | "none"; share: boolean };
  presentation: {
    richViews: boolean;
    mutableSurfaces: boolean;
    actions: "forms" | "buttons" | "commands-only";
    incremental:
      | { mode: "sequenced-region"; maxChars: number }
      | { mode: "replace-whole"; maxChars: number }
      | { mode: "none"; maxChars: number };
  };
  idempotency: {
    create: "provider-key" | "bridge-reconcile" | "none";
    reply: "provider-key" | "bridge-reconcile" | "none";
    update: "provider-key" | "bridge-reconcile" | "none";
  };
}

export interface GatewayRequirements {
  threads?: boolean;
  richViews?: boolean;
  mutableSurfaces?: boolean;
  interactions?: boolean;
  orderedStreaming?: boolean;
}

export interface NegotiatedGatewayProfile {
  readonly id: string;
  readonly protocolVersion: 1;
  readonly rendererRevision: number;
  readonly capabilities: GatewayCapabilities;
  readonly degradations: readonly string[];
}

export interface GatewayExternalRef<K extends GatewayRefKind = GatewayRefKind> {
  gatewayId: GatewayId;
  kind: K;
  opaqueId: string;
}

export interface GatewayConversationAddress {
  gatewayId: GatewayId;
  conversation: GatewayExternalRef<"conversation">;
  thread: GatewayExternalRef<"thread"> | null;
  rootMessage: GatewayExternalRef<"message"> | null;
}

export type GatewayInboundEvent =
  | {
      schemaVersion: 1; kind: "message.received"; eventKey: string; occurredAt: string; address: GatewayConversationAddress;
      message: GatewayExternalRef<"message">; parentMessage: GatewayExternalRef<"message"> | null; actor: GatewayExternalRef<"actor">;
      text: string; mentionsAgent: boolean; isRoot: boolean; hasUnsupportedContent: boolean;
    }
  | {
      schemaVersion: 1; kind: "interaction.invoked"; eventKey: string; occurredAt: string; address: GatewayConversationAddress;
      sourceMessage: GatewayExternalRef<"message">; actor: GatewayExternalRef<"actor">; interactionRef: string;
      commandPayload: unknown; option: string | null; values: Readonly<Record<string, string>>;
    };

export type GatewayIngressResponse = void | { toast?: { level: "success" | "warning" | "error"; text: string }; replaceView?: unknown };
export interface GatewayIngressSink { accept(event: GatewayInboundEvent): Promise<GatewayIngressResponse>; }
export interface GatewayIngressPort { start(sink: GatewayIngressSink): Promise<void>; stop(): Promise<void>; }

export type GatewayDeliveryIntent =
  | { kind: "conversation.create"; purpose: GatewayDeliveryPurpose; conversationId: string; view: object; idempotencyKey: string }
  | { kind: "message.reply.text"; purpose: GatewayDeliveryPurpose; rootMessageId: string; text: string; idempotencyKey: string }
  | { kind: "message.reply.view"; purpose: GatewayDeliveryPurpose; rootMessageId: string; view: object; idempotencyKey: string }
  | { kind: "surface.replace"; purpose: GatewayDeliveryPurpose; messageId: string; view: object; sequence?: number }
  | { kind: "stream.create"; purpose: GatewayDeliveryPurpose; rootMessageId: string; view: object; idempotencyKey: string }
  | { kind: "stream.append"; purpose: GatewayDeliveryPurpose; surfaceId: string; slot: string; content: string; sequence: number }
  | { kind: "stream.finish"; purpose: GatewayDeliveryPurpose; surfaceId: string; sequence: number; summary: string }
  | { kind: "conversation.share"; purpose: GatewayDeliveryPurpose; conversationId: string; messageId: string; targetConversationId: string };
export type GatewayDeliveryPurpose = "primary-main" | "primary-answer" | "worker-main" | "worker-turn" | "group-thread" | "operation-result";

export interface PreparedGatewayDelivery {
  protocolVersion: 1; gatewayId: GatewayId; profileId: string; rendererRevision: number; operation: GatewayDeliveryIntent["kind"]; intent: GatewayDeliveryIntent;
}
export interface GatewayDeliveryCheckpoint { kind: "surface"; ref: GatewayExternalRef<"surface">; }
export interface GatewayDeliveryContext {
  attemptId: string; leaseFencingToken: number | null; idempotencyKey: string; priorCheckpoints: readonly GatewayDeliveryCheckpoint[];
  checkpoint(value: GatewayDeliveryCheckpoint): Promise<void>; signal?: AbortSignal;
}
export interface GatewayDeliveryReceipt { refs: readonly GatewayExternalRef[]; }
export interface GatewayFailure {
  failureClass: "transient" | "permanent" | "unknown"; effectCertainty: "not-started" | "rejected" | "uncertain";
  providerCode: string | null; providerOperation?: string; httpStatus: number | null; retryAfterMs?: number; recoveryKind?: "closed_answer_stream" | "stale_main_card"; safeMessage: string;
}
export class GatewayDeliveryError extends Error {
  readonly name = "GatewayDeliveryError";
  constructor(readonly failure: GatewayFailure, readonly cause?: unknown) { super(failure.safeMessage, { cause }); }
}
export interface GatewayDeliveryPort {
  prepare(intent: GatewayDeliveryIntent): PreparedGatewayDelivery;
  execute(plan: PreparedGatewayDelivery, context: GatewayDeliveryContext): Promise<GatewayDeliveryReceipt>;
}
export interface GatewayStatus {
  gatewayId: GatewayId; kind: string; profileId: string; ingress: { ready: boolean; detail?: string }; delivery: { ready: boolean; detail?: string }; degradations: readonly string[];
}
export interface GatewaySession {
  readonly gatewayId: GatewayId; readonly profile: NegotiatedGatewayProfile; readonly ingress: GatewayIngressPort; readonly delivery: GatewayDeliveryPort;
  snapshot(): GatewayStatus; close(): Promise<void>;
}
export interface GatewayServices { logger?: Logger; }
export interface ConversationGatewayPlugin<Config = unknown> {
  readonly manifest: GatewayPluginManifest;
  create(config: Config, services: GatewayServices): GatewaySession;
}
export type GatewayPluginFactory = ConversationGatewayPlugin;

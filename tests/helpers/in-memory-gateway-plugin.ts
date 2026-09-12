import { GATEWAY_PROTOCOL_VERSION, type ConversationGatewayPlugin, type GatewayDeliveryContext, type GatewayDeliveryIntent, type GatewayDeliveryReceipt, type GatewayIngressSink, type GatewaySession, type PreparedGatewayDelivery } from "../../src/gateways/contract/plugin.js";

export interface InMemoryGatewayControl {
  readonly delivered: GatewayDeliveryIntent[];
  emit: GatewayIngressSink["accept"];
}

export function createInMemoryGatewayPlugin(control: InMemoryGatewayControl): ConversationGatewayPlugin<{ gatewayId: string }> {
  return {
    manifest: { kind: "memory", pluginVersion: "1.0.0", protocolVersion: GATEWAY_PROTOCOL_VERSION },
    create(config): GatewaySession {
      let sink: GatewayIngressSink | null = null;
      let ready = false;
      control.emit = (event) => { if (!sink) throw new Error("In-memory Gateway ingress is not started"); return sink.accept(event); };
      const profile = Object.freeze({
        id: "memory-plain-v1", protocolVersion: GATEWAY_PROTOCOL_VERSION, rendererRevision: 1, degradations: ["rich views unavailable"],
        capabilities: { conversations: { threads: "synthetic" as const, share: false }, presentation: { richViews: false, mutableSurfaces: true, actions: "commands-only" as const, incremental: { mode: "replace-whole" as const, maxChars: 4_096 } }, idempotency: { create: "bridge-reconcile" as const, reply: "bridge-reconcile" as const, update: "bridge-reconcile" as const } }
      });
      const delivery = {
        prepare(intent: GatewayDeliveryIntent): PreparedGatewayDelivery { return { protocolVersion: GATEWAY_PROTOCOL_VERSION, gatewayId: config.gatewayId, profileId: profile.id, rendererRevision: profile.rendererRevision, operation: intent.kind, intent: structuredClone(intent) }; },
        async execute(plan: PreparedGatewayDelivery, _context: GatewayDeliveryContext): Promise<GatewayDeliveryReceipt> { control.delivered.push(plan.intent); return { refs: [] }; }
      };
      return {
        gatewayId: config.gatewayId, profile,
        ingress: { async start(next) { sink = next; ready = true; }, async stop() { ready = false; sink = null; } },
        delivery, snapshot: () => ({ gatewayId: config.gatewayId, kind: "memory", profileId: profile.id, ingress: { ready }, delivery: { ready: true }, degradations: profile.degradations }),
        async close() { ready = false; sink = null; }
      };
    }
  };
}

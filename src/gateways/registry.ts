import { GATEWAY_PROTOCOL_VERSION, type ConversationGatewayPlugin, type GatewayRequirements, type GatewayServices, type GatewaySession } from "./contract/plugin.js";

export class BuiltinGatewayRegistry {
  private readonly plugins = new Map<string, ConversationGatewayPlugin>();

  constructor(plugins: readonly ConversationGatewayPlugin[]) {
    for (const plugin of plugins) {
      if (this.plugins.has(plugin.manifest.kind)) throw new Error(`Duplicate Gateway kind: ${plugin.manifest.kind}`);
      this.plugins.set(plugin.manifest.kind, plugin);
    }
  }

  create(kind: string, config: unknown, services: GatewayServices, requirements: GatewayRequirements = {}): GatewaySession {
    const plugin = this.plugins.get(kind);
    if (!plugin) throw new Error(`Unsupported Gateway kind: ${kind}`);
    if (plugin.manifest.protocolVersion !== GATEWAY_PROTOCOL_VERSION) throw new Error(`Unsupported Gateway protocol version: ${plugin.manifest.protocolVersion}`);
    const session = plugin.create(config, services);
    assertRequiredCapabilities(session, requirements);
    return session;
  }
}

function assertRequiredCapabilities(session: GatewaySession, requirements: GatewayRequirements): void {
  const capabilities = session.profile.capabilities;
  if (requirements.threads && capabilities.conversations.threads === "none") throw new Error("Gateway does not support threads");
  if (requirements.richViews && !capabilities.presentation.richViews) throw new Error("Gateway does not support rich views");
  if (requirements.mutableSurfaces && !capabilities.presentation.mutableSurfaces) throw new Error("Gateway does not support mutable surfaces");
  if (requirements.interactions && capabilities.presentation.actions === "commands-only") throw new Error("Gateway does not support interactive actions");
  if (requirements.orderedStreaming && capabilities.presentation.incremental.mode !== "sequenced-region") throw new Error("Gateway does not support ordered streaming");
}

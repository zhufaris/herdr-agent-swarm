import { describe, expect, it, vi } from "vitest";
import { BuiltinGatewayRegistry } from "../src/gateways/registry.js";
import type { ConversationGatewayPlugin, GatewaySession } from "../src/gateways/contract/plugin.js";

function session(gatewayId = "feishu:primary"): GatewaySession {
  return {
    gatewayId,
    profile: {
      id: "feishu-cardkit-v1", protocolVersion: 1, rendererRevision: 1, degradations: [],
      capabilities: {
        conversations: { threads: "native", share: true },
        presentation: { richViews: true, mutableSurfaces: true, actions: "forms", incremental: { mode: "sequenced-region", maxChars: 28_000 } },
        idempotency: { create: "provider-key", reply: "provider-key", update: "provider-key" }
      }
    },
    ingress: { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) },
    delivery: { prepare: vi.fn(), execute: vi.fn() },
    snapshot: () => ({ gatewayId, kind: "feishu", profileId: "feishu-cardkit-v1", ingress: { ready: true }, delivery: { ready: true }, degradations: [] }),
    close: vi.fn(async () => {})
  };
}

function plugin(kind = "feishu", protocolVersion = 1): ConversationGatewayPlugin<{ gatewayId: string }> {
  return {
    manifest: { kind, pluginVersion: "1.0.0", protocolVersion },
    create: vi.fn((input: { gatewayId: string }) => session(input.gatewayId))
  };
}

describe("BuiltinGatewayRegistry", () => {
  it("creates the configured built-in Gateway and verifies required capabilities", async () => {
    const feishu = plugin();
    const registry = new BuiltinGatewayRegistry([feishu]);

    const created = registry.create("feishu", { gatewayId: "feishu:primary" }, {}, {
      threads: true, richViews: true, mutableSurfaces: true, interactions: true, orderedStreaming: true
    });

    expect(created.gatewayId).toBe("feishu:primary");
    expect(feishu.create).toHaveBeenCalledOnce();
  });

  it("rejects duplicate kinds, unknown kinds, and protocol mismatches", async () => {
    expect(() => new BuiltinGatewayRegistry([plugin(), plugin()])).toThrow(/Duplicate Gateway kind/);
    const registry = new BuiltinGatewayRegistry([plugin()]);
    expect(() => registry.create("telegram", { gatewayId: "telegram:primary" }, {})).toThrow(/Unsupported Gateway kind/);
    expect(() => new BuiltinGatewayRegistry([plugin("feishu", 2)]).create("feishu", { gatewayId: "feishu:primary" }, {})).toThrow(/protocol version/);
  });

  it("fails closed when the selected Gateway lacks a required capability", async () => {
    const limited = plugin();
    limited.create = vi.fn(() => ({
      ...session(),
      profile: { ...session().profile, capabilities: { ...session().profile.capabilities, presentation: { ...session().profile.capabilities.presentation, actions: "commands-only" } } }
    }));

    expect(() => new BuiltinGatewayRegistry([limited]).create("feishu", { gatewayId: "feishu:primary" }, {}, { interactions: true })).toThrow(/interactive actions/);
  });
});

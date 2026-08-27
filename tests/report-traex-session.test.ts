import { describe, expect, it, vi } from "vitest";
import { reportTraexSession } from "../src/cli/report-traex-session.js";

describe("TraeX session reporter", () => {
  it("reports an authoritative SessionStart identity for the current Herdr pane", async () => {
    const send = vi.fn(async () => undefined);
    await expect(reportTraexSession(
      JSON.stringify({ hook_event_name: "SessionStart", session_id: "01a03eb1-c193-7531-83c0-e6c6f70143d4", source: "startup" }),
      { HERDR_ENV: "1", HERDR_PANE_ID: "wD:p6", HERDR_BRIDGE_SESSION_SOCKET: "/tmp/bridge.sock", HERDR_BRIDGE_SESSION_CAPABILITY: "a".repeat(64), HERDR_BRIDGE_BINDING_ID: "88f4c290-2fd6-4c0f-9cbb-6be469cb4e6a", HERDR_BRIDGE_GENERATION: "2" },
      send
    )).resolves.toBe("reported");
    expect(send).toHaveBeenCalledWith("/tmp/bridge.sock", {
      paneId: "wD:p6", bindingId: "88f4c290-2fd6-4c0f-9cbb-6be469cb4e6a", generation: 2,
      sessionId: "01a03eb1-c193-7531-83c0-e6c6f70143d4", source: "startup", capability: "a".repeat(64)
    });
  });

  it.each([
    ["wrong event", { hook_event_name: "Stop", session_id: "01a03eb1-c193-7531-83c0-e6c6f70143d4" }],
    ["invalid identity", { hook_event_name: "SessionStart", session_id: "latest" }],
    ["local clear session", { hook_event_name: "SessionStart", session_id: "01a03eb1-c193-7531-83c0-e6c6f70143d4", source: "clear" }]
  ])("drops %s without contacting Herdr", async (_label, input) => {
    const send = vi.fn(async () => undefined);
    await expect(reportTraexSession(JSON.stringify(input), { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_BRIDGE_SESSION_SOCKET: "/tmp/bridge.sock", HERDR_BRIDGE_SESSION_CAPABILITY: "a".repeat(64), HERDR_BRIDGE_BINDING_ID: "88f4c290-2fd6-4c0f-9cbb-6be469cb4e6a", HERDR_BRIDGE_GENERATION: "1" }, send)).resolves.toBe("dropped");
    expect(send).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import { reportTraexSession } from "../src/cli/report-traex-session.js";

describe("TraeX session reporter", () => {
  it("reports an authoritative SessionStart identity for the current Herdr pane", async () => {
    const send = vi.fn(async () => undefined);
    await expect(reportTraexSession(
      JSON.stringify({ hook_event_name: "SessionStart", session_id: "01a03eb1-c193-7531-83c0-e6c6f70143d4", source: "startup" }),
      { HERDR_ENV: "1", HERDR_PANE_ID: "wD:p6", HERDR_SOCKET_PATH: "/tmp/herdr.sock" },
      send
    )).resolves.toBe("reported");
    expect(send).toHaveBeenCalledWith("/tmp/herdr.sock", {
      id: expect.stringMatching(/^herdr-lark-bridge:session:/),
      method: "pane.report_agent_session",
      params: {
        pane_id: "wD:p6", source: "herdr-lark-bridge:traex", agent: "traex",
        agent_session_id: "01a03eb1-c193-7531-83c0-e6c6f70143d4", session_start_source: "startup",
        seq: expect.any(Number)
      }
    });
  });

  it.each([
    ["wrong event", { hook_event_name: "Stop", session_id: "01a03eb1-c193-7531-83c0-e6c6f70143d4" }],
    ["invalid identity", { hook_event_name: "SessionStart", session_id: "latest" }]
  ])("drops %s without contacting Herdr", async (_label, input) => {
    const send = vi.fn(async () => undefined);
    await expect(reportTraexSession(JSON.stringify(input), { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/tmp/herdr.sock" }, send)).resolves.toBe("dropped");
    expect(send).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import { reportTraexLifecycle } from "../src/runtime/report-traex-lifecycle.js";

describe("TraeX lifecycle hook reporter", () => {
  it.each([
    ["UserPromptSubmit", "working"],
    ["Stop", "idle"]
  ] as const)("maps %s to %s without forwarding hook content", async (hookEventName, state) => {
    const run = vi.fn(async () => undefined);
    const raw = JSON.stringify({ hook_event_name: hookEventName, session_id: "session-secret", prompt: "never forward me" });

    await reportTraexLifecycle(raw, { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_TRAEX_REAL_HERDR: "/opt/herdr" }, run, () => 123n);

    expect(run).toHaveBeenCalledWith("/opt/herdr", ["pane", "report-agent", "w1:p1", "--source", "herdr-traex-shim", "--agent", "codex", "--state", state, "--seq", "123"]);
    expect(JSON.stringify(run.mock.calls)).not.toContain("session-secret");
    expect(JSON.stringify(run.mock.calls)).not.toContain("never forward me");
  });

  it.each([
    [JSON.stringify({ hook_event_name: "SessionStart" }), { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_TRAEX_REAL_HERDR: "/opt/herdr" }],
    [JSON.stringify({ hook_event_name: "SessionStart", session_id: "01a03eb1-c193-7531-83c0-e6c6f70143d4", source: "startup" }), { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_TRAEX_REAL_HERDR: "/opt/herdr" }],
    [JSON.stringify({ hook_event_name: "Stop" }), { HERDR_ENV: "1", HERDR_TRAEX_REAL_HERDR: "/opt/herdr" }],
    ["x".repeat(65_537), { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_TRAEX_REAL_HERDR: "/opt/herdr" }]
  ])("rejects unsupported or unsafe hook input", async (raw, environment) => {
    const run = vi.fn(async () => undefined);
    await expect(reportTraexLifecycle(raw, environment, run)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
});

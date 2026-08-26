import { describe, expect, it } from "vitest";
import { deriveSessionPhase, transitionSession, type PaneThreadSessionState } from "../src/domain/pane-thread-lifecycle.js";

const ready: PaneThreadSessionState = {
  lifecycle: "active", attachment: "attached", runtime: "idle",
  generation: 1, provisioningCheckpoint: "activated", degradationCount: 0,
  hasCompletedTurn: false
};

describe("pane/thread lifecycle", () => {
  it("validates lifecycle transitions instead of accepting arbitrary state patches", () => {
    expect(transitionSession(ready, { type: "archive_requested", hasActiveTurn: true })).toMatchObject({ lifecycle: "draining" });
    expect(transitionSession(ready, { type: "archive_requested", hasActiveTurn: false })).toMatchObject({ lifecycle: "archived" });
    expect(() => transitionSession({ ...ready, lifecycle: "closed" }, { type: "activate" })).toThrow(/activate.*closed/i);
  });

  it("keeps attachment health separate from lifecycle and uses failure hysteresis", () => {
    const degraded = transitionSession(ready, { type: "pane_probe_failed", confirmedMissing: false, orphanThreshold: 2 });
    expect(degraded).toMatchObject({ lifecycle: "active", attachment: "degraded", degradationCount: 1 });
    const orphaned = transitionSession(degraded, { type: "pane_probe_failed", confirmedMissing: false, orphanThreshold: 2 });
    expect(orphaned).toMatchObject({ lifecycle: "active", attachment: "orphaned", degradationCount: 2 });
    expect(transitionSession(degraded, { type: "pane_observed", runtime: "done" })).toMatchObject({ attachment: "attached", degradationCount: 0, runtime: "done" });
  });

  it("renders a newly activated session as ready and reserves done for a completed turn", () => {
    expect(deriveSessionPhase(ready)).toBe("ready");
    expect(deriveSessionPhase({ ...ready, runtime: "done", hasCompletedTurn: true })).toBe("done");
    expect(deriveSessionPhase({ ...ready, attachment: "degraded" })).toBe("degraded");
    expect(deriveSessionPhase({ ...ready, attachment: "orphaned" })).toBe("orphaned");
  });

  it("increments generation only when attaching a replacement pane", () => {
    const orphaned = { ...ready, attachment: "orphaned" as const };
    expect(transitionSession(orphaned, { type: "pane_reattached", replacement: false })).toMatchObject({ generation: 1, attachment: "attached" });
    expect(transitionSession(orphaned, { type: "pane_reattached", replacement: true })).toMatchObject({ generation: 2, attachment: "attached", runtime: "unknown" });
  });

  it("recovers a verified failed binding through explicit domain transitions", () => {
    const failed = { ...ready, lifecycle: "failed" as const };

    expect(transitionSession(failed, { type: "recover_failed", runtime: "idle" })).toMatchObject({
      lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated", runtime: "idle", degradationCount: 0
    });
    expect(transitionSession(failed, { type: "retry_failed_provisioning", runtime: "done" })).toMatchObject({
      lifecycle: "provisioning", attachment: "unattached", provisioningCheckpoint: "runtime_started", runtime: "done", degradationCount: 0
    });
    expect(() => transitionSession(ready, { type: "recover_failed", runtime: "idle" })).toThrow(/recover_failed.*active/i);
  });
});

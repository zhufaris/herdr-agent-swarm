import { describe, expect, it } from "vitest";
import { decidePaneCreatedCheckpoint, decideSelectedCheckpoint, provisioningRecoveryMessage } from "../src/coordinator/binding-provisioning-policy.js";

describe("binding provisioning policy", () => {
  it("permits pane creation only on the original selected request path", () => {
    expect(decideSelectedCheckpoint("selected", true)).toBe("create_pane");
    expect(decideSelectedCheckpoint("selected", false)).toBe("manual_attach");
    expect(decideSelectedCheckpoint("runtime_started", false)).toBe("continue");
  });

  it("protects generation-scoped capability and replaces an occupied legacy pane", () => {
    expect(decidePaneCreatedCheckpoint({ checkpoint: "pane_created", hasPrimaryToolCapability: false, traexProcess: false, composerReady: false })).toBe("reject_missing_capability");
    expect(decidePaneCreatedCheckpoint({ checkpoint: "pane_created", hasPrimaryToolCapability: true, traexProcess: true, composerReady: false })).toBe("replace_pane");
    expect(decidePaneCreatedCheckpoint({ checkpoint: "pane_created", hasPrimaryToolCapability: true, traexProcess: true, composerReady: true })).toBe("start_runtime");
    expect(decidePaneCreatedCheckpoint({ checkpoint: "activated", hasPrimaryToolCapability: false, traexProcess: true, composerReady: false })).toBe("continue");
  });

  it("explains manual attach recovery without suggesting duplicate creation", () => {
    expect(provisioningRecoveryMessage(new Error("inspect and /swarm attach <space> <pane>"))).toContain("/swarm new");
    expect(provisioningRecoveryMessage(new Error("temporary Lark failure"))).toContain("安全重试");
  });
});

import { describe, expect, it } from "vitest";
import { primaryManagedAgentName } from "../src/domain/managed-agent-name.js";

describe("Primary managed Agent names", () => {
  it("is stable for a provisioning checkpoint and distinct across binding identities", () => {
    const first = primaryManagedAgentName("herdr-agent-swarm", "binding-1", 1);
    expect(primaryManagedAgentName("herdr-agent-swarm", "binding-1", 1)).toBe(first);
    expect(primaryManagedAgentName("herdr-agent-swarm", "binding-2", 1)).not.toBe(first);
    expect(primaryManagedAgentName("herdr-agent-swarm", "binding-1", 2)).not.toBe(first);
    expect(first).not.toBe("herdr-agent-swarm-primary");
  });

  it("preserves the unique suffix when the project name is long or needs normalization", () => {
    const names = [
      primaryManagedAgentName("123_PROJECT_WITH_A_VERY_LONG_NAME", "binding-1", 1),
      primaryManagedAgentName("123_PROJECT_WITH_A_VERY_LONG_NAME", "binding-2", 1)
    ];
    expect(new Set(names)).toHaveLength(2);
    for (const name of names) {
      expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
      expect(name.length).toBeLessThanOrEqual(32);
    }
  });
});

import { describe, expect, it } from "vitest";
import { transcriptObserverIdentity, transcriptSessionFor } from "../src/domain/transcript-observer-identity.js";

const binding = { generation: 2, paneId: "w1:p1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session:one" };

describe("transcript observer identity", () => {
  it("derives an unambiguous stable identity from the exact runtime source", () => {
    expect(transcriptObserverIdentity(binding)).toBe("1:25:w1:p111:herdr:traex5:traex2:id11:session:one");
    expect(transcriptSessionFor(binding)).toEqual({ source: "herdr:traex", agent: "traex", kind: "id", value: "session:one" });
  });

  it("rejects legacy source aliases", () => {
    const legacy = { ...binding, agentSessionSource: "herdr:codex" };
    const shim = { ...binding, agentSessionSource: "herdr-traex-shim" };
    expect(transcriptObserverIdentity(legacy)).toBeNull();
    expect(transcriptObserverIdentity(shim)).toBeNull();
    expect(transcriptSessionFor(legacy)).toBeNull();
  });

  it.each([
    { generation: 3 }, { paneId: "w1:p2" }, { agentSessionValue: "session:two" }
  ])("changes when a cursor-reuse fence changes: %o", (change) => {
    expect(transcriptObserverIdentity({ ...binding, ...change })).not.toBe(transcriptObserverIdentity(binding));
  });

  it("rejects incomplete sources", () => {
    expect(transcriptObserverIdentity({ ...binding, paneId: null })).toBeNull();
    expect(transcriptObserverIdentity({ ...binding, agentSessionValue: null })).toBeNull();
  });
});

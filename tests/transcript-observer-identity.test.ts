import { describe, expect, it } from "vitest";
import { transcriptObserverIdentity, transcriptSessionFor } from "../src/domain/transcript-observer-identity.js";

const binding = { generation: 2, paneId: "w1:p1", agentSessionSource: "traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session:one" };

describe("transcript observer identity", () => {
  it("derives an unambiguous stable identity from the exact runtime source", () => {
    expect(transcriptObserverIdentity(binding)).toBe("1:25:w1:p15:traex5:traex2:id11:session:one");
    expect(transcriptSessionFor(binding)).toEqual({ source: "traex", agent: "traex", kind: "id", value: "session:one" });
  });

  it("keeps the observer cache stable across TraeX source aliases", () => {
    const legacy = { ...binding, agentSessionSource: "herdr:codex" };
    const shim = { ...binding, agentSessionSource: "herdr-traex-shim" };
    const native = { ...binding, agentSessionSource: "herdr:traex" };
    expect(transcriptObserverIdentity(legacy)).toBe(transcriptObserverIdentity(shim));
    expect(transcriptObserverIdentity(shim)).toBe(transcriptObserverIdentity(native));
    expect(transcriptSessionFor(legacy)).toEqual({ source: "herdr:codex", agent: "traex", kind: "id", value: "session:one" });
  });

  it.each([
    { generation: 3 }, { paneId: "w1:p2" }, { agentSessionSource: "other" }, { agentSessionAgent: "codex" }, { agentSessionKind: "thread" }, { agentSessionValue: "session:two" }
  ])("changes when a cursor-reuse fence changes: %o", (change) => {
    expect(transcriptObserverIdentity({ ...binding, ...change })).not.toBe(transcriptObserverIdentity(binding));
  });

  it("rejects incomplete sources", () => {
    expect(transcriptObserverIdentity({ ...binding, paneId: null })).toBeNull();
    expect(transcriptObserverIdentity({ ...binding, agentSessionValue: null })).toBeNull();
  });
});

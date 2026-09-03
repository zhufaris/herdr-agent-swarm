import { describe, expect, it } from "vitest";
import { transcriptObserverIdentity, transcriptSessionFor } from "../src/domain/transcript-observer-identity.js";

const binding = { generation: 2, paneId: "w1:p1", agentSessionSource: "traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session:one" };

describe("transcript observer identity", () => {
  it("derives an unambiguous stable identity from the exact runtime source", () => {
    expect(transcriptObserverIdentity(binding)).toBe("1:25:w1:p15:traex5:traex2:id11:session:one");
    expect(transcriptSessionFor(binding)).toEqual({ source: "traex", agent: "traex", kind: "id", value: "session:one" });
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

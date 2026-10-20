import { describe, expect, it } from "vitest";
import { transcriptObserverIdentity, transcriptSourceFor } from "../src/domain/transcript-observer-identity.js";

const binding = { id: "b1", agentKind: "traex" as const, generation: 2, sessionEpoch: 3, workspaceId: "w1", paneId: "w1:p1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session:one" };

describe("transcript observer identity", () => {
  it("derives an unambiguous stable identity from the exact runtime source", () => {
    expect(transcriptObserverIdentity(binding)).toBe("2:b15:traex1:21:32:w15:w1:p111:herdr:traex5:traex2:id11:session:one");
    expect(transcriptSourceFor(binding)).toMatchObject({
      agentKind: "traex",
      bindingId: "b1",
      generation: 2,
      paneId: "w1:p1",
      nativeSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session:one" },
      sessionActivityContext: {
        scope: { kind: "pane", workspaceId: "w1", paneId: "w1:p1" },
        ownerFence: { kind: "primary", id: "b1", generation: 2, sessionGeneration: 3 },
        producer: { kind: "primary", id: "b1", runtimeGeneration: 2, sessionGeneration: 3, runtimePaneId: "w1:p1" }
      }
    });
  });

  it("preserves native session data without making it the Agent-neutral owner identity", () => {
    const pi = { ...binding, agentKind: "pi" as const, agentSessionSource: null, agentSessionAgent: null, agentSessionKind: null, agentSessionValue: null };
    expect(transcriptSourceFor(pi)).toEqual({ agentKind: "pi", bindingId: "b1", generation: 2, paneId: "w1:p1", nativeSession: null });
    expect(transcriptObserverIdentity(pi)).toBe("2:b12:pi1:21:32:w15:w1:p10:0:0:0:");
  });

  it.each([
    { generation: 3 }, { sessionEpoch: 4 }, { workspaceId: "w2" }, { paneId: "w1:p2" }, { agentSessionValue: "session:two" }, { agentKind: "pi" as const }, { id: "b2" }
  ])("changes when a cursor-reuse fence changes: %o", (change) => {
    expect(transcriptObserverIdentity({ ...binding, ...change })).not.toBe(transcriptObserverIdentity(binding));
  });

  it("rejects incomplete sources", () => {
    expect(transcriptObserverIdentity({ ...binding, paneId: null })).toBeNull();
    expect(transcriptObserverIdentity({ ...binding, id: "" })).toBeNull();
  });
});

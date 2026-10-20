import { describe, expect, it } from "vitest";
import { parseHerdrAgentEvent } from "../src/adapters/herdr-events-adapter.js";
import type { AgentTranscriptSource } from "../src/domain/ports/external.js";
import {
  fromCoreEventEnvelope,
  liveCoreEventLaneId,
  recoveredCoreEventLaneId,
  toCoreEventEnvelope
} from "../src/runtime/herdr-events/identity.js";
import { agentEvent } from "./helpers/herdr-events.js";

const source: AgentTranscriptSource = {
  agentKind: "traex",
  bindingId: "binding-1",
  generation: 2,
  paneId: "w1:p1",
  nativeSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }
};

describe("Herdr event identity", () => {
  it("derives stable, fence-sensitive live and recovered lane identities", () => {
    const live = liveCoreEventLaneId(source, { kind: "at", turnId: "turn-1", startedAt: "2026-09-30T00:00:00Z" }, "source-1");
    expect(live).toBe(liveCoreEventLaneId(source, { kind: "at", turnId: "turn-1", startedAt: "2026-09-30T00:00:00Z" }, "source-1"));
    expect(live).not.toBe(liveCoreEventLaneId({ ...source, generation: 3 }, { kind: "at", turnId: "turn-1", startedAt: "2026-09-30T00:00:00Z" }, "source-1"));
    expect(recoveredCoreEventLaneId(source, "turn-1", "traex", "session-1"))
      .toBe(recoveredCoreEventLaneId(source, "turn-1", "traex", "session-1"));
  });

  it("round-trips a normalized event through the durable envelope", () => {
    const event = parseHerdrAgentEvent(agentEvent("source-1:1", "turn-1", "2026-09-30T00:00:00Z", {
      type: "human_message", message_id: "human-1", text: "hello", truncated: false
    }));
    expect(fromCoreEventEnvelope(toCoreEventEnvelope(event))).toEqual(event);
  });

  it("round-trips canonical conversation activity through the durable envelope", () => {
    const events = [
      agentEvent("source-1:1", "turn-1", "2026-10-07T00:00:00Z", { type: "model_changed", model: "GPT-5.6-Sol" }),
      agentEvent("source-1:2", "turn-1", "2026-10-07T00:00:01Z", { type: "context_compacted", summary: "must not persist" }),
      agentEvent("source-1:3", "turn-1", "2026-10-07T00:00:02Z", {
        type: "agent_activity", agent_id: "reviewer", display_name: "Review Agent", model: "GPT-5.6-Sol", state: "running"
      })
    ].map(parseHerdrAgentEvent);

    expect(events.map((event) => fromCoreEventEnvelope(toCoreEventEnvelope(event)))).toEqual(events);
    expect(JSON.stringify(events.map(toCoreEventEnvelope))).not.toContain("must not persist");
  });
});

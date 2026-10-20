import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { HerdrEventsAdapter } from "../src/adapters/herdr-events-adapter.js";
import type { CommandRunner } from "../src/infra/command-runner.js";
import type { AgentTranscriptSource, HerdrPort } from "../src/domain/ports/external.js";
import { HerdrEventsReader } from "../src/runtime/herdr-events-reader.js";
import { attachedSource, coreEventResponse } from "./helpers/herdr-events.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/herdr-session-events-v1.json", import.meta.url), "utf8")) as {
  capability: object;
  opened: object;
  batch: object;
  receipt: object;
  cursorExpired: { code: string; message: string; resume_cursor?: string; earliest_cursor: string; latest_cursor: string };
};
const source: AgentTranscriptSource = {
  agentKind: "traex", bindingId: "binding-1", generation: 1, paneId: "w1:p1",
  nativeSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }
};

describe("Herdr session event stream v1 adapter", () => {
  it("detects capability and uses only Pane/stream identities for open, read, subscribe, and receipt lookup", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "ping") return fixture.capability;
      if (method === "session.events.open") return fixture.opened;
      if (method === "session.events.read" || method === "session.events.subscribe") return fixture.batch;
      if (method === "agent.events.submission") return fixture.receipt;
      throw new Error(`unexpected method: ${method}`);
    });
    const run = vi.fn<CommandRunner["run"]>();
    const adapter = new HerdrEventsAdapter({ run }, "herdr", { request });

    await expect(adapter.supportsSessionEventStream()).resolves.toBe(true);
    await expect(adapter.openSession("w1:p1")).resolves.toEqual({
      streamId: "stream-epoch-1", terminalId: "terminal-1", agentKind: "traex", sessionId: "session-1",
      earliestCursor: "cursor-0", latestCursor: "cursor-9"
    });
    await expect(adapter.readSession("stream-epoch-1", "cursor-9")).resolves.toMatchObject({
      outcome: "batch", batch: { streamId: "stream-epoch-1", nextCursor: "cursor-10", latestCursor: "cursor-10" }
    });
    await expect(adapter.subscribeSession("stream-epoch-1", "cursor-10")).resolves.toMatchObject({ outcome: "batch" });
    await expect(adapter.sessionSubmissionReceipt("prompt-1")).resolves.toEqual({
      submissionId: "prompt-1", terminalId: "terminal-1", agentKind: "traex", sessionId: "session-1",
      state: "accepted", createdAt: 1790935200000, updatedAt: 1790935200001
    });

    expect(run).not.toHaveBeenCalled();
    expect(request.mock.calls).toEqual([
      ["ping", {}, 2_000],
      ["session.events.open", { pane_id: "w1:p1" }, 5_000],
      ["session.events.read", { stream_id: "stream-epoch-1", after: "cursor-9", limit: 64 }, 5_000],
      ["session.events.subscribe", { stream_id: "stream-epoch-1", after: "cursor-10", limit: 64 }, 5_000],
      ["agent.events.submission", { submission_id: "prompt-1" }, 5_000]
    ]);
    expect(JSON.stringify(request.mock.calls)).not.toMatch(/path|jsonl/i);
  });

  it("returns typed cursor expiry bounds and treats an unsupported capability probe as legacy", async () => {
    const expired = Object.assign(new Error(fixture.cursorExpired.message), {
      code: fixture.cursorExpired.code,
      details: fixture.cursorExpired
    });
    const adapter = new HerdrEventsAdapter({ run: vi.fn() }, "herdr", {
      request: vi.fn(async (method: string) => {
        if (method === "ping") return fixture.capability;
        throw expired;
      })
    });
    await expect(adapter.readSession("stream-epoch-1", "cursor-1")).resolves.toEqual({
      outcome: "cursor_expired", earliestCursor: "cursor-4", latestCursor: "cursor-10"
    });

    const legacy = new HerdrEventsAdapter({ run: vi.fn() }, "herdr", {
      request: vi.fn(async () => { throw Object.assign(new Error("method not found"), { code: "method_not_found" }); })
    });
    await expect(legacy.supportsSessionEventStream()).resolves.toBe(false);
  });

  it("preserves the Core-provided safe resume cursor for an expired v2 ring", async () => {
    const expired = Object.assign(new Error("cursor_expired"), {
      code: "cursor_expired",
      details: {
        code: "cursor_expired",
        message: "cursor_expired",
        resume_cursor: "ring-1:epoch-1:3",
        earliest_cursor: "ring-1:epoch-1:4",
        latest_cursor: "ring-1:epoch-1:10"
      }
    });
    const adapter = new HerdrEventsAdapter({ run: vi.fn() }, "herdr", {
      request: vi.fn(async () => { throw expired; })
    });

    await expect(adapter.readSessionRing("ring-1", "ring-1:epoch-1:1")).resolves.toEqual({
      outcome: "cursor_expired",
      resumeCursor: "ring-1:epoch-1:3",
      earliestCursor: "ring-1:epoch-1:4",
      latestCursor: "ring-1:epoch-1:10"
    });
  });

  it("opens the default event reader through v2 without resolving or retaining a transcript path", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "ping") return fixture.capability;
      if (method === "session.events.open") return fixture.opened;
      if (method === "session.events.read") return fixture.batch;
      if (method === "agent.events.submission") return fixture.receipt;
      throw new Error(`unexpected method: ${method}`);
    });
    const resolveTranscript = vi.fn(async () => { throw new Error("v2 must not resolve JSONL"); });
    const listAllPanes = vi.fn(async () => { throw new Error("v2 open is Pane-authoritative in Core"); });
    const reader = new HerdrEventsReader(
      new HerdrEventsAdapter({ run: vi.fn() }, "herdr", { request }),
      { listAllPanes } as Pick<HerdrPort, "listAllPanes">,
      resolveTranscript
    );

    const opened = await reader.open(source);
    expect(opened.mode).toBe("typed");
    if (opened.mode !== "typed" || !opened.cursor.readObservation) return;
    await expect(opened.cursor.readObservation()).resolves.toEqual({ answerDelta: "" });
    await expect(reader.getNativeSubmissionReceipt?.(source, "prompt-1")).resolves.toMatchObject({
      submissionId: "prompt-1", sessionId: "session-1", state: "accepted"
    });
    expect(resolveTranscript).not.toHaveBeenCalled();
    expect(listAllPanes).not.toHaveBeenCalled();
    expect(JSON.stringify(request.mock.calls)).not.toMatch(/path|jsonl/i);
  });

  it("uses the isolated legacy attach path when Core does not advertise v2", async () => {
    const capability = { ...fixture.capability, capabilities: { session_event_stream_v1: false } };
    const request = vi.fn(async () => capability);
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args.includes("attach")) return coreEventResponse({
        type: "agent_events_attached", source_id: "source-legacy", attach_offset: 10,
        sources: [attachedSource("source-legacy", "active", "cursor-9")]
      });
      if (args.includes("read")) return coreEventResponse({
        type: "agent_events_batch", events: [], next_cursor: "cursor-9", earliest_cursor: "cursor-0", latest_cursor: "cursor-9"
      });
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });
    const resolveTranscript = vi.fn(async () => ({ sessionId: "session-1", path: "/tmp/legacy-session.jsonl" }));
    const reader = new HerdrEventsReader(
      new HerdrEventsAdapter({ run }, "herdr", { request }),
      { async listAllPanes() { return [{
        paneId: "w1:p1", terminalId: "terminal-1", workspaceId: "w1", cwd: null, label: null,
        agentState: "idle" as const, foregroundExecutables: [], agentSession: source.nativeSession
      }]; } },
      resolveTranscript
    );

    const opened = await reader.open(source);
    expect(opened.mode).toBe("typed");
    await expect(reader.getNativeSubmissionReceipt?.(source, "prompt-1")).resolves.toBeNull();
    expect(resolveTranscript).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[1]).toContain("/tmp/legacy-session.jsonl");
  });
});

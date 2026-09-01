import { appendFile, chmod, cp, mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { HerdrAgentSession } from "../src/domain/types.js";
import type { TraexTranscriptCursorPort, TraexTranscriptOpenResult } from "../src/domain/ports.js";
import { TraexTranscriptReader } from "../src/runtime/traex-transcript.js";

const sessionId = "01a03eb1-c193-7531-83c0-e6c6f70143d4";
const fixture = fileURLToPath(new URL("./fixtures/task-jz33-transcript.jsonl", import.meta.url));
const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "traex-transcript-"));
  roots.push(root);
  return root;
}

async function createTranscript(options: { id?: string; useFixture?: boolean; metadata?: unknown } = {}): Promise<{ root: string; path: string }> {
  const id = options.id ?? sessionId;
  const root = await createRoot();
  const path = join(root, "2026", "08", "26", `rollout-2026-08-26T15-30-31-${id}.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  if (options.useFixture) await cp(fixture, path);
  else await writeFile(path, `${JSON.stringify(options.metadata ?? { type: "session_meta", payload: { id } })}\n`);
  return { root, path };
}

function session(overrides: Partial<HerdrAgentSession> = {}): HerdrAgentSession {
  return { source: "herdr-agent-swarm:traex", agent: "traex", kind: "id", value: sessionId, ...overrides };
}

function mutation(items: unknown[], operation = "append"): string {
  return `${JSON.stringify({ type: "history_mutation", payload: { operation, items } })}\n`;
}

function eventMessage(payload: unknown): string {
  return `${JSON.stringify({ type: "event_msg", payload })}\n`;
}

async function expectTyped(result: TraexTranscriptOpenResult): Promise<TraexTranscriptCursorPort> {
  expect(result.mode).toBe("typed");
  if (result.mode !== "typed") throw new Error(`Expected typed transcript, received ${result.reason}`);
  return result.cursor;
}

describe("TraexTranscriptReader", () => {
  it("opens one exact UUID transcript whose session metadata agrees", async () => {
    const { root } = await createTranscript();

    await expect(new TraexTranscriptReader({ sessionsRoot: root }).open(session())).resolves.toMatchObject({ mode: "typed" });
  });

  it("reopens after an exact completed turn and emits turns already written before restart", async () => {
    const { root, path } = await createTranscript();
    const oldTurn = "01a04f35-8c1f-7913-8ac7-9642e7c6a614";
    const laterTurn = "01a04f35-8c1f-7913-8ac7-9642e7c6a615";
    await appendFile(path, [
      eventMessage({ type: "task_started", turn_id: oldTurn, started_at: 1_788_035_304 }),
      eventMessage({ type: "user_message", message: "old request" }),
      eventMessage({ type: "task_complete", turn_id: oldTurn, started_at: 1_788_035_304, completed_at: 1_788_035_305 }),
      eventMessage({ type: "task_started", turn_id: laterTurn, started_at: 1_788_035_306 }),
      eventMessage({ type: "user_message", message: "missed external request" }),
      eventMessage({ type: "task_complete", turn_id: laterTurn, started_at: 1_788_035_306, completed_at: 1_788_035_307, last_agent_message: "missed answer" })
    ].join(""));

    const reader = new TraexTranscriptReader({ sessionsRoot: root });
    const cursor = await expectTyped(await reader.openAfterTurn(session(), oldTurn, "2026-08-29T20:28:24.000Z"));

    await expect(cursor.readObservation?.()).resolves.toMatchObject({
      turnId: laterTurn,
      freshTurnStart: true,
      requestText: "missed external request",
      turnLifecycle: { turnId: laterTurn, state: "completed", startedAt: "2026-08-29T20:28:26.000Z", finalAnswer: "missed answer" }
    });
  });

  it("streams recovery across a large multibyte record before the completed boundary", async () => {
    const { root, path } = await createTranscript();
    const oldTurn = "01a04f35-8c1f-7913-8ac7-9642e7c6a614";
    const laterTurn = "01a04f35-8c1f-7913-8ac7-9642e7c6a615";
    await appendFile(path, [
      eventMessage({ type: "task_started", turn_id: oldTurn, started_at: 1_788_035_304 }),
      mutation([{ type: "message", id: "large-record", role: "assistant", content: [{ type: "output_text", text: "界".repeat(40_000) }] }]),
      eventMessage({ type: "task_complete", turn_id: oldTurn, started_at: 1_788_035_304, completed_at: 1_788_035_305 }),
      eventMessage({ type: "task_started", turn_id: laterTurn, started_at: 1_788_035_306 }),
      eventMessage({ type: "user_message", message: "request after large record" })
    ].join(""));

    const cursor = await expectTyped(await new TraexTranscriptReader({ sessionsRoot: root }).openAfterTurn(session(), oldTurn, "2026-08-29T20:28:24.000Z"));
    await expect(cursor.readObservation?.()).resolves.toMatchObject({
      turnId: laterTurn, freshTurnStart: true, requestText: "request after large record"
    });
  });

  it("fails closed when an exact recovery boundary is incomplete or mismatched", async () => {
    const { root, path } = await createTranscript();
    const oldTurn = "01a04f35-8c1f-7913-8ac7-9642e7c6a614";
    await appendFile(path, eventMessage({ type: "task_started", turn_id: oldTurn, started_at: 1_788_035_304 }));
    const reader = new TraexTranscriptReader({ sessionsRoot: root });

    await expect(reader.openAfterTurn(session(), oldTurn, "2026-08-29T20:28:24.000Z")).resolves.toEqual({ mode: "unavailable", reason: "turn_boundary_incomplete" });
    await expect(reader.openAfterTurn(session(), oldTurn, "2026-08-29T20:28:25.000Z")).resolves.toEqual({ mode: "unavailable", reason: "turn_boundary_not_found" });
  });

  it("reopens at the next turn when the exact detached turn was interrupted without task_complete", async () => {
    const { root, path } = await createTranscript();
    const oldTurn = "01a04f35-8c1f-7913-8ac7-9642e7c6a614";
    const laterTurn = "01a04f35-8c1f-7913-8ac7-9642e7c6a615";
    await appendFile(path, [
      eventMessage({ type: "task_started", turn_id: oldTurn, started_at: 1_788_035_304 }),
      eventMessage({ type: "user_message", message: "interrupted request" }),
      eventMessage({ type: "task_started", turn_id: laterTurn, started_at: 1_788_035_306 }),
      eventMessage({ type: "user_message", message: "replacement request" }),
      eventMessage({ type: "task_complete", turn_id: laterTurn, started_at: 1_788_035_306, completed_at: 1_788_035_307, last_agent_message: "replacement answer" })
    ].join(""));

    const cursor = await expectTyped(await new TraexTranscriptReader({ sessionsRoot: root }).openAfterTurn(session(), oldTurn, "2026-08-29T20:28:24.000Z"));
    await expect(cursor.readObservation?.()).resolves.toMatchObject({
      turnId: laterTurn, freshTurnStart: true, requestText: "replacement request",
      turnLifecycle: { turnId: laterTurn, state: "completed", finalAnswer: "replacement answer" }
    });
  });

  it("returns the exact next-turn offset when its start record crosses a scan chunk", async () => {
    const { root, path } = await createTranscript();
    const oldTurn = "01a04f35-8c1f-7913-8ac7-9642e7c6a614";
    const laterTurn = "01a04f35-8c1f-7913-8ac7-9642e7c6a615";
    await appendFile(path, [
      eventMessage({ type: "task_started", turn_id: oldTurn, started_at: 1_788_035_304 }),
      eventMessage({ type: "user_message", message: "interrupted request" })
    ].join(""));
    const currentBytes = (await readFile(path)).byteLength;
    const emptyPadding = eventMessage({ type: "agent_reasoning_raw_content", text: "" });
    const nextTurnOffset = 2 * 64 * 1024 - 32;
    const paddingBytes = nextTurnOffset - currentBytes - Buffer.byteLength(emptyPadding);
    expect(paddingBytes).toBeGreaterThan(0);
    await appendFile(path, [
      eventMessage({ type: "agent_reasoning_raw_content", text: "x".repeat(paddingBytes) }),
      eventMessage({ type: "task_started", turn_id: laterTurn, started_at: 1_788_035_306 }),
      eventMessage({ type: "user_message", message: "cross-chunk replacement" })
    ].join(""));

    const cursor = await expectTyped(await new TraexTranscriptReader({ sessionsRoot: root }).openAfterTurn(session(), oldTurn, "2026-08-29T20:28:24.000Z"));
    await expect(cursor.readObservation?.()).resolves.toMatchObject({
      turnId: laterTurn, freshTurnStart: true, requestText: "cross-chunk replacement"
    });
  });

  it("emits only assistant output_text parts in source order", async () => {
    const { root, path } = await createTranscript();
    const cursor = await expectTyped(await new TraexTranscriptReader({ sessionsRoot: root }).open(session()));
    await appendFile(path, mutation([
      { type: "message", id: "assistant-1", role: "assistant", content: [
        { type: "reasoning", text: "private reasoning" },
        { type: "output_text", text: "First answer" },
        { type: "output_text", text: "Second answer" }
      ] },
      { type: "message", id: "assistant-1", role: "assistant", content: [{ type: "output_text", text: "duplicate assistant output" }] },
      { type: "message", id: "", role: "assistant", content: [{ type: "output_text", text: "empty item identity" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "missing item identity" }] },
      { type: "message", id: "developer-1", role: "developer", content: [{ type: "output_text", text: "developer instruction" }] },
      { type: "message", id: "system-1", role: "system", content: [{ type: "output_text", text: "system instruction" }] },
      { type: "message", id: "user-1", role: "user", content: [{ type: "output_text", text: "user prompt" }] }
    ]));

    const output = await cursor.readDelta();
    expect(output).toBe("First answer\n\nSecond answer");
    expect(output).not.toMatch(/private reasoning|duplicate assistant output|empty item identity|missing item identity|developer instruction|system instruction|user prompt/);
  });

  it("separates the latest reasoning heading from Answer Card content", async () => {
    const { root, path } = await createTranscript();
    const cursor = await expectTyped(await new TraexTranscriptReader({ sessionsRoot: root }).open(session()));
    await appendFile(path, [
      eventMessage({ type: "agent_reasoning_raw_content", text: "**Considering package installation**\n\nPrivate reasoning body that must stay hidden." }),
      mutation([{ type: "message", id: "answer-1", role: "assistant", content: [{ type: "output_text", text: "Public answer" }] }])
    ].join(""));

    await expect(cursor.readObservation?.()).resolves.toEqual({
      answerDelta: "Public answer",
      mainStatus: { statusTitle: "Considering package installation" }
    });
  });

  it("reports a turn as active until the matching task_complete arrives", async () => {
    const { root, path } = await createTranscript();
    const cursor = await expectTyped(await new TraexTranscriptReader({ sessionsRoot: root }).open(session()));
    const turnId = "01a04f35-8c1f-7913-8ac7-9642e7c6a614";
    await appendFile(path, eventMessage({ type: "task_started", turn_id: turnId, started_at: 1_788_035_304 }));

    await expect(cursor.readObservation?.()).resolves.toMatchObject({
      answerDelta: "",
      turnLifecycle: { turnId, state: "active", startedAt: "2026-08-29T20:28:24.000Z" }
    });

    await appendFile(path, eventMessage({ type: "task_complete", turn_id: "01a04f35-ffff-7913-8ac7-9642e7c6a614", started_at: 1_788_035_304, completed_at: 1_788_035_318 }));
    await expect(cursor.readObservation?.()).resolves.toMatchObject({ turnLifecycle: { turnId, state: "active" } });

    await appendFile(path, eventMessage({ type: "task_complete", turn_id: turnId, started_at: 1_788_035_304, completed_at: 1_788_035_318 }));
    await expect(cursor.readObservation?.()).resolves.toMatchObject({
      answerDelta: "",
      turnLifecycle: { turnId, state: "completed", startedAt: "2026-08-29T20:28:24.000Z" }
    });
  });

  it("reports a matching turn_aborted record as a terminal lifecycle", async () => {
    const { root, path } = await createTranscript();
    const cursor = await expectTyped(await new TraexTranscriptReader({ sessionsRoot: root }).open(session()));
    const turnId = "01a04f35-8c1f-7913-8ac7-9642e7c6a614";
    await appendFile(path, [
      eventMessage({ type: "task_started", turn_id: turnId, started_at: 1_788_035_304 }),
      eventMessage({ type: "turn_aborted", turn_id: turnId, reason: "interrupted" })
    ].join(""));

    await expect(cursor.readObservation?.()).resolves.toMatchObject({
      turnId,
      answerDelta: "",
      turnLifecycle: {
        turnId,
        state: "aborted",
        startedAt: "2026-08-29T20:28:24.000Z",
        reason: "interrupted"
      }
    });
  });

  it("restores an aborted lifecycle when the transcript is opened after restart", async () => {
    const { root, path } = await createTranscript();
    const turnId = "01a04f35-8c1f-7913-8ac7-9642e7c6a614";
    await appendFile(path, [
      eventMessage({ type: "task_started", turn_id: turnId, started_at: 1_788_035_304 }),
      eventMessage({ type: "turn_aborted", turn_id: turnId, reason: "interrupted" })
    ].join(""));

    const cursor = await expectTyped(await new TraexTranscriptReader({ sessionsRoot: root }).open(session()));
    await expect(cursor.readObservation?.()).resolves.toMatchObject({
      turnId,
      answerDelta: "",
      turnLifecycle: { turnId, state: "aborted", startedAt: "2026-08-29T20:28:24.000Z", reason: "interrupted" }
    });
  });

  it("reports the user request scoped to a fresh transcript turn", async () => {
    const { root, path } = await createTranscript();
    const cursor = await expectTyped(await new TraexTranscriptReader({ sessionsRoot: root }).open(session()));
    const turnId = "01a04f35-8c1f-7913-8ac7-9642e7c6a614";
    await appendFile(path, [
      eventMessage({ type: "task_started", turn_id: turnId, started_at: 1_788_035_304 }),
      eventMessage({ type: "user_message", message: "run directly from Herdr" }),
      mutation([
        { type: "message", id: "system-1", role: "system", content: [{ type: "input_text", text: "hidden system context" }] },
        { type: "message", id: "developer-1", role: "developer", content: [{ type: "input_text", text: "hidden developer context" }] }
      ])
    ].join(""));

    await expect(cursor.readObservation?.()).resolves.toMatchObject({
      turnId,
      freshTurnStart: true,
      requestText: "run directly from Herdr",
      answerDelta: ""
    });
  });

  it("emits adjacent transcript turns as separate lifecycle-scoped observations", async () => {
    const { root, path } = await createTranscript();
    const cursor = await expectTyped(await new TraexTranscriptReader({ sessionsRoot: root }).open(session()));
    const turnA = "01a04f35-8c1f-7913-8ac7-9642e7c6a614";
    const turnB = "01a04f35-9d2f-7913-8ac7-9642e7c6a615";
    await appendFile(path, [
      mutation([{ type: "message", id: "before-turn", role: "assistant", content: [{ type: "output_text", text: "Unscoped baseline" }] }]),
      eventMessage({ type: "task_started", turn_id: turnA, started_at: 1_788_035_304 }),
      mutation([{ type: "message", id: "answer-a", role: "assistant", content: [{ type: "output_text", text: "Answer A" }] }]),
      eventMessage({ type: "task_complete", turn_id: turnA, started_at: 1_788_035_304, completed_at: 1_788_035_318 }),
      eventMessage({ type: "task_started", turn_id: turnB, started_at: 1_788_035_320 }),
      mutation([{ type: "message", id: "answer-b", role: "assistant", content: [{ type: "output_text", text: "Answer B" }] }])
    ].join(""));

    await expect(cursor.readObservation?.()).resolves.toEqual({ answerDelta: "Unscoped baseline" });
    await expect(cursor.readObservation?.()).resolves.toMatchObject({
      turnId: turnA,
      answerDelta: "Answer A",
      turnLifecycle: { turnId: turnA, state: "completed" }
    });
    await expect(cursor.readObservation?.()).resolves.toMatchObject({
      turnId: turnB,
      answerDelta: "Answer B",
      turnLifecycle: { turnId: turnB, state: "active" }
    });
  });

  it("ends turn scope at completion and keeps later output unscoped", async () => {
    const { root, path } = await createTranscript();
    await appendFile(path, eventMessage({ type: "token_count", info: { total_token_usage: { total_tokens: 100 } } }));
    const cursor = await expectTyped(await new TraexTranscriptReader({ sessionsRoot: root }).open(session()));
    const turnA = "01a04f35-8c1f-7913-8ac7-9642e7c6a614";
    const turnB = "01a04f35-9d2f-7913-8ac7-9642e7c6a615";
    await appendFile(path, [
      eventMessage({ type: "task_started", turn_id: turnA, started_at: 1_788_035_304 }),
      mutation([{ type: "function_call", id: "call-a", call_id: "shared-call", name: "exec_command", arguments: JSON.stringify({ cmd: "npm test" }) }]),
      eventMessage({ type: "task_complete", turn_id: turnA, started_at: 1_788_035_304, completed_at: 1_788_035_318 }),
      mutation([
        { type: "message", id: "after-a", role: "assistant", content: [{ type: "output_text", text: "Between turns" }] },
        { type: "function_call_output", id: "late-result-a", call_id: "shared-call", output: "must not pair with A" },
        { type: "function_call", id: "between-call", call_id: "between-call", name: "exec_command", arguments: JSON.stringify({ cmd: "pwd" }) }
      ]),
      eventMessage({ type: "agent_reasoning_raw_content", text: "**Between status**\nprivate" }),
      eventMessage({ type: "token_count", info: { total_token_usage: { total_tokens: 110 } } }),
      eventMessage({ type: "task_started", turn_id: turnB, started_at: 1_788_035_320 }),
      mutation([
        { type: "function_call_output", id: "result-between", call_id: "between-call", output: "must not pair into B" },
        { type: "message", id: "answer-b", role: "assistant", content: [{ type: "output_text", text: "Answer B" }] }
      ])
    ].join(""));

    await expect(cursor.readObservation?.()).resolves.toMatchObject({
      turnId: turnA, freshTurnStart: true, turnLifecycle: { turnId: turnA, state: "completed" }
    });
    const between = await cursor.readObservation?.();
    expect(between).toMatchObject({
      answerDelta: expect.stringContaining("Between turns"),
      mainStatus: { statusTitle: "Between status", tokenCount: 10 }
    });
    expect(between).not.toHaveProperty("turnId");
    expect(between?.answerDelta).not.toContain("must not pair with A");
    await expect(cursor.readObservation?.()).resolves.toMatchObject({
      turnId: turnB, freshTurnStart: true, answerDelta: "Answer B", turnLifecycle: { turnId: turnB, state: "active" }
    });
  });

  it("does not expose inherited lifecycle as a fresh turn start", async () => {
    const { root, path } = await createTranscript();
    const turnId = "01a04f35-8c1f-7913-8ac7-9642e7c6a614";
    await appendFile(path, eventMessage({ type: "task_started", turn_id: turnId, started_at: 1_788_035_304 }));
    const cursor = await expectTyped(await new TraexTranscriptReader({ sessionsRoot: root }).open(session()));

    await expect(cursor.readObservation?.()).resolves.toMatchObject({
      turnId, answerDelta: "", turnLifecycle: { turnId, state: "active" }
    });
    expect(await cursor.readObservation?.()).not.toHaveProperty("freshTurnStart");
  });

  it("exposes the latest bounded lifecycle snapshot when reopened after completion", async () => {
    const { root, path } = await createTranscript();
    const turnId = "01a04f35-8c1f-7913-8ac7-9642e7c6a614";
    await appendFile(path, [
      eventMessage({ type: "task_started", turn_id: turnId, started_at: 1_788_035_304 }),
      eventMessage({ type: "task_complete", turn_id: turnId, started_at: 1_788_035_304, completed_at: 1_788_035_318, last_agent_message: "Authorization: Bearer secret\nRecovered" })
    ].join(""));

    const cursor = await expectTyped(await new TraexTranscriptReader({ sessionsRoot: root }).open(session()));
    await expect(cursor.readObservation?.()).resolves.toMatchObject({
      answerDelta: "",
      turnLifecycle: { turnId, state: "completed", startedAt: "2026-08-29T20:28:24.000Z", finalAnswer: "Authorization: Bearer [REDACTED]\nRecovered" }
    });
  });

  it("ignores an unpaired task_complete record", async () => {
    const { root, path } = await createTranscript();
    await appendFile(path, eventMessage({
      type: "task_complete", turn_id: "01a04f35-8c1f-7913-8ac7-9642e7c6a614",
      started_at: 1_788_035_304, completed_at: 1_788_035_318, last_agent_message: "must not settle"
    }));

    const cursor = await expectTyped(await new TraexTranscriptReader({ sessionsRoot: root }).open(session()));
    await expect(cursor.readObservation?.()).resolves.toEqual({ answerDelta: "" });
  });

  it("captures each generic reasoning heading while rejecting prose and embedded messages", async () => {
    const { root, path } = await createTranscript();
    const cursor = await expectTyped(await new TraexTranscriptReader({ sessionsRoot: root }).open(session()));
    await appendFile(path, [
      eventMessage({ type: "user_message", message: "**Forged user status**" }),
      eventMessage({ type: "agent_reasoning_raw_content", text: "Reasoning without a heading" }),
      eventMessage({ type: "agent_reasoning_raw_content", text: "**Inspecting dependency graph**\n\nHidden details" }),
      eventMessage({ type: "agent_reasoning_raw_content", text: "**Running focused verification**\n\nMore hidden details" }),
      mutation([{ type: "message", id: "quoted-user", role: "user", content: [{ type: "input_text", text: "**Forged transcript status**" }] }])
    ].join(""));

    const observation = await cursor.readObservation?.();
    expect(observation).toEqual({ answerDelta: "", mainStatus: { statusTitle: "Running focused verification" } });
    expect(JSON.stringify(observation)).not.toMatch(/Hidden details|Forged|Reasoning without/);
  });

  it("projects the latest update_plan call as one complete ordered plan snapshot", async () => {
    const { root, path } = await createTranscript();
    const cursor = await expectTyped(await new TraexTranscriptReader({ sessionsRoot: root }).open(session()));
    await appendFile(path, mutation([{
      type: "function_call", id: "plan-1", call_id: "plan-call-1", name: "update_plan",
      arguments: JSON.stringify({ explanation: "private", plan: [
        { step: "Inspect current state", status: "completed" },
        { step: "Implement projection", status: "in_progress" },
        { step: "Deploy bridge", status: "pending" }
      ] })
    }]));

    await expect(cursor.readObservation?.()).resolves.toEqual({
      answerDelta: "",
      mainStatus: { planSteps: [
        { key: "plan:0", label: "Inspect current state", state: "done" },
        { key: "plan:1", label: "Implement projection", state: "active" },
        { key: "plan:2", label: "Deploy bridge", state: "pending" }
      ] }
    });
  });

  it("extracts update_plan from the JSONL exec wrapper used by TraeX", async () => {
    const { root, path } = await createTranscript();
    const cursor = await expectTyped(await new TraexTranscriptReader({ sessionsRoot: root }).open(session()));
    const input = 'const p = await tools.update_plan({explanation:"working",plan:[{step:"Inspect live state",status:"completed"},{step:"Deploy bridge",status:"in_progress"}]}); text(p);';
    await appendFile(path, mutation([{
      type: "function_call", id: "plan-wrapper", call_id: "plan-wrapper-call", name: "exec",
      arguments: JSON.stringify({ input })
    }]));

    await expect(cursor.readObservation?.()).resolves.toMatchObject({
      answerDelta: "", mainStatus: { planSteps: [
        { key: "plan:0", label: "Inspect live state", state: "done" },
        { key: "plan:1", label: "Deploy bridge", state: "active" }
      ] }
    });
  });

  it("reports per-turn token growth only when a baseline exists", async () => {
    const { root, path } = await createTranscript();
    await appendFile(path, eventMessage({ type: "token_count", info: { total_token_usage: { total_tokens: 10_000 } } }));
    const cursor = await expectTyped(await new TraexTranscriptReader({ sessionsRoot: root }).open(session()));
    await appendFile(path, eventMessage({ type: "token_count", info: { total_token_usage: { total_tokens: 12_345 } } }));

    await expect(cursor.readObservation?.()).resolves.toEqual({ answerDelta: "", mainStatus: { tokenCount: 2_345 } });
  });

  it("buffers partial records and emits complete appended items once", async () => {
    const { root, path } = await createTranscript();
    const cursor = await expectTyped(await new TraexTranscriptReader({ sessionsRoot: root }).open(session()));
    const first = mutation([{ type: "message", id: "msg-first", role: "assistant", content: [{ type: "output_text", text: "first" }] }]);
    const second = mutation([{ type: "message", id: "msg-second", role: "assistant", content: [{ type: "output_text", text: "second" }] }]);

    await appendFile(path, first + second.slice(0, -1));
    await expect(cursor.readDelta()).resolves.toBe("first");
    await expect(cursor.readDelta()).resolves.toBe("");
    await appendFile(path, "\n");
    await expect(cursor.readDelta()).resolves.toBe("second");
    await expect(cursor.readDelta()).resolves.toBe("");
  });

  it("quarantines one malformed complete record and reaches a later owned completion", async () => {
    const { root, path } = await createTranscript();
    const cursor = await expectTyped(await new TraexTranscriptReader({ sessionsRoot: root }).open(session()));
    const turnId = "01a04f35-8c1f-7913-8ac7-9642e7c6a614";
    await appendFile(path, [
      eventMessage({ type: "task_started", turn_id: turnId, started_at: 1_788_035_304 }),
      mutation([{ type: "message", id: "valid-before-malformed", role: "assistant", content: [{ type: "output_text", text: "Owned output" }] }])
    ].join(""));
    await expect(cursor.readObservation?.()).resolves.toMatchObject({ turnId, freshTurnStart: true, answerDelta: "Owned output" });

    await appendFile(path, `{"type":"event_msg",BROKEN}\n` + eventMessage({ type: "task_complete", turn_id: turnId, started_at: 1_788_035_304, completed_at: 1_788_035_318 }));
    await expect(cursor.readObservation?.()).resolves.toMatchObject({
      turnId, answerDelta: "", turnLifecycle: { turnId, state: "completed" }
    });
  });

  it("pairs cross-record tool results and suppresses duplicate or invalid identities", async () => {
    const { root, path } = await createTranscript();
    const cursor = await expectTyped(await new TraexTranscriptReader({ sessionsRoot: root }).open(session()));
    const call = { type: "function_call", id: "fc-1", call_id: "call-1", name: "exec", arguments: '{"input":"opaque orchestration"}' };

    await appendFile(path, mutation([
      call,
      call,
      { type: "function_call", id: "fc-empty-call", call_id: "", name: "ignored", arguments: "ignored arguments" },
      { type: "function_call", id: "fc-missing-call", name: "ignored", arguments: "ignored arguments" }
    ]));
    const callOutput = await cursor.readDelta();
    expect(callOutput).toBe("");
    expect(callOutput).not.toContain("opaque orchestration");
    expect(callOutput).not.toContain("ignored arguments");

    const result = { type: "function_call_output", id: "fco-1", call_id: "call-1", output: [{ type: "input_text", text: "fixture output" }] };
    await appendFile(path, mutation([
      { type: "function_call_output", id: "fco-unmatched", call_id: "call-unknown", output: "unmatched output" },
      { type: "function_call_output", id: "fco-empty-call", call_id: "", output: "malformed output" },
      { type: "function_call_output", id: "fco-missing-call", output: "missing identity output" },
      result,
      result
    ]));
    const resultOutput = await cursor.readDelta();
    expect(resultOutput).toBe("");
    expect(resultOutput).not.toContain("fixture output");
    expect(resultOutput).not.toMatch(/unmatched output|malformed output|missing identity output/);
    await expect(cursor.readDelta()).resolves.toBe("");
  });

  it("emits structured tool activity as a call moves from active to done", async () => {
    const { root, path } = await createTranscript();
    const cursor = await expectTyped(await new TraexTranscriptReader({ sessionsRoot: root }).open(session()));
    await appendFile(path, mutation([{
      type: "function_call", id: "fc-test", call_id: "call-test", name: "exec_command",
      arguments: JSON.stringify({ cmd: "npm test" })
    }]));

    await expect(cursor.readObservation?.()).resolves.toEqual({
      answerDelta: "",
      toolActivities: [{ key: "tool:call-test", kind: "test", label: "Command · npm test", state: "active" }]
    });

    await appendFile(path, mutation([{
      type: "function_call_output", id: "fco-test", call_id: "call-test",
      output: JSON.stringify({ exit_code: 0, output: "Test Files 2 passed\nTests 8 passed" })
    }]));

    await expect(cursor.readObservation?.()).resolves.toEqual({
      answerDelta: "◆ **Ran**\n\n```bash\nnpm test\n```\n\n```text\nTest Files 2 passed\nTests 8 passed\n```",
      toolActivities: [{ key: "tool:call-test", kind: "test", label: "Command · npm test", state: "done" }]
    });
  });

  it("uses the sanitized task-jz33 history_mutation records as typed input", async () => {
    const { root, path } = await createTranscript();
    const cursor = await expectTyped(await new TraexTranscriptReader({ sessionsRoot: root }).open(session()));
    const fixtureRecords = (await readFile(fixture, "utf8")).trimEnd().split("\n").slice(1).join("\n") + "\n";

    await appendFile(path, fixtureRecords);
    const output = await cursor.readDelta();
    expect(output).toContain("Typed answer");
    expect(output).not.toContain("▶ Command");
    expect(output).not.toContain("Command · command");
    expect(output).not.toMatch(/opaque orchestration|fixture output/);
  });

  it("renders non-exec tool arguments as a compact activity", async () => {
    const { root, path } = await createTranscript();
    const cursor = await expectTyped(await new TraexTranscriptReader({ sessionsRoot: root }).open(session()));
    await appendFile(path, mutation([{ type: "function_call", id: "fc-json", call_id: "call-json", name: "read_file", arguments: '{"path":"src/main.ts","line":42}' }]));

    await expect(cursor.readDelta()).resolves.toBe("");
  });

  it("summarizes a skill load and suppresses its paired document output", async () => {
    const { root, path } = await createTranscript();
    const cursor = await expectTyped(await new TraexTranscriptReader({ sessionsRoot: root }).open(session()));
    await appendFile(path, mutation([{
      type: "function_call", id: "fc-skill", call_id: "call-skill", name: "exec",
      arguments: JSON.stringify({ input: "const r = await tools.exec_command({cmd: \"sed -n '1,240p' /data00/home/alice/.trae/skills/brainstorming/SKILL.md\"}); text(r.output)" })
    }]));

    await expect(cursor.readDelta()).resolves.toBe("");

    await appendFile(path, mutation([{
      type: "function_call_output", id: "fco-skill", call_id: "call-skill",
      output: "---\nname: brainstorming\n---\n# Full private skill instructions"
    }]));
    await expect(cursor.readDelta()).resolves.toBe("✓ Skill · brainstorming");
  });

  it("summarizes distinct trusted skill paths in source order", async () => {
    const { root, path } = await createTranscript();
    const cursor = await expectTyped(await new TraexTranscriptReader({ sessionsRoot: root }).open(session()));
    await appendFile(path, mutation([{
      type: "function_call", id: "fc-skills", call_id: "call-skills", name: "read_files",
      arguments: JSON.stringify({ paths: [
        "/data00/home/alice/.agents/skills/test/SKILL.md",
        "/data00/home/alice/.trae/plugins/cache/package/1.0.0/skills/plugin-guide/SKILL.md",
        "/data00/home/alice/.agents/skills/test/SKILL.md"
      ] })
    }]));

    await expect(cursor.readDelta()).resolves.toBe("");
  });

  it("does not treat untrusted or relative SKILL.md references as skill loads", async () => {
    const { root, path } = await createTranscript();
    const cursor = await expectTyped(await new TraexTranscriptReader({ sessionsRoot: root }).open(session()));
    await appendFile(path, mutation([
      { type: "function_call", id: "fc-relative", call_id: "call-relative", name: "read_file", arguments: JSON.stringify({ path: "docs/SKILL.md" }) },
      { type: "function_call_output", id: "fco-relative", call_id: "call-relative", output: "ordinary SKILL.md contents" },
      { type: "function_call", id: "fc-temp", call_id: "call-temp", name: "read_file", arguments: JSON.stringify({ path: "/tmp/demo/SKILL.md" }) },
      { type: "function_call_output", id: "fco-temp", call_id: "call-temp", output: "temporary SKILL.md contents" },
      { type: "message", id: "assistant-skill-prose", role: "assistant", content: [{ type: "output_text", text: "The file is named SKILL.md." }] }
    ]));

    const output = await cursor.readDelta();
    expect(output).not.toContain("✓ Skill ·");
    expect(output).toContain("✓ Read · docs/SKILL.md");
    expect(output).toContain("✓ Read · /tmp/demo/SKILL.md");
    expect(output).not.toContain("ordinary SKILL.md contents");
    expect(output).not.toContain("temporary SKILL.md contents");
    expect(output).toContain("The file is named SKILL.md.");
  });

  it.each(["command", "cmd"])("renders an explicit exec.%s value as a compact command", async (field) => {
    const { root, path } = await createTranscript();
    const cursor = await expectTyped(await new TraexTranscriptReader({ sessionsRoot: root }).open(session()));
    await appendFile(path, mutation([{ type: "function_call", id: "fc-" + field, call_id: "call-" + field, name: "exec", arguments: JSON.stringify({ [field]: "npm test" }) }]));

    await expect(cursor.readDelta()).resolves.toBe("");
    await appendFile(path, mutation([{ type: "function_call_output", id: "fco-" + field, call_id: "call-" + field, output: "Script completed" }]));
    await expect(cursor.readDelta()).resolves.toBe("◆ **Ran**\n\n```bash\nnpm test\n```");
  });

  it("renders a wrapped command and JSON result as fenced Answer Card Markdown", async () => {
    const { root, path } = await createTranscript();
    const cursor = await expectTyped(await new TraexTranscriptReader({ sessionsRoot: root }).open(session()));
    await appendFile(path, mutation([{
      type: "function_call", id: "fc-wrapper", call_id: "call-wrapper", name: "exec",
      arguments: JSON.stringify({ input: 'const r = await tools.exec_command({cmd: "npm test"}); text(r.output);' })
    }]));
    await expect(cursor.readDelta()).resolves.toBe("");

    await appendFile(path, mutation([{
      type: "function_call_output", id: "fco-wrapper", call_id: "call-wrapper",
      output: JSON.stringify({ exit_code: 0, output: "Test Files 1 passed\nTests 2 passed" })
    }]));
    await expect(cursor.readDelta()).resolves.toBe([
      "◆ **Ran**", "", "```bash", "npm test", "```", "", "```text",
      "Test Files 1 passed", "Tests 2 passed", "```"
    ].join("\n"));
  });

  it("renders repeated internal wait checkpoints without exposing output", async () => {
    const { root, path } = await createTranscript();
    const cursor = await expectTyped(await new TraexTranscriptReader({ sessionsRoot: root }).open(session()));
    await appendFile(path, mutation([{ type: "function_call", id: "fc-running", call_id: "call-running", name: "write_stdin", arguments: JSON.stringify({ session_id: 263 }) }]));
    await expect(cursor.readDelta()).resolves.toBe("");

    await appendFile(path, mutation([{ type: "function_call_output", id: "fco-running", call_id: "call-running", output: JSON.stringify({ session_id: 263, output: "private partial output" }) }]));
    await expect(cursor.readDelta()).resolves.toBe("… 等待命令完成 · session 263");

    await appendFile(path, mutation([{ type: "function_call_output", id: "fco-complete", call_id: "call-running", output: JSON.stringify({ exit_code: 0, output: "private final output" }) }]));
    await expect(cursor.readDelta()).resolves.toBe("✓ 等待完成 · session 263");
  });

  it("redacts secrets and bounds rendered typed deltas", async () => {
    const { root, path } = await createTranscript();
    const cursor = await expectTyped(await new TraexTranscriptReader({ sessionsRoot: root, maxRenderedDeltaChars: 240 }).open(session()));
    await appendFile(path, mutation([{
      type: "message",
      id: "secret-message",
      role: "assistant",
      content: [{ type: "output_text", text: `Authorization: Bearer top-secret\nTOKEN=plain-secret\n${"x".repeat(500)}` }]
    }]));

    const output = await cursor.readDelta();
    expect(output).not.toMatch(/top-secret|plain-secret/);
    expect(output).toContain("[REDACTED]");
    expect(output.length).toBeLessThanOrEqual(240);
  });

  it("redacts colon assignments and equals-form authorization in typed deltas", async () => {
    const { root, path } = await createTranscript();
    const cursor = await expectTyped(await new TraexTranscriptReader({ sessionsRoot: root }).open(session()));
    await appendFile(path, mutation([{
      type: "message",
      id: "assignment-secrets",
      role: "assistant",
      content: [{ type: "output_text", text: [
        "TOKEN: token-value",
        "password: password-value",
        "api_key: api-value",
        "client_secret: client-value",
        "Authorization=Basic basic-value",
        "Authorization=Bearer bearer-value"
      ].join("\n") }]
    }]));

    const output = await cursor.readDelta();
    expect(output).toBe([
      "TOKEN: [REDACTED]",
      "password: [REDACTED]",
      "api_key: [REDACTED]",
      "client_secret: [REDACTED]",
      "Authorization=Basic [REDACTED]",
      "Authorization=Bearer [REDACTED]"
    ].join("\n"));
    expect(output).not.toMatch(/token-value|password-value|api-value|client-value|basic-value|bearer-value/);
  });

  it("returns missing_session_identity when Herdr has no native session", async () => {
    const root = await createRoot();
    const reader = new TraexTranscriptReader({ sessionsRoot: root });

    await expect(reader.open(null)).resolves.toEqual({ mode: "unavailable", reason: "missing_session_identity" });
    await expect(reader.open(undefined)).resolves.toEqual({ mode: "unavailable", reason: "missing_session_identity" });
  });

  it.each([
    ["a non-TraeX agent", { agent: "other" }],
    ["a path identity", { kind: "path" as const }],
    ["a malformed ID", { value: "latest" }]
  ])("returns unsupported_session_identity for %s", async (_label, overrides) => {
    const root = await createRoot();

    await expect(new TraexTranscriptReader({ sessionsRoot: root }).open(session(overrides))).resolves.toEqual({
      mode: "unavailable",
      reason: "unsupported_session_identity"
    });
  });

  it("returns transcript_not_found when no filename matches", async () => {
    const root = await createRoot();

    await expect(new TraexTranscriptReader({ sessionsRoot: root }).open(session())).resolves.toEqual({
      mode: "unavailable",
      reason: "transcript_not_found"
    });
  });

  it("returns ambiguous_transcript when multiple filenames match", async () => {
    const { root, path } = await createTranscript();
    const duplicate = join(root, "duplicate", `rollout-copy-${sessionId}.jsonl`);
    await mkdir(dirname(duplicate), { recursive: true });
    await cp(path, duplicate);

    await expect(new TraexTranscriptReader({ sessionsRoot: root }).open(session())).resolves.toEqual({
      mode: "unavailable",
      reason: "ambiguous_transcript"
    });
  });

  it("reuses a validated cached path without rescanning unrelated directories", async () => {
    const { root } = await createTranscript();
    const reader = new TraexTranscriptReader({ sessionsRoot: root });
    await expect(reader.open(session())).resolves.toMatchObject({ mode: "typed" });
    const blocked = join(root, "blocked");
    await mkdir(blocked);
    await chmod(blocked, 0o000);

    await expect(reader.open(session())).resolves.toMatchObject({ mode: "typed" });

    await chmod(blocked, 0o700);
  });

  it("evicts a missing cached path and discovers its replacement", async () => {
    const { root, path } = await createTranscript();
    const reader = new TraexTranscriptReader({ sessionsRoot: root });
    await expect(reader.open(session())).resolves.toMatchObject({ mode: "typed" });
    const replacement = join(root, "replacement", `rollout-replacement-${sessionId}.jsonl`);
    await mkdir(dirname(replacement), { recursive: true });
    await rename(path, replacement);

    await expect(reader.open(session())).resolves.toMatchObject({ mode: "typed" });
  });

  it("stops discovery globally after the second exact match", async () => {
    const root = await createRoot();
    for (const name of ["first", "second"]) {
      await writeFile(join(root, `${name}-${sessionId}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id: sessionId } })}\n`);
    }
    await mkdir(join(root, "unvisited"));
    await writeFile(join(root, "unvisited", "extra-entry"), "ignored");

    await expect(new TraexTranscriptReader({ sessionsRoot: root, maxDiscoveryEntries: 2 }).open(session())).resolves.toEqual({
      mode: "unavailable", reason: "ambiguous_transcript"
    });
  });

  it("reports unavailable when transcript discovery exhausts its entry budget", async () => {
    const { root } = await createTranscript();
    await writeFile(join(root, "unrelated"), "ignored");

    await expect(new TraexTranscriptReader({ sessionsRoot: root, maxDiscoveryEntries: 1 }).open(session())).resolves.toEqual({
      mode: "unavailable", reason: "transcript_validation_failed"
    });
  });

  it.each([
    ["mismatched", { type: "session_meta", payload: { id: "11a03eb1-c193-7531-83c0-e6c6f70143d4" } }],
    ["malformed", { type: "session_meta", payload: { id: 42 } }]
  ])("returns transcript_validation_failed for %s session metadata", async (_label, metadata) => {
    const { root } = await createTranscript({ metadata });

    await expect(new TraexTranscriptReader({ sessionsRoot: root }).open(session())).resolves.toEqual({
      mode: "unavailable",
      reason: "transcript_validation_failed"
    });
  });

  it("validates a session metadata record larger than the scan chunk", async () => {
    const { root } = await createTranscript({ metadata: { type: "session_meta", payload: { id: sessionId, context: "x".repeat(300_000) } } });

    await expect(new TraexTranscriptReader({ sessionsRoot: root }).open(session())).resolves.toMatchObject({ mode: "typed" });
  });
});

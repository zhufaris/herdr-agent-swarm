import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TraexPromptTranscriptReader } from "../src/runtime/traex-prompt-settlement.js";

const roots: string[] = [];
const sessionId = "01a06b5e-2a25-7c53-b12e-ed02181a4e0e";
const turnId = "01a06b5e-2a25-7c53-b12e-ed02181a4e0f";
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("TraeX prompt settlement transcript", () => {
  it("opens at EOF and observes only a later complete turn", async () => {
    const { root, path } = await fixture();
    const opened = await new TraexPromptTranscriptReader(root).open(session());
    expect(opened.mode).toBe("typed");
    if (opened.mode !== "typed") return;
    await appendFile(path, event({ type: "task_started", turn_id: turnId, started_at: 1_788_537_600 }) + event({ type: "task_complete", turn_id: turnId, started_at: 1_788_537_600 }));
    await expect(opened.cursor.readObservation?.()).resolves.toMatchObject({ turnId, freshTurnStart: true, turnLifecycle: { state: "completed", startedAt: "2026-09-04T16:00:00.000Z" } });
  });

  it("keeps a turn active until its matching completion arrives", async () => {
    const { root, path } = await fixture();
    const opened = await new TraexPromptTranscriptReader(root).open(session());
    if (opened.mode !== "typed") throw new Error("expected typed cursor");
    await appendFile(path, event({ type: "task_started", turn_id: turnId, started_at: 1_788_537_600 }));
    await expect(opened.cursor.readObservation?.()).resolves.toMatchObject({ freshTurnStart: true, turnLifecycle: { state: "active" } });
    await appendFile(path, event({ type: "task_complete", turn_id: turnId, started_at: 1_788_537_600 }));
    await expect(opened.cursor.readObservation?.()).resolves.toMatchObject({ turnLifecycle: { state: "completed" } });
  });

  it("fails closed for ambiguous or mismatched sessions", async () => {
    const { root } = await fixture();
    await writeFile(join(root, `duplicate-${sessionId}.jsonl`), meta(sessionId));
    await expect(new TraexPromptTranscriptReader(root).open(session())).resolves.toEqual({ mode: "unavailable", reason: "ambiguous_transcript" });
    await expect(new TraexPromptTranscriptReader(root).open({ ...session(), value: turnId })).resolves.toEqual({ mode: "unavailable", reason: "transcript_not_found" });
  });

  it("returns adjacent turns in separate observations", async () => {
    const { root, path } = await fixture();
    const opened = await new TraexPromptTranscriptReader(root).open(session());
    if (opened.mode !== "typed") throw new Error("expected typed cursor");
    const turnB = "01a06b5e-2a25-7c53-b12e-ed02181a4e10";
    await appendFile(path, event({ type: "task_started", turn_id: turnId, started_at: 1_788_537_600 }) + event({ type: "task_complete", turn_id: turnId, started_at: 1_788_537_600 }) + event({ type: "task_started", turn_id: turnB, started_at: 1_788_537_601 }));
    await expect(opened.cursor.readObservation?.()).resolves.toMatchObject({ turnId, freshTurnStart: true, turnLifecycle: { state: "completed" } });
    await expect(opened.cursor.readObservation?.()).resolves.toMatchObject({ turnId: turnB, freshTurnStart: true, turnLifecycle: { state: "active" } });
  });

  it("recognizes a 0.202 history mutation only when its user text matches the dispatched prompt", async () => {
    const { root, path } = await fixture();
    const reader = new TraexPromptTranscriptReader(root);
    const opened = await reader.open(session(), "Reply exactly");
    if (opened.mode !== "typed") throw new Error("expected typed cursor");
    await appendFile(path, mutation(turnId, "Reply exactly") + event({ type: "task_complete", turn_id: turnId, started_at: 1_788_537_600 }));
    await expect(opened.cursor.readObservation?.()).resolves.toMatchObject({ turnId, freshTurnStart: true, turnLifecycle: { state: "completed" } });

    const mismatched = await reader.open(session(), "Different prompt");
    if (mismatched.mode !== "typed") throw new Error("expected typed cursor");
    await appendFile(path, mutation("01a06b5e-2a25-7c53-b12e-ed02181a4e11", "Not the dispatched prompt"));
    await expect(mismatched.cursor.readObservation?.()).resolves.toEqual({ answerDelta: "" });
  });

  it("keeps unrelated records with the following turn and exposes an adjacent turn through unrelated records", async () => {
    const { root, path } = await fixture();
    const opened = await new TraexPromptTranscriptReader(root).open(session());
    if (opened.mode !== "typed") throw new Error("expected typed cursor");
    const turnB = "01a06b5e-2a25-7c53-b12e-ed02181a4e10";
    await appendFile(path, unrelated() + event({ type: "task_started", turn_id: turnId, started_at: 1_788_537_600 }) + event({ type: "task_complete", turn_id: turnId, started_at: 1_788_537_600 }) + unrelated() + event({ type: "task_started", turn_id: turnB, started_at: 1_788_537_601 }));
    await expect(opened.cursor.readObservation?.()).resolves.toMatchObject({ turnId, freshTurnStart: true, turnLifecycle: { state: "completed" } });
    await expect(opened.cursor.readObservation?.()).resolves.toMatchObject({ turnId: turnB, freshTurnStart: true, turnLifecycle: { state: "active" } });
  });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "traex-prompt-settlement-")); roots.push(root);
  await mkdir(join(root, "nested"));
  const path = join(root, "nested", `rollout-${sessionId}.jsonl`);
  await writeFile(path, meta(sessionId) + event({ type: "task_started", turn_id: "01a06b5e-2a25-7c53-b12e-ed02181a4e00", started_at: 1_788_537_500 }));
  return { root, path };
}
function session() { return { source: "herdr-traex-shim", agent: "traex", kind: "id" as const, value: sessionId }; }
function meta(id: string) { return `${JSON.stringify({ type: "session_meta", payload: { id } })}\n`; }
function event(payload: object) { return `${JSON.stringify({ type: "event_msg", payload })}\n`; }
function unrelated() { return `${JSON.stringify({ type: "event_msg", payload: { type: "token_count" } })}\n`; }
function mutation(id: string, text: string) {
  return `${JSON.stringify({
    timestamp: "2026-09-04T16:00:00.100Z", type: "history_mutation",
    payload: { operation: "append", turn_id: id, items: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }] }
  })}\n`;
}

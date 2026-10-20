import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentTranscriptSource } from "../src/domain/ports.js";
import { piTranscriptDescriptor } from "../src/runtime/agents/pi-transcript-identity.js";
import { PiTranscriptReader } from "../src/runtime/pi-transcript.js";

const roots: string[] = [];
const source: AgentTranscriptSource = { agentKind: "pi", bindingId: "binding-1", generation: 2, nativeSession: null };
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-transcript-")); roots.push(root);
  const descriptor = piTranscriptDescriptor(root, source.bindingId, source.generation);
  await mkdir(descriptor.sessionDir, { recursive: true });
  const path = join(descriptor.sessionDir, `2026-09-25T00-00-00-000Z_${descriptor.sessionId}.jsonl`);
  await writeFile(path, `${JSON.stringify({ type: "session", version: 3, id: descriptor.sessionId, timestamp: "2026-09-25T00:00:00.000Z", cwd: "/work" })}\n`);
  return { root, path, descriptor };
}
function message(id: string, parentId: string | null, timestamp: string, value: unknown) { return `${JSON.stringify({ type: "message", id, parentId, timestamp, message: value })}\n`; }

describe("PiTranscriptReader", () => {
  it("resolves the exact transcript descriptor used by Core registration", async () => {
    const { root, path, descriptor } = await fixture();

    await expect(new PiTranscriptReader({ root }).resolveTranscriptDescriptor(source)).resolves.toEqual({
      sessionId: descriptor.sessionId,
      path
    });
  });

  it("waits on the deterministic path before Pi creates its session file", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-transcript-")); roots.push(root);
    const cursor = await new PiTranscriptReader({ root }).open(source);
    expect(cursor.mode).toBe("typed");
    if (cursor.mode !== "typed") return;
    await expect(cursor.cursor.readObservation?.()).resolves.toEqual({ answerDelta: "" });
  });

  it("projects a user turn, ignores thinking, survives tools, and completes with final text", async () => {
    const { root, path } = await fixture();
    const reader = new PiTranscriptReader({ root });
    const opened = await reader.open(source);
    expect(opened.mode).toBe("typed"); if (opened.mode !== "typed") return;
    await appendFile(path, [
      message("user-1", null, "2026-09-25T00:00:01.000Z", { role: "user", content: [{ type: "text", text: "analyze" }], timestamp: 1 }),
      message("assistant-tool", "user-1", "2026-09-25T00:00:02.000Z", { role: "assistant", content: [{ type: "thinking", thinking: "secret reasoning" }, { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/main.ts" } }], stopReason: "toolUse", usage: { totalTokens: 10 }, timestamp: 2 }),
      message("result-1", "assistant-tool", "2026-09-25T00:00:03.000Z", { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "contents" }], isError: false, timestamp: 3 }),
      message("assistant-final", "result-1", "2026-09-25T00:00:04.000Z", { role: "assistant", content: [{ type: "text", text: "final answer" }], stopReason: "stop", usage: { totalTokens: 20 }, timestamp: 4 })
    ].join(""));
    await expect(opened.cursor.readObservation?.()).resolves.toMatchObject({ turnId: "user-1", freshTurnStart: true, requestText: "analyze", turnLifecycle: { state: "active" } });
    const tool = await opened.cursor.readObservation?.(); expect(tool).toMatchObject({ turnId: "user-1", answerDelta: "", mainStatus: { tokenCount: 10 }, toolActivities: [{ key: "tool:call-1", kind: "read", state: "active" }] }); expect(JSON.stringify(tool)).not.toContain("secret reasoning");
    await expect(opened.cursor.readObservation?.()).resolves.toMatchObject({ toolActivities: [{ key: "tool:call-1", state: "done" }] });
    await expect(opened.cursor.readObservation?.()).resolves.toMatchObject({ answerDelta: "final answer", turnLifecycle: { state: "completed", finalAnswer: "final answer" }, mainStatus: { tokenCount: 20 } });
  });

  it("reopens one exact completed turn and ignores an incomplete trailing record", async () => {
    const { root, path } = await fixture();
    await appendFile(path, message("user-1", null, "2026-09-25T00:00:01.000Z", { role: "user", content: [{ type: "text", text: "request" }] }) + message("assistant-1", "user-1", "2026-09-25T00:00:02.000Z", { role: "assistant", content: [{ type: "text", text: "answer" }], stopReason: "stop" }) + '{"type":');
    const opened = await new PiTranscriptReader({ root }).openAtTurn(source, "user-1", "2026-09-25T00:00:01.000Z");
    expect(opened.mode).toBe("typed"); if (opened.mode !== "typed") return;
    await expect(opened.cursor.readObservation?.()).resolves.toMatchObject({ freshTurnStart: true });
    await expect(opened.cursor.readObservation?.()).resolves.toMatchObject({ turnLifecycle: { state: "completed", finalAnswer: "answer" } });
  });

  it("rejects a mismatched session header", async () => {
    const { root, path } = await fixture();
    await writeFile(path, `${JSON.stringify({ type: "session", id: "00000000-0000-4000-a000-000000000000", timestamp: "2026-09-25T00:00:00.000Z", cwd: "/work" })}\n`);
    await expect(new PiTranscriptReader({ root }).openFirstTurn(source)).resolves.toEqual({ mode: "unavailable", reason: "transcript_validation_failed" });
  });
});

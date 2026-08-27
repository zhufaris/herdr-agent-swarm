import { appendFile, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { TraexTranscriptReader } from "../src/runtime/traex-transcript.js";

const sessionId = "01a03eb1-c193-7531-83c0-e6c6f70143d4";
const fixture = fileURLToPath(new URL("./fixtures/task-jz33-transcript.jsonl", import.meta.url));
const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createTranscript(id = sessionId): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "traex-transcript-"));
  roots.push(root);
  const path = join(root, "2026", "08", "26", `rollout-2026-08-26T15-30-31-${id}.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  if (id === sessionId) await cp(fixture, path);
  else await writeFile(path, `${JSON.stringify({ type: "session_meta", payload: { id } })}\n`);
  return { root, path };
}

function event(payload: object): string {
  return `${JSON.stringify({ timestamp: "2026-08-26T16:00:00.000Z", type: "event_msg", payload })}\n`;
}

describe("TraexTranscriptReader", () => {
  it("opens only one exact UUID transcript whose session metadata agrees", async () => {
    const { root, path } = await createTranscript();
    const reader = new TraexTranscriptReader({ sessionsRoot: root });

    await expect(reader.open({ source: "herdr-lark-bridge:traex", agent: "traex", kind: "id", value: sessionId })).resolves.not.toBeNull();
    await expect(reader.open({ source: "herdr-lark-bridge:traex", agent: "traex", kind: "path", value: path })).resolves.toBeNull();
    await expect(reader.open({ source: "herdr-lark-bridge:traex", agent: "traex", kind: "id", value: "latest" })).resolves.toBeNull();

    const duplicate = join(root, "duplicate", `rollout-copy-${sessionId}.jsonl`);
    await mkdir(dirname(duplicate), { recursive: true });
    await cp(path, duplicate);
    await expect(reader.open({ source: "herdr-lark-bridge:traex", agent: "traex", kind: "id", value: sessionId })).resolves.toBeNull();
  });

  it("rejects a filename match whose session metadata has a different identity", async () => {
    const { root, path } = await createTranscript();
    await writeFile(path, `${JSON.stringify({ type: "session_meta", payload: { id: "11a03eb1-c193-7531-83c0-e6c6f70143d4" } })}\n`);
    await expect(new TraexTranscriptReader({ sessionsRoot: root }).open({ source: "bridge", agent: "traex", kind: "id", value: sessionId })).resolves.toBeNull();
  });

  it("starts at EOF and emits complete appended records once", async () => {
    const { root, path } = await createTranscript();
    const cursor = await new TraexTranscriptReader({ sessionsRoot: root }).open({ source: "bridge", agent: "traex", kind: "id", value: sessionId });
    expect(cursor).not.toBeNull();
    await expect(cursor!.readDelta()).resolves.toBe("");

    const complete = event({ type: "agent_message", message: "**Typed** answer", phase: "commentary" });
    const partial = event({ type: "agent_message", message: "second record", phase: "final_answer" });
    await appendFile(path, complete + partial.slice(0, -1));
    await expect(cursor!.readDelta()).resolves.toBe("**Typed** answer");
    await expect(cursor!.readDelta()).resolves.toBe("");
    await appendFile(path, "\n");
    await expect(cursor!.readDelta()).resolves.toBe("second record");
    await expect(cursor!.readDelta()).resolves.toBe("");
  });

  it("renders explicit command, output, and patch fields without interpreting exec JavaScript", async () => {
    const { root, path } = await createTranscript();
    const cursor = await new TraexTranscriptReader({ sessionsRoot: root }).open({ source: "bridge", agent: "traex", kind: "id", value: sessionId });
    await appendFile(path, [
      event({ type: "exec_command_end", call_id: "call-1", command: ["/bin/bash", "-lc", "git diff -- src/main.ts"], stdout: "one\ntwo\n", stderr: "warning\n", exit_code: 0, status: "completed" }),
      event({ type: "patch_apply_end", call_id: "call-2", success: true, stdout: "Success", stderr: "", changes: { "src/main.ts": { type: "update", unified_diff: "@@ -1 +1 @@\n-old\n+new", move_path: null } } }),
      `${JSON.stringify({ type: "history_mutation", payload: { items: [{ type: "function_call", name: "exec", arguments: "echo must-not-render" }] } })}\n`,
      event({ type: "reasoning", text: "private chain of thought" }),
      event({ type: "future_event", command: ["rm", "-rf", "/"] })
    ].join(""));

    const output = await cursor!.readDelta();
    expect(output).toContain("```bash\ngit diff -- src/main.ts\n```");
    expect(output).toContain("```text\none\ntwo\n```");
    expect(output).toContain("```text\nwarning\n```");
    expect(output).toContain("```diff\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-old\n+new\n```");
    expect(output).not.toMatch(/must-not-render|chain of thought|rm -rf/);
  });

  it("redacts secrets and bounds rendered deltas", async () => {
    const { root, path } = await createTranscript();
    const cursor = await new TraexTranscriptReader({ sessionsRoot: root, maxRenderedDeltaChars: 240 }).open({ source: "bridge", agent: "traex", kind: "id", value: sessionId });
    await appendFile(path, event({ type: "exec_command_end", call_id: "secret", command: ["curl", "-H", "Authorization: Bearer top-secret", "https://x.test?access_token=query-secret"], stdout: `TOKEN=plain-secret\n${"x".repeat(500)}`, stderr: "", exit_code: 0 }));

    const output = await cursor!.readDelta();
    expect(output).not.toMatch(/top-secret|query-secret|plain-secret/);
    expect(output).toContain("[REDACTED]");
    expect(output.length).toBeLessThanOrEqual(240);
  });

  it("uses the sanitized task-jz33 fixture without exposing its historical exec arguments", async () => {
    const { root, path } = await createTranscript();
    const cursor = await new TraexTranscriptReader({ sessionsRoot: root }).open({ source: "bridge", agent: "traex", kind: "id", value: sessionId });
    const baseline = await readFile(path, "utf8");
    expect(baseline).toContain("must-not-render");
    await appendFile(path, event({ type: "agent_message", message: "fixture continuation", phase: "commentary" }));
    await expect(cursor!.readDelta()).resolves.toBe("fixture continuation");
  });
});

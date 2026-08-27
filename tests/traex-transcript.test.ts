import { appendFile, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  return { source: "herdr-lark-bridge:traex", agent: "traex", kind: "id", value: sessionId, ...overrides };
}

function mutation(items: unknown[], operation = "append"): string {
  return `${JSON.stringify({ type: "history_mutation", payload: { operation, items } })}\n`;
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
    expect(resultOutput).toBe("✓ Command · `command`");
    expect(resultOutput).not.toContain("fixture output");
    expect(resultOutput).not.toMatch(/unmatched output|malformed output|missing identity output/);
    await expect(cursor.readDelta()).resolves.toBe("");
  });

  it("uses the sanitized task-jz33 history_mutation records as typed input", async () => {
    const { root, path } = await createTranscript();
    const cursor = await expectTyped(await new TraexTranscriptReader({ sessionsRoot: root }).open(session()));
    const fixtureRecords = (await readFile(fixture, "utf8")).trimEnd().split("\n").slice(1).join("\n") + "\n";

    await appendFile(path, fixtureRecords);
    const output = await cursor.readDelta();
    expect(output).toContain("Typed answer");
    expect(output).not.toContain("▶ Command");
    expect(output).toContain("✓ Command · `command`");
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
    await expect(cursor.readDelta()).resolves.toBe("✓ Command · `npm test`");
  });

  it("appends a terminal result after a running result for the same call", async () => {
    const { root, path } = await createTranscript();
    const cursor = await expectTyped(await new TraexTranscriptReader({ sessionsRoot: root }).open(session()));
    await appendFile(path, mutation([{ type: "function_call", id: "fc-running", call_id: "call-running", name: "write_stdin", arguments: JSON.stringify({ session_id: 263 }) }]));
    await expect(cursor.readDelta()).resolves.toBe("");

    await appendFile(path, mutation([{ type: "function_call_output", id: "fco-running", call_id: "call-running", output: JSON.stringify({ session_id: 263, output: "private partial output" }) }]));
    await expect(cursor.readDelta()).resolves.toBe("… Wait · session 263 · 运行中");

    await appendFile(path, mutation([{ type: "function_call_output", id: "fco-complete", call_id: "call-running", output: JSON.stringify({ exit_code: 0, output: "private final output" }) }]));
    await expect(cursor.readDelta()).resolves.toBe("✓ Wait · session 263");
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

  it("returns missing_session_identity when Herdr has no native session", async () => {
    const root = await createRoot();
    const reader = new TraexTranscriptReader({ sessionsRoot: root });

    await expect(reader.open(null)).resolves.toEqual({ mode: "terminal", reason: "missing_session_identity" });
    await expect(reader.open(undefined)).resolves.toEqual({ mode: "terminal", reason: "missing_session_identity" });
  });

  it.each([
    ["a non-TraeX agent", { agent: "other" }],
    ["a path identity", { kind: "path" as const }],
    ["a malformed ID", { value: "latest" }]
  ])("returns unsupported_session_identity for %s", async (_label, overrides) => {
    const root = await createRoot();

    await expect(new TraexTranscriptReader({ sessionsRoot: root }).open(session(overrides))).resolves.toEqual({
      mode: "terminal",
      reason: "unsupported_session_identity"
    });
  });

  it("returns transcript_not_found when no filename matches", async () => {
    const root = await createRoot();

    await expect(new TraexTranscriptReader({ sessionsRoot: root }).open(session())).resolves.toEqual({
      mode: "terminal",
      reason: "transcript_not_found"
    });
  });

  it("returns ambiguous_transcript when multiple filenames match", async () => {
    const { root, path } = await createTranscript();
    const duplicate = join(root, "duplicate", `rollout-copy-${sessionId}.jsonl`);
    await mkdir(dirname(duplicate), { recursive: true });
    await cp(path, duplicate);

    await expect(new TraexTranscriptReader({ sessionsRoot: root }).open(session())).resolves.toEqual({
      mode: "terminal",
      reason: "ambiguous_transcript"
    });
  });

  it.each([
    ["mismatched", { type: "session_meta", payload: { id: "11a03eb1-c193-7531-83c0-e6c6f70143d4" } }],
    ["malformed", { type: "session_meta", payload: { id: 42 } }]
  ])("returns transcript_validation_failed for %s session metadata", async (_label, metadata) => {
    const { root } = await createTranscript({ metadata });

    await expect(new TraexTranscriptReader({ sessionsRoot: root }).open(session())).resolves.toEqual({
      mode: "terminal",
      reason: "transcript_validation_failed"
    });
  });

  it("validates a session metadata record larger than the scan chunk", async () => {
    const { root } = await createTranscript({ metadata: { type: "session_meta", payload: { id: sessionId, context: "x".repeat(300_000) } } });

    await expect(new TraexTranscriptReader({ sessionsRoot: root }).open(session())).resolves.toMatchObject({ mode: "typed" });
  });
});

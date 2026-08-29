import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HerdrAgentSession } from "../src/domain/types.js";
import { TraexTranscriptReader } from "../src/runtime/traex-transcript.js";

const sessionIds = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333"
];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Traex transcript path cache", () => {
  it("evicts the least recently used validated path", async () => {
    const root = await mkdtemp(join(tmpdir(), "traex-transcript-cache-"));
    roots.push(root);
    for (const id of sessionIds) await writeTranscript(root, "primary", id);
    const reader = new TraexTranscriptReader({ sessionsRoot: root, maxCachedPaths: 2 });

    await expect(reader.open(session(sessionIds[0]!))).resolves.toMatchObject({ mode: "typed" });
    await expect(reader.open(session(sessionIds[1]!))).resolves.toMatchObject({ mode: "typed" });
    await expect(reader.open(session(sessionIds[0]!))).resolves.toMatchObject({ mode: "typed" });
    await expect(reader.open(session(sessionIds[2]!))).resolves.toMatchObject({ mode: "typed" });
    await writeTranscript(root, "duplicate", sessionIds[0]!);
    await writeTranscript(root, "duplicate", sessionIds[1]!);

    await expect(reader.open(session(sessionIds[0]!))).resolves.toMatchObject({ mode: "typed" });
    await expect(reader.open(session(sessionIds[1]!))).resolves.toEqual({ mode: "unavailable", reason: "ambiguous_transcript" });
  });
});

function session(value: string): HerdrAgentSession {
  return { source: "herdr-lark-bridge:traex", agent: "traex", kind: "id", value };
}

async function writeTranscript(root: string, directory: string, id: string): Promise<void> {
  const path = join(root, directory, `rollout-${id}.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ type: "session_meta", payload: { id } })}\n`);
}

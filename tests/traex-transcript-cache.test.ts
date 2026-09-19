import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("caches a missing transcript briefly and discovers it after expiry", async () => {
    const root = await mkdtemp(join(tmpdir(), "traex-transcript-negative-")); roots.push(root);
    let now = 1_000;
    const discover = vi.fn(async () => ({ paths: [] as string[], exhausted: false }));
    const reader = new TraexTranscriptReader({ sessionsRoot: root, negativeCacheTtlMs: 100, now: () => now, discover });

    await expect(reader.open(session(sessionIds[0]!))).resolves.toEqual({ mode: "unavailable", reason: "transcript_not_found" });
    await expect(reader.open(session(sessionIds[0]!))).resolves.toEqual({ mode: "unavailable", reason: "transcript_not_found" });
    expect(discover).toHaveBeenCalledOnce();
    now += 101;
    await reader.open(session(sessionIds[0]!));
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent discovery for one session", async () => {
    const root = await mkdtemp(join(tmpdir(), "traex-transcript-inflight-")); roots.push(root);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const discover = vi.fn(async () => { await blocked; return { paths: [] as string[], exhausted: false }; });
    const reader = new TraexTranscriptReader({ sessionsRoot: root, discover });

    const first = reader.open(session(sessionIds[0]!));
    const second = reader.open(session(sessionIds[0]!));
    await vi.waitFor(() => expect(discover).toHaveBeenCalledOnce());
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { mode: "unavailable", reason: "transcript_not_found" },
      { mode: "unavailable", reason: "transcript_not_found" }
    ]);
  });

  it("coalesces concurrent default discovery across different sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "traex-transcript-shared-index-")); roots.push(root);
    for (const id of sessionIds.slice(0, 2)) await writeTranscript(root, "primary", id!);
    let scans = 0;
    const scan = vi.fn(async (sessionsRoot: string, maxEntries: number) => {
      scans += 1;
      const { scanTranscriptPaths } = await import("../src/runtime/traex-transcript.js");
      return scanTranscriptPaths(sessionsRoot, maxEntries);
    });
    const reader = new TraexTranscriptReader({ sessionsRoot: root, scan });

    await expect(Promise.all(sessionIds.slice(0, 2).map((id) => reader.open(session(id!))))).resolves.toEqual([
      expect.objectContaining({ mode: "typed" }),
      expect.objectContaining({ mode: "typed" })
    ]);
    expect(scans).toBe(1);
  });

  it("evicts the least recently used validated path", async () => {
    const root = await mkdtemp(join(tmpdir(), "traex-transcript-cache-"));
    roots.push(root);
    for (const id of sessionIds) await writeTranscript(root, "primary", id);
    const reader = new TraexTranscriptReader({ sessionsRoot: root, maxCachedPaths: 2, discoveryIndexTtlMs: 0 });

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
  return { source: "herdr-agent-swarm:traex", agent: "traex", kind: "id", value };
}

async function writeTranscript(root: string, directory: string, id: string): Promise<void> {
  const path = join(root, directory, `rollout-${id}.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ type: "session_meta", payload: { id } })}\n`);
}

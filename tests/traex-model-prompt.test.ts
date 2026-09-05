import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commitTraexModelPrompt, prepareTraexModelPrompt } from "../src/runtime/traex-model-prompt.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const peer = { threadId: "01a03eb1-c193-7531-83c0-e6c6f70143d4", socketPath: "/tmp/unused", pid: 42, startedAtMs: 1 };
const digest = createHash("sha256").update("hello").digest("hex");

describe("TraeX two-phase model prompt", () => {
  it("prepares without starting a turn and commits exactly once", async () => {
    const operationDir = await fixture();
    const callTurnStart = vi.fn(async () => "turn-1");
    const prepared = await prepareTraexModelPrompt({ peer, target: "primary", model: "GPT-5.4", revision: 3, promptSha256: digest }, { operationDir });
    expect(prepared).toMatchObject({ state: "prepared" });
    expect(callTurnStart).not.toHaveBeenCalled();

    await expect(commitTraexModelPrompt({ operationId: prepared.operationId, text: "hello", promptSha256: digest }, { operationDir, callTurnStart })).resolves.toMatchObject({ state: "accepted", turnId: "turn-1" });
    await expect(commitTraexModelPrompt({ operationId: prepared.operationId, text: "hello", promptSha256: digest }, { operationDir, callTurnStart })).resolves.toMatchObject({ state: "accepted", turnId: "turn-1" });
    expect(callTurnStart).toHaveBeenCalledOnce();
    expect(callTurnStart).toHaveBeenCalledWith(peer, "hello", "GPT-5.4", 10_000);
    expect(await readFile(join(operationDir, `${prepared.operationId}.json`), "utf8")).not.toContain("hello");
  });

  it("rejects a missing operation or mismatched prompt digest before dispatch", async () => {
    const operationDir = await fixture();
    const callTurnStart = vi.fn(async () => "turn-1");
    await expect(commitTraexModelPrompt({ operationId: "a".repeat(64), text: "hello", promptSha256: digest }, { operationDir, callTurnStart })).rejects.toThrow(/not found/i);
    const prepared = await prepareTraexModelPrompt({ peer, target: "primary", model: "GPT-5.4", revision: 3, promptSha256: digest }, { operationDir });
    await expect(commitTraexModelPrompt({ operationId: prepared.operationId, text: "changed", promptSha256: digest }, { operationDir, callTurnStart })).rejects.toThrow(/digest/i);
    expect(callTurnStart).not.toHaveBeenCalled();
  });

  it("makes a failed post-CAS dispatch uncertain and never retries it", async () => {
    const operationDir = await fixture();
    const callTurnStart = vi.fn(async () => { throw new Error("connection reset"); });
    const prepared = await prepareTraexModelPrompt({ peer, target: "primary", model: "GPT-5.4", revision: 3, promptSha256: digest }, { operationDir });
    await expect(commitTraexModelPrompt({ operationId: prepared.operationId, text: "hello", promptSha256: digest }, { operationDir, callTurnStart })).resolves.toMatchObject({ state: "uncertain" });
    await expect(commitTraexModelPrompt({ operationId: prepared.operationId, text: "hello", promptSha256: digest }, { operationDir, callTurnStart })).resolves.toMatchObject({ state: "uncertain" });
    expect(callTurnStart).toHaveBeenCalledOnce();
  });
});

async function fixture(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "traex-model-prompt-")); roots.push(root); return root; }

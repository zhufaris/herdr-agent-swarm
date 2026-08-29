import { constants } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTraexSessionPeer } from "../src/runtime/traex-session-peer.js";

const roots: string[] = [];
const correlationId = "4dd3d4d7-c92b-4ce0-aa1f-179cd703b5c6";
const threadId = "01a04f1e-f789-77d2-aa08-7dd693650157";

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("TraeX session peer resolution", () => {
  it("has no third-party runtime dependency in the standalone shim release", async () => {
    const source = await readFile(join(process.cwd(), "src/runtime/traex-session-peer.ts"), "utf8");
    expect(source).not.toMatch(/from ["'](?!node:|\.)/);
  });

  it("resolves the canonical thread ID from an exact PID and thread-name match", async () => {
    const root = await fixture();
    await peer(root, threadId, { protocolVersion: 1, threadName: correlationId, threadId, location: "local", socketPath: "/tmp/peer.sock", pid: 44, startedAtMs: 10 });
    await expect(resolveTraexSessionPeer(root, 44, correlationId)).resolves.toEqual({ status: "resolved", threadId });
  });

  it.each([
    ["malformed", "not json"],
    ["wrong protocol", JSON.stringify({ protocolVersion: 2, threadName: correlationId, threadId, location: "local", pid: 44 })],
    ["remote", JSON.stringify({ protocolVersion: 1, threadName: correlationId, threadId, location: "remote", pid: 44 })],
    ["wrong pid", JSON.stringify({ protocolVersion: 1, threadName: correlationId, threadId, location: "local", pid: 45 })],
    ["wrong name", JSON.stringify({ protocolVersion: 1, threadName: "other", threadId, location: "local", pid: 44 })],
    ["wrong filename", JSON.stringify({ protocolVersion: 1, threadName: correlationId, threadId, location: "local", pid: 44 })]
  ])("ignores %s records", async (kind, content) => {
    const filename = kind === "wrong filename" ? "ffffffffffffffffffffffffffffffff.json" : threadId.replaceAll("-", "") + ".json";
    const root = await fixture();
    await writeFile(join(root, filename), content);
    await expect(resolveTraexSessionPeer(root, 44, correlationId)).resolves.toEqual({ status: "pending" });
  });

  it("ignores oversized and symlinked records", async () => {
    const root = await fixture();
    const valid = JSON.stringify({ protocolVersion: 1, threadName: correlationId, threadId, location: "local", pid: 44 });
    await writeFile(join(root, threadId.replaceAll("-", "") + ".json"), valid.padEnd(4097, " "));
    await writeFile(join(root, "target"), valid);
    await symlink(join(root, "target"), join(root, "01a04f1ef78977d2aa087dd693650158.json"));
    await expect(resolveTraexSessionPeer(root, 44, correlationId)).resolves.toEqual({ status: "pending" });
  });

  it("fails closed when multiple canonical peers match", async () => {
    const root = await fixture();
    const second = "01a04f1e-f789-77d2-aa08-7dd693650158";
    await peer(root, threadId, { protocolVersion: 1, threadName: correlationId, threadId, location: "local", pid: 44 });
    await peer(root, second, { protocolVersion: 1, threadName: correlationId, threadId: second, location: "local", pid: 44 });
    await expect(resolveTraexSessionPeer(root, 44, correlationId)).resolves.toEqual({ status: "ambiguous" });
  });

  it("fails closed when the scan cap is exhausted", async () => {
    const root = await fixture();
    await writeFile(join(root, "a.json"), "{}");
    await writeFile(join(root, "b.json"), "{}");
    await expect(resolveTraexSessionPeer(root, 44, correlationId, { maxEntries: 1 })).resolves.toEqual({ status: "ambiguous" });
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "traex-session-peer-"));
  roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

async function peer(root: string, id: string, value: object): Promise<void> {
  await writeFile(join(root, id.replaceAll("-", "") + ".json"), JSON.stringify(value), { mode: constants.S_IRUSR | constants.S_IWUSR });
}

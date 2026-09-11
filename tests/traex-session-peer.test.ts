import { constants } from "node:fs";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findTraexSessionPeer } from "../src/runtime/traex-session-peer.js";

const roots: string[] = [];
const threadId = "01a04f1e-f789-77d2-aa08-7dd693650157";

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("TraeX session peer lookup", () => {
  it("resolves an exact native session peer", async () => {
    const root = await fixture();
    await peer(root, threadId, { protocolVersion: 1, threadName: "native", threadId, location: "local", socketPath: "/tmp/peer.sock", pid: 44, startedAtMs: 10 });
    await expect(findTraexSessionPeer(root, threadId)).resolves.toEqual({ threadId, socketPath: "/tmp/peer.sock", pid: 44, startedAtMs: 10 });
  });

  it("rejects malformed identities and peer records", async () => {
    const root = await fixture();
    await writeFile(join(root, threadId.replaceAll("-", "") + ".json"), "not json");
    await expect(findTraexSessionPeer(root, threadId)).resolves.toBeNull();
    await expect(findTraexSessionPeer(root, "not-a-session")).resolves.toBeNull();
  });

  it("rejects peers without an absolute socket path", async () => {
    const root = await fixture();
    await peer(root, threadId, { protocolVersion: 1, threadName: "native", threadId, location: "local", socketPath: "relative.sock", pid: 44, startedAtMs: 10 });
    await expect(findTraexSessionPeer(root, threadId)).resolves.toBeNull();
  });

  it("ignores oversized and symlinked records", async () => {
    const root = await fixture();
    const valid = JSON.stringify({ protocolVersion: 1, threadName: "native", threadId, location: "local", socketPath: "/tmp/peer.sock", pid: 44, startedAtMs: 10 });
    const path = join(root, threadId.replaceAll("-", "") + ".json");
    await writeFile(path, valid.padEnd(4097, " "));
    await expect(findTraexSessionPeer(root, threadId)).resolves.toBeNull();
    await import("node:fs/promises").then(({ rm }) => rm(path));
    await writeFile(join(root, "target"), valid);
    await symlink(join(root, "target"), path);
    await expect(findTraexSessionPeer(root, threadId)).resolves.toBeNull();
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

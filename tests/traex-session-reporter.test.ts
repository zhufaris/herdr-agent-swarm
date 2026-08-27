import { createConnection } from "node:net";
import { access, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import pino from "pino";
import { TraexSessionReporter } from "../src/runtime/traex-session-reporter.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

const bindingId = "88f4c290-2fd6-4c0f-9cbb-6be469cb4e6a";
const sessionId = "01a03eb1-c193-7531-83c0-e6c6f70143d4";

describe("TraeX session reporter ingress", () => {
  it("accepts one capability-bound identity and rejects a conflicting replacement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "traex-session-reporter-"));
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: bindingId, workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding(bindingId, { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached" });
    const reporter = new TraexSessionReporter(join(directory, "reporter.sock"), store, pino({ enabled: false }));
    await reporter.start();
    const environment = reporter.environment(bindingId, 1);
    await expect(send(environment.HERDR_BRIDGE_SESSION_SOCKET!, { paneId: "w1:p1", bindingId, generation: 1, sessionId, source: "startup", capability: environment.HERDR_BRIDGE_SESSION_CAPABILITY! })).resolves.toEqual({ outcome: "recorded" });
    await expect(send(environment.HERDR_BRIDGE_SESSION_SOCKET!, { paneId: "w1:p1", bindingId, generation: 1, sessionId, source: "startup", capability: environment.HERDR_BRIDGE_SESSION_CAPABILITY! })).resolves.toEqual({ outcome: "duplicate" });
    await expect(send(environment.HERDR_BRIDGE_SESSION_SOCKET!, { paneId: "w1:p1", bindingId, generation: 1, sessionId: "01a03eb1-c193-7531-83c0-e6c6f70143d5", source: "startup", capability: environment.HERDR_BRIDGE_SESSION_CAPABILITY! })).resolves.toEqual({ outcome: "rejected" });
    expect(store.getBinding(bindingId)).toMatchObject({ reportedTraexSessionId: sessionId });
    expect((await stat(environment.HERDR_BRIDGE_SESSION_SOCKET!)).mode & 0o777).toBe(0o600);
    await reporter.stop();
    store.close();
  });

  it("rejects a report with an invalid capability", async () => {
    const directory = await mkdtemp(join(tmpdir(), "traex-session-reporter-"));
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: bindingId, workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding(bindingId, { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached" });
    const reporter = new TraexSessionReporter(join(directory, "reporter.sock"), store, pino({ enabled: false }));
    await reporter.start();
    const socketPath = reporter.environment(bindingId, 1).HERDR_BRIDGE_SESSION_SOCKET!;
    await expect(send(socketPath, { paneId: "w1:p1", bindingId, generation: 1, sessionId, source: "startup", capability: "b".repeat(64) })).resolves.toEqual({ outcome: "rejected" });
    expect(store.getBinding(bindingId)?.reportedTraexSessionId).toBeNull();
    await reporter.stop();
    store.close();
  });

  it("rejects a local clear session even with a valid capability", async () => {
    const directory = await mkdtemp(join(tmpdir(), "traex-session-reporter-"));
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: bindingId, workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding(bindingId, { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached" });
    const reporter = new TraexSessionReporter(join(directory, "reporter.sock"), store, pino({ enabled: false }));
    await reporter.start();
    const environment = reporter.environment(bindingId, 1);

    await expect(send(environment.HERDR_BRIDGE_SESSION_SOCKET!, { paneId: "w1:p1", bindingId, generation: 1, sessionId, source: "clear", capability: environment.HERDR_BRIDGE_SESSION_CAPABILITY! })).resolves.toEqual({ outcome: "rejected" });
    expect(store.getBinding(bindingId)?.reportedTraexSessionId).toBeNull();
    await reporter.stop();
    store.close();
  });

  it("closes partial clients and unlinks the socket during shutdown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "traex-session-reporter-"));
    const store = new SqliteBindingStore(":memory:");
    const reporter = new TraexSessionReporter(join(directory, "reporter.sock"), store, pino({ enabled: false }));
    await reporter.start();
    const socketPath = reporter.environment(bindingId, 1).HERDR_BRIDGE_SESSION_SOCKET!;
    const client = createConnection(socketPath);
    await new Promise<void>((resolve, reject) => { client.once("connect", resolve); client.once("error", reject); });
    client.write("{\"incomplete\":");

    await expect(Promise.race([
      reporter.stop().then(() => "stopped"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 250))
    ])).resolves.toBe("stopped");
    await expect(access(socketPath)).rejects.toThrow();
    expect(client.destroyed).toBe(true);
    store.close();
  });
});

function send(socketPath: string, payload: object): Promise<{ outcome: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(JSON.stringify(payload) + "\n"));
    socket.on("data", (chunk: string) => { response += chunk; });
    socket.once("end", () => resolve(JSON.parse(response)));
    socket.once("error", reject);
  });
}

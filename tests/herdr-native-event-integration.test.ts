import { mkdtempSync } from "node:fs";
import { createSocket } from "node:dgram";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { HerdrRuntimeReconciler } from "../src/coordinator/herdr-runtime-reconciler.js";
import type { BridgeEvent } from "../src/domain/events.js";
import type { HerdrPort } from "../src/domain/ports.js";
import { InProcessPromptWorkScheduler } from "../src/events/prompt-work-scheduler.js";
import { HerdrEventInbox } from "../src/runtime/herdr-event-inbox.js";
import { HerdrSocketSubscriber } from "../src/runtime/herdr-socket-subscriber.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

describe("Herdr native and plugin event convergence", () => {
  it("keeps duplicate Socket and UDP wake-ups idempotent through one reconciler", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    store.updateBinding("b1", { paneId: "w1:p1", traexSessionId: "term-1", state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated", lastAgentState: "unknown" });
    const pane = { paneId: "w1:p1", terminalId: "term-1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle" as const, agentKind: "codex", outputRevision: 7, stateChangeSeq: 1, foregroundExecutables: ["traex"] };
    const published: BridgeEvent[] = [];
    const reconciler = new HerdrRuntimeReconciler({
      projects: [{ id: "repo", displayName: "Repo", description: "Repo", workspaceId: "w1", cwd: "/repo" }],
      store, herdr: { async listAllPanes() { return [pane]; }, async listPanes() { return [pane]; } } as unknown as HerdrPort,
      lifecycleEvents: { async publish(event) { published.push(event); } },
      channelPublisher: { async enqueueRunCardUpdate() {} }, logger: pino({ enabled: false }),
      discoverPane: async () => { throw new Error("not used"); }, scheduler: new InProcessPromptWorkScheduler(), isBindingBusy: () => false
    });
    const reconcile = (workspaceIds?: readonly string[]) => reconciler.requestReconciliation(workspaceIds);

    const socketPath = join(mkdtempSync(join(tmpdir(), "herdr-event-integration-")), "herdr.sock");
    let socketClient!: Socket;
    const socketServer = createServer((socket) => { socketClient = socket; });
    await new Promise<void>((resolve) => socketServer.listen(socketPath, resolve));
    const subscriber = new HerdrSocketSubscriber(socketPath, async () => [pane.paneId], ({ workspaceIds }) => reconcile(workspaceIds), pino({ enabled: false }), 5, 20);
    const inbox = new HerdrEventInbox(0, reconcile, pino({ enabled: false }), 5);
    await inbox.start();
    inbox.activate();
    subscriber.start();
    await vi.waitFor(() => expect(socketClient).toBeDefined());

    socketClient.write('{"event":"pane.agent_status_changed","data":{"workspace_id":"w1","pane_id":"w1:p1","agent_status":"idle"}}\n');
    await sendUdp(inbox.address()!.port, { event: "pane.agent_status_changed", workspaceIds: ["w1"], paneIds: ["w1:p1"], receivedAt: new Date().toISOString() });
    await vi.waitFor(() => expect(store.getBinding("b1")?.lastAgentState).toBe("idle"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(published.filter((event) => event.type === "AgentStateChanged")).toHaveLength(1);
    await subscriber.stop();
    await inbox.stop();
    socketClient.destroy();
    await new Promise<void>((resolve, reject) => socketServer.close((error) => error ? reject(error) : resolve()));
    store.close();
  });
});

function sendUdp(port: number, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    socket.send(Buffer.from(JSON.stringify(value)), port, "127.0.0.1", (error) => { socket.close(); error ? reject(error) : resolve(); });
  });
}

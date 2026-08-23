import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { SessionReconciler } from "../src/coordinator/session-reconciler.js";
import type { HerdrPort } from "../src/domain/ports.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

describe("SessionReconciler", () => {
  it("coalesces overlapping reconciliation calls into one workspace scan", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const listPanes = vi.fn(async () => { await blocked; return []; });
    const herdr = { listPanes } as unknown as HerdrPort;
    const store = new SqliteBindingStore(":memory:");
    const reconciler = new SessionReconciler({
      projects: [{ id: "repo", displayName: "Repo", description: "Repo", workspaceId: "w1", cwd: "/repo" }],
      store,
      herdr,
      bus: new BridgeEventBus(),
      channelPublisher: { async drain() {}, async enqueueRunCardUpdate() {} },
      logger: pino({ enabled: false }),
      discoverPane: async () => { throw new Error("not used"); },
      scheduleBinding() {},
      isBindingBusy: () => false
    });

    const first = reconciler.reconcile();
    const second = reconciler.reconcile();
    await vi.waitFor(() => expect(listPanes).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);

    expect(listPanes).toHaveBeenCalledTimes(1);
    store.close();
  });

  it("starts one timer and stop waits for the in-flight pass", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const listPanes = vi.fn(async () => { await blocked; return []; });
    const store = new SqliteBindingStore(":memory:");
    const reconciler = fixture(store, { listPanes } as unknown as HerdrPort);
    reconciler.start(100);
    reconciler.start(100);

    await vi.advanceTimersByTimeAsync(100);
    expect(listPanes).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = reconciler.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    await vi.advanceTimersByTimeAsync(200);
    expect(listPanes).toHaveBeenCalledTimes(1);

    store.close();
    vi.useRealTimers();
  });

  it("adds a discovered Pane to the pass-local map immediately", async () => {
    const pane = { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const herdr = { async listPanes() { return [pane, pane]; }, async readOutput() { return ""; } } as unknown as HerdrPort;
    const store = new SqliteBindingStore(":memory:");
    const discoverPane = vi.fn(async () => {
      let binding = store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: null, rootMessageId: null, title: "task" });
      binding = store.updateBinding(binding.id, { paneId: pane.paneId });
      return binding;
    });
    const reconciler = fixture(store, herdr, discoverPane);

    await reconciler.reconcile();

    expect(discoverPane).toHaveBeenCalledTimes(1);
    store.close();
  });
});

function fixture(
  store: SqliteBindingStore,
  herdr: HerdrPort,
  discoverPane: ConstructorParameters<typeof SessionReconciler>[0]["discoverPane"] = async () => { throw new Error("not used"); }
) {
  return new SessionReconciler({
    projects: [{ id: "repo", displayName: "Repo", description: "Repo", workspaceId: "w1", cwd: "/repo" }],
    store, herdr, bus: new BridgeEventBus(),
    channelPublisher: { async drain() {}, async enqueueRunCardUpdate() {} },
    logger: pino({ enabled: false }), discoverPane, scheduleBinding() {}, isBindingBusy: () => false
  });
}

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import {
  HerdrEventsAdapter,
  normalizeSessionEventMultiplexAck,
  normalizeSessionEventMultiplexFrame
} from "../src/adapters/herdr-events-adapter.js";
import type { CoreSessionEventMultiplexFrame, CoreSessionEventMultiplexTarget } from "../src/domain/herdr-events.js";
import { RuntimeLink } from "../src/composition/runtime-link.js";
import { CoreSessionIngestionSupervisor } from "../src/coordinator/core-session-ingestion-supervisor.js";
import type { Binding } from "../src/domain/types.js";
import { HerdrSessionEventSubscriber } from "../src/runtime/herdr-session-event-subscriber.js";
import { HerdrSocketSubscriber, type HerdrNativeEventHint } from "../src/runtime/herdr-socket-subscriber.js";

const protocolFixture = JSON.parse(readFileSync(new URL("./fixtures/herdr-session-events-v3.json", import.meta.url), "utf8")) as {
  batchFrame: object;
};

const target: CoreSessionEventMultiplexTarget = {
  ringId: "session-ring-v2:ring-1",
  epoch: "epoch-1",
  after: "session-ring-v2:ring-1:epoch-1:9",
  limit: 128
};

describe("Core session event multiplex composition", () => {
  it.each([
    { name: "v2/per-pane", multiplex: false, globalStatus: false },
    { name: "v3/per-pane", multiplex: true, globalStatus: false },
    { name: "v2/global", multiplex: false, globalStatus: true },
    { name: "v3/global", multiplex: true, globalStatus: true }
  ])("keeps $name capabilities independent", async ({ multiplex, globalStatus }) => {
    const server = await startCapabilityServer({ multiplex, globalStatus });
    const logger = pino({ enabled: false });
    let currentPaneIds = ["w1:p1"];
    const paneIds = vi.fn(async () => currentPaneIds);
    const hints = vi.fn((_hint: HerdrNativeEventHint, _signal: AbortSignal) => undefined);
    let adapter!: HerdrEventsAdapter;
    const generic = new HerdrSocketSubscriber(
      server.socketPath,
      paneIds,
      hints,
      logger,
      5,
      20,
      2 * 1024 * 1024,
      1_000,
      () => adapter.supportsPaneAgentStatusAll()
    );
    adapter = new HerdrEventsAdapter({ run: async () => { throw new Error("CLI fallback was not expected"); } }, "herdr", generic);

    const frameLink = new RuntimeLink<(frame: CoreSessionEventMultiplexFrame, generation: number) => void>("test Core session ingestion supervisor");
    const sessionEvents = new HerdrSessionEventSubscriber({
      socketPath: server.socketPath,
      supportsMultiplex: () => adapter.supportsSessionEventMultiplex(),
      normalizeAck: normalizeSessionEventMultiplexAck,
      normalizeFrame: normalizeSessionEventMultiplexFrame,
      onFrame: frameLink.callable(),
      logger,
      reconnectBaseMs: 5,
      reconnectMaxMs: 20,
      acknowledgementTimeoutMs: 1_000
    });
    const frames = vi.fn();
    frameLink.connect(frames);

    try {
      sessionEvents.start();
      const replacement = sessionEvents.replaceTargets([target]);
      if (multiplex) {
        await expect(replacement).resolves.toBeUndefined();
        expect(sessionEvents.status()).toMatchObject({ connected: true, generation: 1, activeTargetCount: 1 });
        expect(server.requests.filter(({ method }) => method === "session.events.subscribe.v3")).toHaveLength(1);
        server.multiplexClient?.write(`${JSON.stringify(protocolFixture.batchFrame)}\n`);
        await vi.waitFor(() => expect(frames).toHaveBeenCalledWith(expect.objectContaining({ outcome: "batch" }), 1));
      } else {
        await expect(replacement).rejects.toThrow(/multiplex capability is unavailable/);
        expect(sessionEvents.status()).toEqual({ connected: false, generation: 0, activeTargetCount: 0 });
        expect(server.requests.filter(({ method }) => method === "session.events.subscribe.v3")).toHaveLength(0);
      }

      generic.startEvents();
      await vi.waitFor(() => expect(server.eventSubscriptions).toHaveLength(1));
      const subscriptions = server.eventSubscriptions[0]!;
      if (globalStatus) {
        expect(paneIds).not.toHaveBeenCalled();
        expect(subscriptions.filter(({ type }) => type === "pane.agent_status_all")).toHaveLength(1);
        expect(subscriptions.some(({ type }) => type === "pane.agent_status_changed")).toBe(false);
      } else {
        expect(paneIds).toHaveBeenCalledOnce();
        expect(subscriptions).toContainEqual({ type: "pane.agent_status_changed", pane_id: "w1:p1" });
        expect(subscriptions.some(({ type }) => type === "pane.agent_status_all")).toBe(false);
      }

      currentPaneIds = ["w1:p1", "w1:p2"];
      server.eventClient?.write('{"event":"pane.created","data":{"workspace_id":"w1","pane_id":"w1:p2"}}\n');
      await vi.waitFor(() => expect(hints).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "pane-created", scope: "workspaces", workspaceIds: ["w1"], paneIds: ["w1:p2"] }),
        expect.any(AbortSignal)
      ));
      if (globalStatus) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(server.eventSubscriptions).toHaveLength(1);
      } else {
        await vi.waitFor(() => expect(server.eventSubscriptions).toHaveLength(2));
        expect(server.eventSubscriptions[1]).toContainEqual({ type: "pane.agent_status_changed", pane_id: "w1:p2" });
      }
    } finally {
      await sessionEvents.stop();
      await generic.stop();
      await vi.waitFor(() => expect(server.activeClientCount).toBe(0));
      await server.close();
    }
  });

  it("routes an ACK-coalesced initial v3 batch without a steady-state v2 read", async () => {
    const server = await startCapabilityServer({
      multiplex: true,
      globalStatus: false,
      initialBatchFrame: protocolFixture.batchFrame
    });
    const logger = pino({ enabled: false });
    const frameLink = new RuntimeLink<(frame: CoreSessionEventMultiplexFrame, generation: number) => void>("Core session ingestion supervisor");
    const sessionEvents = new HerdrSessionEventSubscriber({
      socketPath: server.socketPath,
      supportsMultiplex: async () => true,
      normalizeAck: normalizeSessionEventMultiplexAck,
      normalizeFrame: normalizeSessionEventMultiplexFrame,
      onFrame: frameLink.callable(),
      logger,
      acknowledgementTimeoutMs: 1_000
    });
    const binding = {
      id: "binding-1", state: "active", generation: 1, paneId: "w1:p1", agentKind: "traex",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    } as Binding;
    const ingestCurrentSession = vi.fn(async () => ({
      laneId: "lane-1", sourceId: target.ringId, ingestedEvents: 0, caughtUp: true
    }));
    const ingestMultiplexBatch = vi.fn(async (_source, _target, batch) => ({
      laneId: "lane-1", sourceId: batch.ringId, ingestedEvents: batch.events.length,
      caughtUp: true, outcome: "accepted" as const, readCursor: batch.nextCursor
    }));
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => [binding] },
      ingestor: {
        ingestCurrentSession,
        ingestMultiplexBatch,
        prepareMultiplexTarget: async () => target
      },
      replaceMultiplexTargets: async (targets) => {
        await sessionEvents.replaceTargets(targets);
        return sessionEvents.status().generation;
      },
      resolveSource: async () => ({
        agentKind: "traex", bindingId: binding.id, generation: binding.generation, paneId: binding.paneId,
        terminalId: "terminal-1", nativeSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }
      }),
      onIngested: vi.fn(),
      logger
    });
    frameLink.connect((frame, generation) => { void supervisor.handleMultiplexFrame(frame, generation); });

    try {
      sessionEvents.start();
      await supervisor.reconcile();
      expect(ingestCurrentSession).toHaveBeenCalledOnce();
      expect(sessionEvents.status()).toMatchObject({ connected: true, generation: 1, activeTargetCount: 1 });
      await vi.waitFor(() => expect(ingestMultiplexBatch).toHaveBeenCalledOnce());
      expect(ingestCurrentSession).toHaveBeenCalledOnce();
      expect(server.requests.filter(({ method }) => method === "session.events.subscribe.v3")).toHaveLength(1);
    } finally {
      await sessionEvents.stop();
      await supervisor.stop();
      await vi.waitFor(() => expect(server.activeClientCount).toBe(0));
      await server.close();
    }
  });
});

interface CapabilityServer {
  socketPath: string;
  requests: Array<{ id: string; method: string; params: Record<string, unknown> }>;
  eventSubscriptions: Array<Array<Record<string, string>>>;
  eventClient: Socket | null;
  multiplexClient: Socket | null;
  activeClientCount: number;
  close(): Promise<void>;
}

async function startCapabilityServer(capabilities: { multiplex: boolean; globalStatus: boolean; initialBatchFrame?: object }): Promise<CapabilityServer> {
  const directory = mkdtempSync(join(tmpdir(), "core-session-event-matrix-"));
  const socketPath = join(directory, "herdr.sock");
  const clients = new Set<Socket>();
  const requests: CapabilityServer["requests"] = [];
  const eventSubscriptions: CapabilityServer["eventSubscriptions"] = [];
  const state: Pick<CapabilityServer, "eventClient" | "multiplexClient"> = { eventClient: null, multiplexClient: null };
  const server: Server = createServer((socket) => {
    clients.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const request = JSON.parse(line) as CapabilityServer["requests"][number];
        requests.push(request);
        if (request.method === "ping") {
          // Core handles exactly one initial RPC request per socket. Capability
          // probes therefore complete on a short-lived connection.
          socket.end(`${JSON.stringify({ id: request.id, result: {
            type: "pong", version: "0.9.3", protocol: 22,
            capabilities: {
              session_event_stream_v1: true,
              session_event_multiplex_v1: capabilities.multiplex,
              pane_agent_status_all_v1: capabilities.globalStatus
            }
          } })}\n`);
        } else if (request.method === "events.subscribe") {
          state.eventClient = socket;
          const params = request.params as { subscriptions: Array<Record<string, string>> };
          eventSubscriptions.push(params.subscriptions);
          socket.write(`${JSON.stringify({ id: request.id, result: { subscribed: true } })}\n`);
        } else if (request.method === "session.events.subscribe.v3") {
          state.multiplexClient = socket;
          const params = request.params as { targets: unknown[] };
          let response = `${JSON.stringify({ id: request.id, result: {
            type: "session_event_multiplex_subscribed_v3", target_count: params.targets.length
          } })}\n`;
          if (capabilities.initialBatchFrame) response += `${JSON.stringify(capabilities.initialBatchFrame)}\n`;
          socket.write(response);
        }
      }
    });
    socket.once("close", () => clients.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.off("error", reject); resolve(); });
  });
  return {
    socketPath,
    requests,
    eventSubscriptions,
    get eventClient() { return state.eventClient; },
    get multiplexClient() { return state.multiplexClient; },
    get activeClientCount() { return clients.size; },
    async close() {
      for (const client of clients) client.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

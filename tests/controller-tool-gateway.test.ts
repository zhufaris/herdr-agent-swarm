import { createConnection } from "node:net";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { handleControllerMcpRequest } from "../src/cli/controller-tools-mcp.js";
import { ControllerToolGateway } from "../src/runtime/controller-tool-gateway.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";

describe("ControllerToolGateway", () => {
  let directory: string | null = null;
  let store: SqliteBindingStore | null = null;
  let gateway: ControllerToolGateway | null = null;

  afterEach(async () => {
    await gateway?.stop();
    store?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("fences every tool call to the exact job capability and active state", async () => {
    const fixture = await setup();
    const context = await call(fixture.socketPath, { jobId: "job-1", capability: fixture.capability, tool: "getInterpretationContext", arguments: {} });
    expect(context).toMatchObject({ ok: true, result: { requestId: "job-1", text: "看看 reviewer 然后决定怎么办", projects: [{ id: "default" }] } });

    await expect(call(fixture.socketPath, { jobId: "job-1", capability: "b".repeat(64), tool: "getInterpretationContext", arguments: {} })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/invalid or stale/) });
    await expect(call(fixture.socketPath, { jobId: "other-job", capability: fixture.capability, tool: "getInterpretationContext", arguments: {} })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/invalid or stale/) });
  });

  it("accepts one typed proposal and rejects later reads or submissions", async () => {
    const fixture = await setup();
    const request = { jobId: "job-1", capability: fixture.capability, tool: "submitInterpretation", arguments: { result: { outcome: "command", source: "controller", family: "swarm", command: { kind: "panes" } } } };
    await expect(call(fixture.socketPath, request)).resolves.toMatchObject({ ok: true, result: { accepted: true } });
    expect(store!.getControllerInterpretation("job-1")).toMatchObject({ state: "succeeded", result: { command: { kind: "panes" } } });
    await expect(call(fixture.socketPath, request)).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/invalid or stale/) });
    await expect(call(fixture.socketPath, { ...request, tool: "getInterpretationContext", arguments: {} })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/invalid or stale/) });
  });

  async function setup() {
    directory = await mkdtemp(join(tmpdir(), "controller-tools-"));
    const socketPath = join(directory, "controller.sock");
    const capability = "a".repeat(64);
    store = new SqliteBindingStore(":memory:");
    store.saveControllerRuntime({ generation: 1, paneId: "w1:controller", terminalId: "terminal-1", nativeSessionId: "session-1", state: "active" }, new Date().toISOString());
    const message = { eventId: "event-1", messageId: "message-1", parentMessageId: null, chatId: "chat", topicId: null, rootMessageId: "root", actorOpenId: "admin", text: "看看 reviewer 然后决定怎么办", mentionsBot: true, isRootMessage: true };
    store.acceptControllerInterpretation({ id: "job-1", message, controllerGeneration: 1, capabilityHash: hash(capability), acceptedAt: new Date().toISOString() });
    store.claimNextControllerInterpretation(1, hash(capability), new Date().toISOString());
    store.markControllerInterpretationDispatched("job-1", 1, "turn-1", new Date().toISOString());
    gateway = new ControllerToolGateway(socketPath, store, [{ id: "default", displayName: "Default", description: "Default project", workspaceId: "w1", cwd: "/repo" }], pino({ enabled: false }));
    await gateway.start();
    return { socketPath, capability };
  }
});

describe("Controller MCP protocol", () => {
  it("exposes only the three proposal tools", async () => {
    const response = await handleControllerMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, vi.fn());
    expect(response).toMatchObject({ result: { tools: [
      { name: "get_interpretation_context" },
      { name: "inspect_swarm_target" },
      { name: "submit_interpretation" }
    ] } });
  });

  it("rejects unknown tools and missing request capabilities before invocation", async () => {
    const invoke = vi.fn();
    await expect(handleControllerMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "prompt_instance", arguments: {} } }, invoke)).resolves.toMatchObject({ error: { code: -32602 } });
    await expect(handleControllerMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_interpretation_context", arguments: { requestId: "job-1" } } }, invoke)).resolves.toMatchObject({ error: { code: -32602 } });
    expect(invoke).not.toHaveBeenCalled();
  });
});

function call(socketPath: string, payload: object): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let output = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => { output += chunk; });
    socket.once("end", () => resolve(JSON.parse(output)));
    socket.once("error", reject);
  });
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

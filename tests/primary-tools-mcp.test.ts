import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callPrimaryToolGateway, handlePrimaryMcpRequest, MAX_PRIMARY_TOOL_RESPONSE_BYTES } from "../src/cli/primary-tools-mcp.js";

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("Primary tools MCP surface", () => {
  it("advertises only the fixed non-topology tools with model-facing guidance", async () => {
    const response = await handlePrimaryMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, vi.fn()) as { result: { tools: Array<{ name: string; description: string }> } };
    expect(response.result.tools.map(({ name }) => name).sort()).toEqual(["follow_up_instance", "inspect_instance", "interrupt_instance", "list_instances", "prompt_instance", "show_worker_cards", "steer_instance", "wait_instance"].sort());
    expect(response.result.tools.every(({ description }) => description.length > 40)).toBe(true);
  });

  it("maps an exact-name Worker card display request", async () => {
    const invoke = vi.fn(async () => ({ accepted: true, delivery: "queued" }));
    await handlePrimaryMcpRequest({ jsonrpc: "2.0", id: "show", method: "tools/call", params: { name: "show_worker_cards", arguments: { workerName: "reviewer", idempotencyKey: "show-reviewer" } } }, invoke);
    expect(invoke).toHaveBeenCalledWith("showWorkerCards", { workerName: "reviewer", idempotencyKey: "show-reviewer" });
  });

  it("maps a tool call to the gateway without accepting identity fields outside arguments", async () => {
    const invoke = vi.fn(async () => ({ accepted: true }));
    await expect(handlePrimaryMcpRequest({ jsonrpc: "2.0", id: "call-1", method: "tools/call", params: { name: "prompt_instance", arguments: { instanceId: "worker", task: "review", idempotencyKey: "key" }, projectId: "forged" } }, invoke)).resolves.toMatchObject({ result: { structuredContent: { accepted: true } } });
    expect(invoke).toHaveBeenCalledWith("promptInstance", { instanceId: "worker", task: "review", idempotencyKey: "key" });
  });

  it("requires and forwards an explicit parent turn for Worker follow-ups", async () => {
    const invoke = vi.fn(async () => ({ accepted: true }));
    const listed = await handlePrimaryMcpRequest({ jsonrpc: "2.0", id: "list", method: "tools/list" }, invoke) as { result: { tools: Array<{ name: string; inputSchema: { required?: string[] } }> } };
    expect(listed.result.tools.find(({ name }) => name === "follow_up_instance")?.inputSchema.required).toContain("parentTurnId");
    await handlePrimaryMcpRequest({ jsonrpc: "2.0", id: "follow", method: "tools/call", params: { name: "follow_up_instance", arguments: { instanceId: "worker", parentTurnId: "parent-turn", text: "continue", idempotencyKey: "follow-key" } } }, invoke);
    expect(invoke).toHaveBeenCalledWith("followUpInstance", { instanceId: "worker", parentTurnId: "parent-turn", text: "continue", idempotencyKey: "follow-key" });
  });

  it("returns actionable tool errors as MCP results", async () => {
    const response = await handlePrimaryMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "inspect_instance", arguments: { instanceId: "missing" } } }, async () => { throw new Error("Target instance not found"); });
    expect(response).toMatchObject({ result: { isError: true, content: [{ text: expect.stringMatching(/Target instance not found.*Inspect the target instance/) }] } });
  });

  it("rejects an oversized gateway response before buffering it indefinitely", async () => {
    const directory = await mkdtemp(join(tmpdir(), "primary-tools-response-")); temporaryDirectories.push(directory);
    const socketPath = join(directory, "gateway.sock");
    let accepted: Socket | null = null;
    const server = createServer((socket) => { accepted = socket; socket.end(Buffer.alloc(MAX_PRIMARY_TOOL_RESPONSE_BYTES + 1, 97)); });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    try {
      await expect(callPrimaryToolGateway(socketPath, {})).rejects.toThrow(/response.*large/i);
    } finally {
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      (accepted as Socket | null)?.destroy();
      await closed;
    }
  });
});

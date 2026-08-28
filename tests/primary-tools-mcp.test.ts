import { describe, expect, it, vi } from "vitest";
import { handlePrimaryMcpRequest } from "../src/cli/primary-tools-mcp.js";

describe("Primary tools MCP surface", () => {
  it("advertises only the fixed non-topology tools with model-facing guidance", async () => {
    const response = await handlePrimaryMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, vi.fn()) as { result: { tools: Array<{ name: string; description: string }> } };
    expect(response.result.tools.map(({ name }) => name).sort()).toEqual(["follow_up_instance", "inspect_instance", "interrupt_instance", "list_instances", "prompt_instance", "steer_instance", "wait_instance"].sort());
    expect(response.result.tools.every(({ description }) => description.length > 40)).toBe(true);
  });

  it("maps a tool call to the gateway without accepting identity fields outside arguments", async () => {
    const invoke = vi.fn(async () => ({ accepted: true }));
    await expect(handlePrimaryMcpRequest({ jsonrpc: "2.0", id: "call-1", method: "tools/call", params: { name: "prompt_instance", arguments: { instanceId: "worker", task: "review", idempotencyKey: "key" }, projectId: "forged" } }, invoke)).resolves.toMatchObject({ result: { structuredContent: { accepted: true } } });
    expect(invoke).toHaveBeenCalledWith("promptInstance", { instanceId: "worker", task: "review", idempotencyKey: "key" });
  });

  it("returns actionable tool errors as MCP results", async () => {
    const response = await handlePrimaryMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "inspect_instance", arguments: { instanceId: "missing" } } }, async () => { throw new Error("Target instance not found"); });
    expect(response).toMatchObject({ result: { isError: true, content: [{ text: expect.stringMatching(/Target instance not found.*Inspect the target instance/) }] } });
  });
});

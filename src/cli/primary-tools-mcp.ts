import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";

type JsonRpcRequest = { jsonrpc: "2.0"; id?: string | number; method: string; params?: Record<string, unknown> };
export const MAX_PRIMARY_TOOL_RESPONSE_BYTES = 1024 * 1024;
export const PRIMARY_TOOLS_VERSION = packageVersion();
const definitions = [
  tool("list_instances", "List existing agent instances in this Primary's project. Use this before choosing a Worker. This cannot create or retarget instances.", { state: { type: "string", description: "Optional observed-state filter." } }),
  tool("prompt_instance", "Send a new FIFO task to an existing same-project Worker. Use an idempotency key stable for this intended call. This never creates a Worker.", required({ instanceId: stringField("Worker instance ID from list_instances."), task: stringField("Complete task for the Worker."), idempotencyKey: stringField("Stable unique key for this intended submission.") })),
  tool("follow_up_instance", "Queue a follow-up to one explicit settled turn on an existing same-project Worker. It runs in FIFO order and does not imply steering.", required({ instanceId: stringField("Worker instance ID."), parentTurnId: stringField("Settled parent turn ID from inspect_instance."), text: stringField("Follow-up instruction."), idempotencyKey: stringField("Stable unique key for this intended submission.") })),
  tool("steer_instance", "Explicitly steer a currently active Worker turn. It never falls back to queueing an ordinary turn.", required({ instanceId: stringField("Active Worker instance ID."), text: stringField("Priority steering instruction."), idempotencyKey: stringField("Stable unique key for this intended operation.") })),
  tool("inspect_instance", "Inspect one existing same-project Worker and its bounded durable turn/event history.", required({ instanceId: stringField("Worker instance ID.") })),
  tool("wait_instance", "Poll durable events for one Worker after an opaque cursor. Use this to observe completion; completion never triggers a Primary turn automatically.", required({ instanceId: stringField("Worker instance ID."), afterCursor: stringField("Cursor returned by a previous call."), timeoutMs: { type: "integer", minimum: 0, maximum: 30000, description: "Maximum wait hint in milliseconds." } }, ["instanceId"])),
  tool("interrupt_instance", "Interrupt a currently active same-project Worker. Use only when the user or task requires interruption; this does not stop or remove the instance.", required({ instanceId: stringField("Active Worker instance ID."), idempotencyKey: stringField("Stable unique key for this intended operation.") })),
  tool("show_worker_cards", "Queue one one-time status snapshot for an exact-name Worker owned by this Primary. The snapshot does not update automatically and never prompts or controls the Worker.", required({ workerName: stringField("Exact Worker display name."), idempotencyKey: stringField("Stable unique key for this intended display request.") }))
];
const methodNames: Record<string, string> = { list_instances: "listInstances", prompt_instance: "promptInstance", follow_up_instance: "followUpInstance", steer_instance: "steerInstance", inspect_instance: "inspectInstance", wait_instance: "waitInstance", interrupt_instance: "interruptInstance", show_worker_cards: "showWorkerCards" };

export async function handlePrimaryMcpRequest(request: JsonRpcRequest, invoke: (tool: string, args: Record<string, unknown>) => Promise<unknown>): Promise<object | null> {
  if (request.method === "notifications/initialized") return null;
  if (request.method === "initialize") return result(request.id, { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "herdr-agent-swarm-primary-tools", version: PRIMARY_TOOLS_VERSION }, instructions: "Use these tools only to coordinate existing Workers in this Primary's project. Never create, remove, promote, retarget, merge, push, deploy, or delete through this server." });
  if (request.method === "tools/list") return result(request.id, { tools: definitions });
  if (request.method === "tools/call") {
    const name = typeof request.params?.name === "string" ? request.params.name : "";
    const method = methodNames[name];
    if (!method) return failure(request.id, -32602, `Unknown tool: ${name}`);
    try {
      const value = await invoke(method, objectValue(request.params?.arguments));
      return result(request.id, { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
    } catch (error) {
      return result(request.id, { isError: true, content: [{ type: "text", text: actionableError(error) }] });
    }
  }
  return failure(request.id, -32601, `Method not found: ${request.method}`);
}

async function main(): Promise<void> {
  const socketPath = argument("--socket"); const bindingId = argument("--binding"); const generation = Number(argument("--generation"));
  const capability = process.env.SWARM_PRIMARY_CAPABILITY;
  if (!socketPath || !bindingId || !Number.isInteger(generation) || generation <= 0 || !capability) throw new Error("Primary MCP runtime credential is incomplete");
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    let response: object | null;
    try { response = await handlePrimaryMcpRequest(JSON.parse(line) as JsonRpcRequest, (toolName, args) => callPrimaryToolGateway(socketPath, { bindingId, generation, capability, tool: toolName, arguments: args })); }
    catch (error) { response = failure(null, -32700, actionableError(error)); }
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

export function callPrimaryToolGateway(socketPath: string, request: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath); const chunks: Buffer[] = []; let responseBytes = 0; let settled = false;
    const settle = (action: () => void): void => { if (settled) return; settled = true; clearTimeout(timer); action(); };
    const timer = setTimeout(() => settle(() => { socket.destroy(); reject(new Error("Primary tool gateway timed out; inspect the instance and retry with the same idempotency key.")); }), 30_000); timer.unref();
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: Buffer) => {
      responseBytes += chunk.length;
      if (responseBytes > MAX_PRIMARY_TOOL_RESPONSE_BYTES) { settle(() => { socket.destroy(); reject(new Error("Primary tool gateway response was too large")); }); return; }
      chunks.push(chunk);
    });
    socket.once("end", () => settle(() => { try { const decoded = JSON.parse(Buffer.concat(chunks, responseBytes).toString("utf8")) as { ok: boolean; result?: unknown; error?: string }; decoded.ok ? resolve(decoded.result) : reject(new Error(decoded.error ?? "Primary tool call was rejected")); } catch { reject(new Error("Primary tool gateway returned an invalid response")); } }));
    socket.once("error", (error) => settle(() => reject(error)));
  });
}
function tool(name: string, description: string, properties: Record<string, unknown> | { type: string; properties: Record<string, unknown>; required?: string[] }) { return { name, description, inputSchema: "type" in properties ? properties : { type: "object", properties, additionalProperties: false } }; }
function required(properties: Record<string, unknown>, names = Object.keys(properties)) { return { type: "object", properties, required: names, additionalProperties: false }; }
function stringField(description: string) { return { type: "string", minLength: 1, description }; }
function objectValue(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function result(id: unknown, value: unknown) { return { jsonrpc: "2.0", id: id ?? null, result: value }; }
function failure(id: unknown, code: number, message: string) { return { jsonrpc: "2.0", id: id ?? null, error: { code, message } }; }
function actionableError(error: unknown): string { return `${error instanceof Error ? error.message : String(error)}. Inspect the target instance or ask the user to repair its lifecycle; do not create or retarget Workers.`; }
function packageVersion(): string {
  const value = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
  if (typeof value.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version)) throw new Error("Primary MCP package version is invalid");
  return value.version;
}
function argument(name: string): string | undefined { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }

if (import.meta.url === `file://${process.argv[1]}`) void main().catch((error) => { process.stderr.write(`${actionableError(error)}\n`); process.exitCode = 1; });

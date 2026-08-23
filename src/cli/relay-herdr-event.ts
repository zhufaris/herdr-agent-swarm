import { createSocket } from "node:dgram";
import { extractHerdrEventIds, MAX_HERDR_EVENT_BYTES } from "../runtime/herdr-event-inbox.js";
import { readEnvironmentFile } from "../runtime/environment-file.js";

export async function relayHerdrEvent(environment: NodeJS.ProcessEnv = process.env): Promise<"relayed" | "dropped"> {
  const configured = environment.HERDR_BRIDGE_ENV_FILE ? readEnvironmentFile(environment.HERDR_BRIDGE_ENV_FILE) : {};
  const port = Number(environment.HERDR_BRIDGE_EVENT_PORT || configured.HERDR_BRIDGE_EVENT_PORT || "18787");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("HERDR_BRIDGE_EVENT_PORT must be a valid UDP port");
  const event = (environment.HERDR_PLUGIN_EVENT || "unknown").slice(0, 128);
  let context: unknown = null;
  const raw = environment.HERDR_PLUGIN_EVENT_JSON || "";
  if (Buffer.byteLength(raw) <= MAX_HERDR_EVENT_BYTES) {
    try { context = raw ? JSON.parse(raw) : null; } catch { context = null; }
  }
  const ids = extractHerdrEventIds(context);
  const payload = Buffer.from(JSON.stringify({ event, ...ids, receivedAt: new Date().toISOString() }));
  if (payload.byteLength > MAX_HERDR_EVENT_BYTES) return "dropped";
  return new Promise((resolvePromise) => {
    const socket = createSocket("udp4");
    const finish = (result: "relayed" | "dropped") => { socket.close(); resolvePromise(result); };
    socket.once("error", () => finish("dropped"));
    socket.send(payload, port, "127.0.0.1", (error) => finish(error ? "dropped" : "relayed"));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  relayHerdrEvent().catch((error) => { process.stderr.write(`Herdr event relay failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}

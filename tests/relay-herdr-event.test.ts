import { createSocket } from "node:dgram";
import { afterEach, describe, expect, it } from "vitest";
import { relayHerdrEvent } from "../src/cli/relay-herdr-event.js";

const sockets: ReturnType<typeof createSocket>[] = [];
afterEach(() => { for (const socket of sockets.splice(0)) socket.close(); });

describe("Herdr event relay", () => {
  it("sends a bounded identity-only datagram to the bridge", async () => {
    const socket = createSocket("udp4"); sockets.push(socket);
    await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
    const port = (socket.address() as { port: number }).port;
    const received = new Promise<Record<string, unknown>>((resolve) => socket.once("message", (message) => resolve(JSON.parse(message.toString("utf8")))));
    await expect(relayHerdrEvent({ HERDR_BRIDGE_EVENT_PORT: String(port), HERDR_PLUGIN_EVENT: "pane.agent_status_changed", HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ workspace_id: "w1", pane: { pane_id: "p1" }, terminal_output: "secret" }) })).resolves.toBe("relayed");
    await expect(received).resolves.toMatchObject({ event: "pane.agent_status_changed", workspaceIds: ["w1"], paneIds: ["p1"] });
    expect(JSON.stringify(await received)).not.toContain("secret");
  });

  it("does not require a running receiver", async () => {
    await expect(relayHerdrEvent({ HERDR_BRIDGE_EVENT_PORT: "65534", HERDR_PLUGIN_EVENT: "pane.exited" })).resolves.toBe("relayed");
  });
});

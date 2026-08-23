import { createSocket } from "node:dgram";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { extractHerdrEventIds, HerdrEventInbox } from "../src/runtime/herdr-event-inbox.js";

describe("Herdr event inbox", () => {
  it("extracts bounded workspace and pane identities", () => {
    expect(extractHerdrEventIds({ workspace_id: "w1", pane: { workspaceId: "w2", pane_id: "p2" }, items: [{ paneId: "p1" }] })).toEqual({ workspaceIds: ["w1", "w2"], paneIds: ["p2", "p1"] });
    expect(extractHerdrEventIds({ workspace_id: "x".repeat(257) })).toEqual({ workspaceIds: [], paneIds: [] });
  });

  it("coalesces UDP hints into one targeted reconciliation", async () => {
    const reconcile = vi.fn(async () => {});
    const inbox = new HerdrEventInbox(0, reconcile, pino({ enabled: false }), 5);
    await inbox.start(); inbox.activate();
    const port = inbox.address()!.port;
    await send(port, { event: "pane.created", workspaceIds: ["w1"], paneIds: ["p1"], receivedAt: new Date().toISOString() });
    await send(port, { event: "pane.exited", workspaceIds: ["w2"], paneIds: ["p2"], receivedAt: new Date().toISOString() });
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    expect(reconcile).toHaveBeenCalledWith(["w1", "w2"]);
    await inbox.stop();
  });

  it("falls back to full reconciliation for malformed or unscoped hints", async () => {
    const reconcile = vi.fn(async () => {});
    const inbox = new HerdrEventInbox(0, reconcile, pino({ enabled: false }), 5);
    await inbox.start(); inbox.activate();
    const port = inbox.address()!.port;
    await sendRaw(port, Buffer.from("not-json"));
    await send(port, { event: "pane.exited", workspaceIds: [], paneIds: [], receivedAt: new Date().toISOString() });
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    expect(reconcile).toHaveBeenCalledWith(undefined);
    await inbox.stop();
  });
});

function send(port: number, value: unknown): Promise<void> { return sendRaw(port, Buffer.from(JSON.stringify(value))); }
function sendRaw(port: number, value: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    socket.send(value, port, "127.0.0.1", (error) => { socket.close(); error ? reject(error) : resolve(); });
  });
}

import { EventEmitter } from "node:events";
import type { BridgeEvent, InboundMessageReceivedEvent } from "../domain/events.js";

type BridgeEventListener = (event: BridgeEvent) => void | Promise<void>;
type InboundMessageListener = (event: InboundMessageReceivedEvent) => void | Promise<void>;

export class BridgeEventBus extends EventEmitter {
  onBridgeEvent(listener: BridgeEventListener): () => void {
    this.on("bridge-event", listener);
    return () => this.off("bridge-event", listener);
  }

  async publish(event: BridgeEvent): Promise<void> {
    const listeners = this.listeners("bridge-event") as BridgeEventListener[];
    await Promise.all(listeners.map((listener) => listener(event)));
  }

  onInboundMessage(listener: InboundMessageListener): () => void {
    this.on("inbound-message", listener);
    return () => this.off("inbound-message", listener);
  }

  async publishInbound(event: InboundMessageReceivedEvent): Promise<void> {
    const listeners = this.listeners("inbound-message") as InboundMessageListener[];
    await Promise.all(listeners.map((listener) => listener(event)));
  }
}

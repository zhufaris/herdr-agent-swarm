import { EventEmitter } from "node:events";
import type { BridgeEvent } from "../domain/events.js";

type BridgeEventListener = (event: BridgeEvent) => void | Promise<void>;

export class BridgeEventBus extends EventEmitter {
  onBridgeEvent(listener: BridgeEventListener): () => void {
    this.on("bridge-event", listener);
    return () => this.off("bridge-event", listener);
  }

  async publish(event: BridgeEvent): Promise<void> {
    const listeners = this.listeners("bridge-event") as BridgeEventListener[];
    await Promise.all(listeners.map((listener) => listener(event)));
  }
}

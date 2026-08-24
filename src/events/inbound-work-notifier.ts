import { EventEmitter } from "node:events";
import type { InboundMessageReceivedEvent } from "../domain/events.js";

type InboundWorkListener = (event: InboundMessageReceivedEvent) => void | Promise<void>;

export interface InboundWorkNotifier {
  subscribe(listener: InboundWorkListener): () => void;
  notify(event: InboundMessageReceivedEvent): Promise<void>;
}

export class InProcessInboundWorkNotifier extends EventEmitter implements InboundWorkNotifier {
  subscribe(listener: InboundWorkListener): () => void {
    this.on("inbound-work", listener);
    return () => this.off("inbound-work", listener);
  }

  async notify(event: InboundMessageReceivedEvent): Promise<void> {
    const listeners = this.listeners("inbound-work") as InboundWorkListener[];
    await Promise.all(listeners.map((listener) => listener(event)));
  }
}

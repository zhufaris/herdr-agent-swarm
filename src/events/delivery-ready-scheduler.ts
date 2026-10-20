import type { OutboundWorkClass } from "../domain/delivery.js";

export interface DeliveryReadyGrant { ringKey: string; workClass: OutboundWorkClass; readyAt: number }
export interface DeliveryReadySchedulerSnapshot { readyCount: number; activeCount: number }

export class DeliveryReadyScheduler {
  private readonly live: DeliveryReadyGrant[] = [];
  private readonly history: DeliveryReadyGrant[] = [];
  private readonly ready = new Set<string>();
  private readonly active = new Set<string>();
  private dispatchOrdinal = 0;

  constructor(private readonly permitLimit = 4) {}

  offer(ringKey: string, workClass: OutboundWorkClass, readyAt: number): boolean {
    if (this.ready.has(ringKey) || this.active.has(ringKey)) return false;
    this.queue(workClass).push({ ringKey, workClass, readyAt });
    this.ready.add(ringKey);
    return true;
  }

  claim(): DeliveryReadyGrant | null {
    if (this.active.size >= this.permitLimit) return null;
    const preferred = this.dispatchOrdinal % 4 === 3 ? this.history : this.live;
    const alternate = preferred === this.live ? this.history : this.live;
    const grant = preferred.shift() ?? alternate.shift() ?? null;
    if (!grant) return null;
    this.ready.delete(grant.ringKey);
    this.active.add(grant.ringKey);
    this.dispatchOrdinal += 1;
    return grant;
  }

  release(ringKey: string): void { this.active.delete(ringKey); }

  remove(ringKey: string): void {
    this.active.delete(ringKey);
    if (!this.ready.delete(ringKey)) return;
    removeKey(this.live, ringKey);
    removeKey(this.history, ringKey);
  }

  clear(): void { this.live.length = 0; this.history.length = 0; this.ready.clear(); this.active.clear(); }
  snapshot(): DeliveryReadySchedulerSnapshot { return { readyCount: this.ready.size, activeCount: this.active.size }; }

  private queue(workClass: OutboundWorkClass): DeliveryReadyGrant[] { return workClass === "live" ? this.live : this.history; }
}

function removeKey(queue: DeliveryReadyGrant[], ringKey: string): void {
  const index = queue.findIndex((entry) => entry.ringKey === ringKey);
  if (index >= 0) queue.splice(index, 1);
}

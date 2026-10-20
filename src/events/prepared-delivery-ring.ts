import type { DeliveryCacheSource } from "../domain/delivery-engine.js";
import type { DeliveryRingWork, PreparedDelivery } from "../domain/delivery.js";
import type { DeliveryScope } from "../domain/delivery-scope.js";
import { deliveryScopeKey } from "../domain/delivery-scope.js";

type RingOfferOutcome = "accepted" | "duplicate" | "overflow" | "oversized" | "stale";
interface RingOfferResult { outcome: RingOfferOutcome; retainedBytes: number }
interface RingHistoryInvalidationResult {
  removed: readonly PreparedDelivery[];
  releasedBytes: number;
  readyTokenStale: boolean;
}

interface CachedDelivery<TDelivery extends DeliveryRingWork> { delivery: TDelivery; source: DeliveryCacheSource; enqueuedAt: number }
interface RingRemovalResult<TDelivery extends DeliveryRingWork> { removed: readonly TDelivery[]; releasedBytes: number }

interface PreparedDeliveryRingSnapshot {
  itemCount: number;
  cachedBytes: number;
  dirty: boolean;
  overflowed: boolean;
  readyToken: boolean;
  activeGrant: boolean;
  lastTouchedAt: number;
}

export class PreparedDeliveryRing<TDelivery extends DeliveryRingWork = PreparedDelivery> {
  readonly key: string;
  private readonly queue: CachedDelivery<TDelivery>[] = [];
  private readonly byReplyId = new Map<string, CachedDelivery<TDelivery>>();
  private bytes = 0;
  private dirty = false;
  private overflowed = false;
  private readyToken = false;
  private activeGrant = false;
  private observedHeadId: string | null = null;
  private revisionValue = 0;
  private lastTouchedAt: number;

  constructor(readonly scope: DeliveryScope, private readonly limits: { itemLimit: number; byteLimit: number }, now: number) {
    this.key = deliveryScopeKey(scope);
    this.lastTouchedAt = now;
  }

  get revision(): number { return this.revisionValue; }
  get itemCount(): number { return this.queue.length; }
  get cachedBytes(): number { return this.bytes; }
  get isEmpty(): boolean { return this.queue.length === 0; }
  get hasReadyToken(): boolean { return this.readyToken; }
  get hasActiveGrant(): boolean { return this.activeGrant; }
  get touchedAt(): number { return this.lastTouchedAt; }

  hasReplyId(replyId: string): boolean { return this.byReplyId.has(replyId); }

  offer(delivery: TDelivery, source: DeliveryCacheSource, now: number): RingOfferResult {
    this.touch(now);
    if (deliveryScopeKey(delivery.scope) !== this.key) return this.rejectStale();
    const duplicate = this.byReplyId.get(delivery.replyId);
    if (duplicate) {
      if (sameIdentity(duplicate.delivery, delivery)) return { outcome: "duplicate", retainedBytes: 0 };
      return this.rejectStale();
    }
    const tail = this.queue.at(-1)?.delivery;
    if (tail && delivery.deliveryOrder <= tail.deliveryOrder) return this.rejectStale();
    if (delivery.estimatedBytes > this.limits.byteLimit) {
      this.markOverflow(now);
      return { outcome: "oversized", retainedBytes: 0 };
    }
    if (this.queue.length >= this.limits.itemLimit || this.bytes + delivery.estimatedBytes > this.limits.byteLimit) {
      this.markOverflow(now);
      return { outcome: "overflow", retainedBytes: 0 };
    }
    const cached = { delivery, source, enqueuedAt: now };
    this.queue.push(cached);
    this.byReplyId.set(delivery.replyId, cached);
    this.bytes += delivery.estimatedBytes;
    this.revisionValue += 1;
    return { outcome: "accepted", retainedBytes: delivery.estimatedBytes };
  }

  head(): TDelivery | null { return this.queue[0]?.delivery ?? null; }
  headEntry(): Readonly<CachedDelivery<TDelivery>> | null { return this.queue[0] ?? null; }
  items(): readonly TDelivery[] { return this.queue.map((item) => item.delivery); }

  invalidateSupersededHistory(live: TDelivery, now: number): RingHistoryInvalidationResult {
    const preparedLive = asPreparedDelivery(live);
    const target = preparedLive ? replaceableSnapshotTarget(preparedLive) : null;
    if (!preparedLive || live.workClass !== "live" || !target || live.priorCheckpoints.length > 0) return noInvalidation();
    const retained: CachedDelivery<TDelivery>[] = [];
    const removed: PreparedDelivery[] = [];
    let releasedBytes = 0;
    let removedHead = false;
    for (let index = 0; index < this.queue.length; index += 1) {
      const cached = this.queue[index]!;
      if (index === 0 && this.activeGrant) {
        retained.push(cached);
        continue;
      }
      const historical = asPreparedDelivery(cached.delivery);
      if (!historical || !isSupersededHistoryReference(cached, preparedLive, target)) {
        retained.push(cached);
        continue;
      }
      this.byReplyId.delete(cached.delivery.replyId);
      releasedBytes += cached.delivery.estimatedBytes;
      removed.push(historical);
      removedHead ||= index === 0;
    }
    if (removed.length === 0) return noInvalidation();
    this.queue.length = 0;
    this.queue.push(...retained);
    this.bytes -= releasedBytes;
    const readyTokenStale = removedHead && this.readyToken;
    if (removedHead) {
      this.readyToken = false;
      this.observedHeadId = null;
    }
    this.dirty = true;
    this.revisionValue += 1;
    this.touch(now);
    return { removed, releasedBytes, readyTokenStale };
  }

  removeHead(now = this.lastTouchedAt): TDelivery | null {
    const cached = this.queue.shift();
    if (!cached) return null;
    this.byReplyId.delete(cached.delivery.replyId);
    this.bytes -= cached.delivery.estimatedBytes;
    this.observedHeadId = null;
    this.readyToken = false;
    this.revisionValue += 1;
    this.touch(now);
    return cached.delivery;
  }

  removeAll(now = this.lastTouchedAt): RingRemovalResult<TDelivery> {
    const removed = this.queue.map((cached) => cached.delivery);
    const releasedBytes = this.bytes;
    this.queue.length = 0;
    this.byReplyId.clear();
    this.bytes = 0;
    this.observedHeadId = null;
    this.readyToken = false;
    if (removed.length > 0) {
      this.revisionValue += 1;
      this.touch(now);
    }
    return { removed, releasedBytes };
  }

  isRunnable(now: number): boolean {
    const head = this.head();
    return head !== null && this.observedHeadId !== head.replyId && Date.parse(head.nextAttemptAt) <= now;
  }

  markReadyToken(now: number): boolean {
    this.touch(now);
    if (this.readyToken || this.activeGrant || !this.isRunnable(now)) return false;
    this.readyToken = true;
    return true;
  }

  beginGrant(now: number): void { this.readyToken = false; this.activeGrant = true; this.touch(now); }
  finishGrant(now: number): void { this.activeGrant = false; this.touch(now); }
  finishShadowGrant(now: number): void {
    this.finishGrant(now);
    this.observedHeadId = this.head()?.replyId ?? null;
  }

  markOverflow(now: number): void { this.overflowed = true; this.dirty = true; this.revisionValue += 1; this.touch(now); }

  snapshot(): PreparedDeliveryRingSnapshot {
    return { itemCount: this.queue.length, cachedBytes: this.bytes, dirty: this.dirty, overflowed: this.overflowed, readyToken: this.readyToken, activeGrant: this.activeGrant, lastTouchedAt: this.lastTouchedAt };
  }

  private rejectStale(): RingOfferResult { this.dirty = true; this.revisionValue += 1; return { outcome: "stale", retainedBytes: 0 }; }
  private touch(now: number): void { this.lastTouchedAt = now; }
}

function sameIdentity(left: DeliveryRingWork, right: DeliveryRingWork): boolean {
  const leftIdentity = "planHash" in left ? left.planHash : left.input.snapshotHash;
  const rightIdentity = "planHash" in right ? right.planHash : right.input.snapshotHash;
  return left.deliveryOrder === right.deliveryOrder && leftIdentity === rightIdentity
    && left.snapshotRevision === right.snapshotRevision && deliveryScopeKey(left.scope) === deliveryScopeKey(right.scope);
}

function isSupersededHistoryReference<TDelivery extends DeliveryRingWork>(cached: CachedDelivery<TDelivery>, live: PreparedDelivery, target: { projectionKey: string; rootMessageId: string }): boolean {
  const historical = asPreparedDelivery(cached.delivery);
  if (!historical) return false;
  const historicalTarget = replaceableSnapshotTarget(historical);
  return cached.source === "cold" && historical.workClass === "history" && historical.priorCheckpoints.length === 0
    && historicalTarget !== null && deliveryScopeKey(historical.scope) === deliveryScopeKey(live.scope)
    && historical.conflictKey === live.conflictKey && historicalTarget.projectionKey === target.projectionKey
    && historicalTarget.rootMessageId === target.rootMessageId && historical.snapshotRevision < live.snapshotRevision;
}

function replaceableSnapshotTarget(delivery: PreparedDelivery): { projectionKey: string; rootMessageId: string } | null {
  const intent = delivery.preparedPlan.intent as Record<string, unknown>;
  if (delivery.preparedPlan.operation !== "surface.replace" || intent.kind !== "surface.replace" || delivery.projectionKey === null) return null;
  return typeof intent.messageId === "string" && intent.messageId.length > 0
    ? { projectionKey: delivery.projectionKey, rootMessageId: intent.messageId }
    : null;
}

function asPreparedDelivery(delivery: DeliveryRingWork): PreparedDelivery | null {
  return "preparedPlan" in delivery ? delivery : null;
}

function noInvalidation(): RingHistoryInvalidationResult { return { removed: [], releasedBytes: 0, readyTokenStale: false }; }

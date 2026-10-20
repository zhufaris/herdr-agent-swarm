import { describe, expect, it } from "vitest";
import type { DeliveryRingWork, PreparedDelivery, SemanticDeliveryWork } from "../src/domain/delivery.js";
import { PreparedDeliveryRing } from "../src/events/prepared-delivery-ring.js";

function delivery(id: string, order: number, estimatedBytes = 10): PreparedDelivery {
  return Object.freeze({
    replyId: id, scope: { kind: "pane", workspaceId: "workspace", paneId: "pane" }, ownerFence: { kind: "primary", id: "binding", generation: 1, sessionGeneration: 1 },
    deliveryOrder: order, workClass: "live", idempotencyKey: id, gatewayId: "gateway", gatewayProfileId: "profile",
    preparedPlan: { protocolVersion: 1, gatewayId: "gateway", profileId: "profile", rendererRevision: 1, operation: "message.reply.text", intent: { kind: "message.reply.text", rootMessageId: "root", text: id } },
    planHash: `hash-${id}`, projectionKey: null, snapshotRevision: 1, rendererRevision: 1, cardSequence: null,
    priorCheckpoints: [], nextAttemptAt: "2026-10-06T00:00:00.000Z", estimatedBytes
  });
}

function semanticDelivery(id: string, order: number): SemanticDeliveryWork {
  return Object.freeze({
    replyId: id, scope: { kind: "pane", workspaceId: "workspace", paneId: "pane" }, ownerFence: { kind: "primary", id: "binding", generation: 1, sessionGeneration: 1 },
    deliveryOrder: order, workClass: "live", idempotencyKey: id, gatewayId: "gateway", gatewayProfileId: "profile",
    conflictKey: `conflict-${id}`, projectionKey: "turn-card:segment:page:0", snapshotRevision: 2,
    priorCheckpoints: [], nextAttemptAt: "2026-10-06T00:00:00.000Z", estimatedBytes: 12,
    input: { kind: "semantic-snapshot", subject: { kind: "conversation-page", segmentId: "segment", pageIndex: 0, revision: 2 }, snapshot: { schemaVersion: 1, kind: "conversation-turn-card" }, snapshotHash: `hash-${id}`, plannerPolicyVersion: 1, rendererPolicyVersion: 1, gatewayProfileVersion: 1 },
    preparationState: "reserved"
  });
}

function replaceableSnapshot(id: string, order: number, options: {
  workClass?: "live" | "history";
  conflictKey?: string;
  projectionKey?: string;
  rootMessageId?: string;
  snapshotRevision?: number;
  estimatedBytes?: number;
} = {}): PreparedDelivery {
  const rootMessageId = options.rootMessageId ?? "root";
  return Object.freeze({
    ...delivery(id, order, options.estimatedBytes ?? 10),
    workClass: options.workClass ?? "history",
    conflictKey: options.conflictKey ?? "conflict",
    projectionKey: options.projectionKey ?? "projection",
    snapshotRevision: options.snapshotRevision ?? 1,
    preparedPlan: {
      protocolVersion: 1, gatewayId: "gateway", profileId: "profile", rendererRevision: 1,
      operation: "surface.replace", intent: { kind: "surface.replace", purpose: "primary-main", messageId: rootMessageId, view: { schemaVersion: 1, nodes: [] } }
    }
  });
}

function streamDelivery(id: string, order: number, kind: "stream.create" | "stream.append" | "stream.finish"): PreparedDelivery {
  const intent = kind === "stream.create"
    ? { kind, purpose: "primary-answer", rootMessageId: "root", view: { schemaVersion: 1, nodes: [] }, idempotencyKey: id }
    : kind === "stream.append"
      ? { kind, purpose: "primary-answer", surfaceId: "surface", slot: "slot", content: id, sequence: order }
      : { kind, purpose: "primary-answer", surfaceId: "surface", sequence: order, summary: id };
  return Object.freeze({
    ...delivery(id, order), workClass: "history", conflictKey: "conflict", projectionKey: "projection",
    preparedPlan: { protocolVersion: 1, gatewayId: "gateway", profileId: "profile", rendererRevision: 1, operation: kind, intent }
  });
}

describe("PreparedDeliveryRing", () => {
  it("keeps prepared and semantic work in one durable scope order", () => {
    const ring = new PreparedDeliveryRing<DeliveryRingWork>(delivery("legacy", 1).scope, { itemLimit: 32, byteLimit: 1024 }, 0);
    expect(ring.offer(delivery("legacy", 1), "cold", 1).outcome).toBe("accepted");
    expect(ring.offer(semanticDelivery("semantic", 2), "commit", 2).outcome).toBe("accepted");
    expect(ring.items().map(({ replyId }) => replyId)).toEqual(["legacy", "semantic"]);
  });

  it("enforces independent item and byte limits without mutating accepted work", () => {
    const ring = new PreparedDeliveryRing(delivery("seed", 1).scope, { itemLimit: 2, byteLimit: 20 }, 0);
    expect(ring.offer(delivery("one", 1), "commit", 1).outcome).toBe("accepted");
    expect(ring.offer(delivery("two", 2), "commit", 2).outcome).toBe("accepted");
    expect(ring.offer(delivery("three", 3), "commit", 3).outcome).toBe("overflow");
    expect(ring.snapshot()).toMatchObject({ itemCount: 2, cachedBytes: 20, overflowed: true, dirty: true });
    expect(ring.head()?.replyId).toBe("one");
  });

  it("treats exact duplicates as harmless and conflicting duplicates as dirty", () => {
    const ring = new PreparedDeliveryRing(delivery("one", 1).scope, { itemLimit: 32, byteLimit: 1024 }, 0);
    expect(ring.hasReplyId("one")).toBe(false);
    expect(ring.offer(delivery("one", 1), "commit", 1).outcome).toBe("accepted");
    expect(ring.hasReplyId("one")).toBe(true);
    expect(ring.offer(delivery("one", 1), "cold", 2).outcome).toBe("duplicate");
    expect(ring.offer({ ...delivery("one", 1), planHash: "different" }, "cold", 3).outcome).toBe("stale");
    expect(ring.snapshot()).toMatchObject({ itemCount: 1, dirty: true });
  });

  it("refuses reversed distinct arrivals instead of sorting around durable FIFO", () => {
    const ring = new PreparedDeliveryRing(delivery("first", 10).scope, { itemLimit: 32, byteLimit: 1024 }, 0);
    expect(ring.offer(delivery("later", 20), "commit", 1).outcome).toBe("accepted");
    expect(ring.offer(delivery("earlier", 10), "cold", 2).outcome).toBe("stale");
    expect(ring.items().map((item) => item.replyId)).toEqual(["later"]);
    expect(ring.snapshot().dirty).toBe(true);
  });

  it("accounts bytes exactly once when a cached head is removed", () => {
    const ring = new PreparedDeliveryRing(delivery("one", 1).scope, { itemLimit: 32, byteLimit: 1024 }, 0);
    ring.offer(delivery("one", 1, 17), "commit", 1);
    ring.offer(delivery("two", 2, 23), "commit", 2);
    expect(ring.removeHead()?.replyId).toBe("one");
    expect(ring.snapshot()).toMatchObject({ itemCount: 1, cachedBytes: 23 });
    expect(ring.removeHead()?.replyId).toBe("two");
    expect(ring.snapshot()).toMatchObject({ itemCount: 0, cachedBytes: 0 });
  });

  it("removes all cached work in one operation with exact released bytes", () => {
    const at = Date.parse("2026-10-06T00:00:00.000Z");
    const ring = new PreparedDeliveryRing(delivery("one", 1).scope, { itemLimit: 32, byteLimit: 1024 }, at);
    const one = delivery("one", 1, 17);
    const two = delivery("two", 2, 23);
    ring.offer(one, "commit", at);
    ring.offer(two, "commit", at);
    expect(ring.markReadyToken(at)).toBe(true);

    expect(ring.removeAll(at + 1)).toEqual({ removed: [one, two], releasedBytes: 40 });
    expect(ring.snapshot()).toMatchObject({ itemCount: 0, cachedBytes: 0, readyToken: false });
    expect(ring.hasReplyId("one")).toBe(false);
    expect(ring.hasReplyId("two")).toBe(false);
  });

  it("changes its revision when overflow dirties an otherwise empty Ring", () => {
    const ring = new PreparedDeliveryRing(delivery("large", 1).scope, { itemLimit: 32, byteLimit: 5 }, 0);
    const revision = ring.revision;
    expect(ring.offer(delivery("large", 1, 6), "commit", 1).outcome).toBe("oversized");
    expect(ring.revision).toBeGreaterThan(revision);
  });

  it("invalidates only a lower-revision historical snapshot for the same replaceable target", () => {
    const at = Date.parse("2026-10-06T00:00:00.000Z");
    const history = replaceableSnapshot("history", 1, { snapshotRevision: 1, estimatedBytes: 17 });
    const live = replaceableSnapshot("live", 2, { workClass: "live", snapshotRevision: 2, estimatedBytes: 23 });
    const ring = new PreparedDeliveryRing(history.scope, { itemLimit: 32, byteLimit: 1024 }, at);
    ring.offer(history, "cold", at);
    const revision = ring.revision;

    expect(ring.invalidateSupersededHistory(live, at + 1)).toEqual({ removed: [history], releasedBytes: 17, readyTokenStale: false });
    expect(ring.snapshot()).toMatchObject({ itemCount: 0, cachedBytes: 0, dirty: true });
    expect(ring.revision).toBeGreaterThan(revision);
  });

  it("retains snapshots when conflict, projection, or root target differs", () => {
    const at = Date.parse("2026-10-06T00:00:00.000Z");
    const base = replaceableSnapshot("base", 1, { snapshotRevision: 1 });
    const ring = new PreparedDeliveryRing(base.scope, { itemLimit: 32, byteLimit: 1024 }, at);
    const candidates = [
      replaceableSnapshot("other-conflict", 1, { conflictKey: "other", snapshotRevision: 1 }),
      replaceableSnapshot("other-projection", 1, { projectionKey: "other", snapshotRevision: 1 }),
      replaceableSnapshot("other-root", 1, { rootMessageId: "other", snapshotRevision: 1 })
    ];

    for (const candidate of candidates) {
      ring.offer(candidate, "cold", at);
      const live = replaceableSnapshot(`live-${candidate.replyId}`, 2, { workClass: "live", snapshotRevision: 2 });
      expect(ring.invalidateSupersededHistory(live, at + 1)).toEqual({ removed: [], releasedBytes: 0, readyTokenStale: false });
      expect(ring.items()).toEqual([candidate]);
      ring.removeHead(at + 2);
    }
  });

  it("retains an active historical snapshot, refreshes only a stale ready token, and never discards stream FIFO entries", () => {
    const at = Date.parse("2026-10-06T00:00:00.000Z");
    const active = replaceableSnapshot("active", 1, { snapshotRevision: 1 });
    const live = replaceableSnapshot("live", 4, { workClass: "live", snapshotRevision: 2 });
    const activeRing = new PreparedDeliveryRing(active.scope, { itemLimit: 32, byteLimit: 1024 }, at);
    activeRing.offer(active, "cold", at);
    expect(activeRing.markReadyToken(at)).toBe(true);
    activeRing.beginGrant(at);
    expect(activeRing.invalidateSupersededHistory(live, at + 1)).toEqual({ removed: [], releasedBytes: 0, readyTokenStale: false });
    expect(activeRing.items()).toEqual([active]);

    const readyRing = new PreparedDeliveryRing(active.scope, { itemLimit: 32, byteLimit: 1024 }, at);
    readyRing.offer(active, "cold", at);
    expect(readyRing.markReadyToken(at)).toBe(true);
    expect(readyRing.invalidateSupersededHistory(live, at + 1)).toEqual({ removed: [active], releasedBytes: 10, readyTokenStale: true });
    expect(readyRing.hasReadyToken).toBe(false);

    const streamRing = new PreparedDeliveryRing(active.scope, { itemLimit: 32, byteLimit: 1024 }, at);
    const stream = [streamDelivery("create", 1, "stream.create"), streamDelivery("content", 2, "stream.append"), streamDelivery("finish", 3, "stream.finish")];
    for (const item of stream) streamRing.offer(item, "cold", at);
    expect(streamRing.invalidateSupersededHistory(live, at + 1)).toEqual({ removed: [], releasedBytes: 0, readyTokenStale: false });
    expect(streamRing.items().map((item) => item.replyId)).toEqual(["create", "content", "finish"]);
  });

  it("invalidates alternating historical snapshots in one stable ordered partition", () => {
    const at = Date.parse("2026-10-06T00:00:00.000Z");
    const entries = [
      replaceableSnapshot("keep-1", 1, { conflictKey: "other", snapshotRevision: 1, estimatedBytes: 3 }),
      replaceableSnapshot("drop-1", 2, { snapshotRevision: 1, estimatedBytes: 5 }),
      replaceableSnapshot("keep-2", 3, { rootMessageId: "other", snapshotRevision: 1, estimatedBytes: 7 }),
      replaceableSnapshot("drop-2", 4, { snapshotRevision: 2, estimatedBytes: 11 }),
      replaceableSnapshot("keep-3", 5, { projectionKey: "other", snapshotRevision: 1, estimatedBytes: 13 }),
      replaceableSnapshot("drop-3", 6, { snapshotRevision: 1, estimatedBytes: 17 })
    ];
    const live = replaceableSnapshot("live", 7, { workClass: "live", snapshotRevision: 3 });
    const ring = new PreparedDeliveryRing(entries[0]!.scope, { itemLimit: 32, byteLimit: 1024 }, at);
    for (const entry of entries) ring.offer(entry, "cold", at);

    expect(ring.invalidateSupersededHistory(live, at + 1)).toEqual({
      removed: [entries[1], entries[3], entries[5]],
      releasedBytes: 33,
      readyTokenStale: false
    });
    expect(ring.items().map(({ replyId }) => replyId)).toEqual(["keep-1", "keep-2", "keep-3"]);
    expect(ring.cachedBytes).toBe(23);
  });
});

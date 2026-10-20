import { randomUUID } from "node:crypto";
import type { PreparedDeliveryConsumer, PreparedDeliveryReceipt, PreparedDeliveryReservation } from "../../domain/ports/outbox.js";
import type { SqliteContext } from "./context.js";
import type { SqliteOutboxQueueStore } from "./outbox-queue-store.js";

/**
 * Owns the one durable group-root navigation card for a configured chat.
 * It is intentionally not a Binding, Worker, or thread alias: none of those
 * lifecycles may be used as a surrogate identity for a global entry card.
 */
export class SqliteShortcutPanelStore {
  private preparedDeliveryReservation: PreparedDeliveryReservation | null = null;
  private preparedDeliveryConsumer: PreparedDeliveryConsumer | null = null;

  constructor(private readonly context: SqliteContext, private readonly queue: SqliteOutboxQueueStore) {}

  setPreparedDeliveryReservation(reservation: PreparedDeliveryReservation, consumer: PreparedDeliveryConsumer): void {
    this.preparedDeliveryReservation = reservation;
    this.preparedDeliveryConsumer = consumer;
  }

  reserve(chatId: string, card: object): "reserved" | "current" | "pending" {
    return this.context.transaction("sqlite.shortcut-panel-store.write", () => {
      const current = this.context.database.prepare("SELECT id, state FROM shortcut_panels WHERE chat_id = ?").get(chatId) as { id: string; state: "reserving" | "active" | "stale" } | undefined;
      if (current?.state === "active") return "current";
      if (current?.state === "reserving") {
        // A group-card create is externally visible.  Never create a second
        // one unless Lark explicitly rejected the first attempt.  A timeout or
        // unknown outcome remains pending for operator inspection.
        const latest = this.context.database.prepare("SELECT id, lane_key, state, effect_certainty FROM outbound_replies WHERE shortcut_panel_id = ? ORDER BY created_at DESC LIMIT 1").get(current.id) as { id: string; lane_key: string; state: string; effect_certainty: string | null } | undefined;
        if (latest?.state === "pending") {
          // A previous release may have created the corrected successor before
          // this recovery existed.  It remains safe to release that lane only
          // when its quarantined predecessor was explicitly rejected.
          const blocked = this.context.database.prepare(`
            SELECT failed.id, failed.lane_key FROM outbox_lane_quarantines quarantine
            JOIN outbound_replies failed ON failed.id = quarantine.failed_reply_id
            WHERE quarantine.lane_key = ? AND quarantine.state = 'active'
              AND failed.state = 'dead_letter' AND failed.effect_certainty = 'rejected'
            LIMIT 1
          `).get(latest.lane_key) as { id: string; lane_key: string } | undefined;
          if (blocked) this.releaseRejectedLane(blocked);
          return "pending";
        }
        if (latest?.state !== "dead_letter" || latest.effect_certainty !== "rejected") return "pending";
        // The rejected immutable create quarantined its lane.  This is a new,
        // corrected snapshot, so release only that exact rejected predecessor
        // before queuing the replacement.  Unknown effects never take this
        // path and remain fenced above.
        this.releaseRejectedLane(latest);
      }
      const timestamp = now();
      const id = current?.id ?? randomUUID();
      if (current) this.context.database.prepare("UPDATE shortcut_panels SET state = 'reserving', topic_id = NULL, root_message_id = NULL, card_id = NULL, activated_at = NULL, updated_at = ? WHERE id = ?").run(timestamp, id);
      else this.context.database.prepare("INSERT INTO shortcut_panels(id, chat_id, state, created_at, updated_at) VALUES (?, ?, 'reserving', ?, ?)").run(id, chatId, timestamp, timestamp);
      // A stale delivery may already have a terminal outbox row.  The panel
      // identity stays stable, while this reservation gets a fresh immutable
      // delivery key; active/reserving rows return before reaching this point.
      const outbound = { id: randomUUID(), idempotencyKey: `shortcut-panel:${chatId}:${id}:${timestamp}`, bindingId: null, shortcutPanelId: id, targetChatId: chatId, rootMessageId: null, kind: "group_card_create" as const, payload: JSON.stringify(card), laneKeyOverride: `shortcut-panel:${chatId}`, globalDelivery: true as const };
      if (!this.preparedDeliveryReservation || !this.preparedDeliveryConsumer) throw new Error("Shortcut Panel prepared delivery is not connected");
      this.handoffAfterCommit(this.preparedDeliveryReservation.reservePreparedOutboundReply(outbound));
      return "reserved";
    });
  }

  private handoffAfterCommit(receipt: PreparedDeliveryReceipt): void {
    queueMicrotask(() => { for (const delivery of receipt.consumeEffects()) this.preparedDeliveryConsumer!.enqueuePreparedDelivery(delivery); });
  }

  private releaseRejectedLane(reply: { id: string; lane_key: string }): void {
    const timestamp = now();
    const released = this.context.database.prepare("UPDATE outbox_lane_quarantines SET state = 'released', action = 'released_newer_snapshot', released_at = ?, updated_at = ? WHERE lane_key = ? AND failed_reply_id = ? AND state = 'active'").run(timestamp, timestamp, reply.lane_key, reply.id);
    if (released.changes === 1) this.queue.notifyScopeMutation(reply.lane_key);
  }
}

function now(): string { return new Date().toISOString(); }

import { describe, expect, it } from "vitest";
import { renderDeliveryQuarantineReview } from "../src/cards/delivery-quarantine-review.js";

describe("Delivery quarantine Human Review card", () => {
  it("mentions the owner without exposing payload and omits retry for uncertain effects", () => {
    const card = renderDeliveryQuarantineReview({
      failedReplyId: "reply-secret",
      replyKind: "card_reply",
      failureClass: "unknown",
      effectCertainty: "uncertain",
      reason: "timeout Authorization: Bearer hidden-token",
      scopeLabel: "Primary pane pane-a",
      creatorOpenId: "ou_owner",
      retryAllowed: false,
    });
    const encoded = JSON.stringify(card);

    expect(encoded).toContain("<at id=ou_owner></at>");
    expect(encoded).toContain("需要人工复核");
    expect(encoded).not.toContain("hidden-token");
    expect(encoded).not.toContain("retry_dead_letter");
    expect(encoded).toContain("dismiss_dead_letter");
  });

  it("offers retry only when durable replay-safety evidence allows it", () => {
    const card = renderDeliveryQuarantineReview({
      failedReplyId: "reply-safe",
      replyKind: "card_update",
      failureClass: "permanent",
      effectCertainty: "rejected",
      reason: "provider rejected the request",
      scopeLabel: "Primary pane pane-a",
      creatorOpenId: null,
      retryAllowed: true,
    });

    expect(JSON.stringify(card)).toContain("retry_dead_letter");
  });
});

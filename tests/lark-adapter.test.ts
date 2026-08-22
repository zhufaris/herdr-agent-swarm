import { describe, expect, it } from "vitest";
import { normalizeCardActionEvent, normalizeMessage } from "../src/adapters/lark-adapter.js";

describe("Lark message normalization", () => {
  const base = {
    event_id: "e1", sender: { sender_type: "user", sender_id: { open_id: "user" } },
    message: { message_id: "m1", create_time: "0", chat_id: "chat", chat_type: "group", message_type: "text",
      content: JSON.stringify({ text: "@_user_1 fix this" }), mentions: [{ key: "@_user_1", id: { open_id: "bot" }, name: "Bridge" }] }
  };

  it("recognizes and removes only the configured bot mention", () => {
    expect(normalizeMessage(base, "bot")).toMatchObject({ mentionsBot: true, text: "fix this" });
    expect(normalizeMessage(base, "someone-else")).toMatchObject({ mentionsBot: false, text: "@_user_1 fix this" });
  });

  it("maps a thread reply to its root binding without requiring a bot mention", () => {
    const reply = {
      ...base,
      event_id: "e2",
      message: { ...base.message, message_id: "m2", root_id: "root-1", thread_id: "thread-1", content: JSON.stringify({ text: "continue" }), mentions: [] }
    };

    expect(normalizeMessage(reply, "bot")).toMatchObject({
      messageId: "m2", rootMessageId: "root-1", topicId: "thread-1", text: "continue", mentionsBot: false, isRootMessage: false
    });
  });
});

describe("Lark card action normalization", () => {
  it("normalizes the current nested callback shape", () => {
    expect(normalizeCardActionEvent({
      context: { open_message_id: "om_1", open_chat_id: "oc_1" },
      operator: { open_id: "ou_1" },
      action: { tag: "button", value: { action: "select_project", selectionId: "s1", projectId: "bridge" } }
    })).toEqual({
      messageId: "om_1", chatId: "oc_1", operatorOpenId: "ou_1",
      value: { action: "select_project", selectionId: "s1", projectId: "bridge" }
    });
  });

  it("accepts top-level ids and rejects incomplete callbacks", () => {
    expect(normalizeCardActionEvent({
      open_message_id: "om_2", open_chat_id: "oc_2", operator: { open_id: "ou_2" }, action: { value: { action: "noop" } }
    })).toMatchObject({ messageId: "om_2", chatId: "oc_2", operatorOpenId: "ou_2" });
    expect(normalizeCardActionEvent({ context: {}, operator: {}, action: {} })).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { normalizeMessage } from "../src/adapters/lark-adapter.js";

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
});

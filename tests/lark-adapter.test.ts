import { beforeEach, describe, expect, it, vi } from "vitest";

const createMessage = vi.fn();
const replyMessage = vi.fn();
const getMessage = vi.fn();
const forwardThread = vi.fn();
const createCard = vi.fn();
const streamContent = vi.fn();
const updateSettings = vi.fn();
vi.mock("@larksuiteoapi/node-sdk", () => ({
  Client: class {
    im = { v1: { message: { create: createMessage, reply: replyMessage, get: getMessage }, thread: { forward: forwardThread } } };
    cardkit = { v1: { card: { create: createCard, settings: updateSettings }, cardElement: { content: streamContent } } };
  },
  WSClient: class { async start() {} close() {} },
  EventDispatcher: class { register() { return this; } }
}));

import { LarkSdkAdapter, normalizeCardActionEvent, normalizeMessage } from "../src/adapters/lark-adapter.js";

beforeEach(() => {
  createMessage.mockReset(); replyMessage.mockReset(); getMessage.mockReset(); forwardThread.mockReset();
  createCard.mockReset(); streamContent.mockReset(); updateSettings.mockReset();
});

describe("Lark streaming Answer cards", () => {
  it("creates a CardKit entity and replies with a card reference", async () => {
    createCard.mockResolvedValue({ data: { card_id: "card-1" } });
    replyMessage.mockResolvedValue({ data: { message_id: "answer-1" } });
    const adapter = new LarkSdkAdapter({ appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" });

    await expect(adapter.replyStreamingCard("root-1", { schema: "2.0", body: { elements: [{ element_id: "answer-content-p1-0" }] } })).resolves.toEqual({ messageId: "answer-1", cardId: "card-1" });
    expect(createCard).toHaveBeenCalledWith({ data: { type: "card_json", data: JSON.stringify({ schema: "2.0", body: { elements: [{ element_id: "answer_content_p1_0" }] } }) } });
    expect(replyMessage).toHaveBeenCalledWith({
      path: { message_id: "root-1" },
      data: { msg_type: "interactive", content: JSON.stringify({ type: "card", data: { card_id: "card-1" } }), reply_in_thread: true }
    });
  });

  it("reports safe CardKit response metadata when creation returns no card id", async () => {
    createCard.mockResolvedValue({
      code: 99991672,
      msg: "Access denied",
      data: { request_id: "req-1" },
      raw_token: "must-not-leak"
    });
    const adapter = new LarkSdkAdapter({ appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" });

    await expect(adapter.replyStreamingCard("root-1", { schema: "2.0" })).rejects.toThrow(
      'Lark CardKit create returned no card_id (code=99991672, msg="Access denied", dataKeys=[request_id], responseKeys=[code,data,msg,raw_token])'
    );
  });

  it("streams cumulative content and finalizes with monotonic sequences", async () => {
    streamContent.mockResolvedValue({}); updateSettings.mockResolvedValue({});
    const adapter = new LarkSdkAdapter({ appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" });

    await adapter.streamCardContent("card-1", "answer-content-p1", "one\ntwo", 4);
    await adapter.finishStreamingCard("card-1", 5, "Completed");

    expect(streamContent).toHaveBeenCalledWith({ path: { card_id: "card-1", element_id: "answer_content_p1" }, data: { content: "one\ntwo", sequence: 4, uuid: "stream-card-1-4" } });
    expect(updateSettings).toHaveBeenCalledWith({ path: { card_id: "card-1" }, data: { settings: JSON.stringify({ config: { streaming_mode: false, summary: { content: "Completed" } } }), sequence: 5, uuid: "finish-card-1-5" } });
  });
});

describe("Lark topic creation", () => {
  it("passes a stable idempotency key to message.create", async () => {
    createMessage.mockResolvedValue({ data: { message_id: "m-topic", thread_id: "omt-topic" } });
    const adapter = new LarkSdkAdapter({ appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" });

    await expect(adapter.createTopic({ schema: "2.0" }, "binding-1")).resolves.toEqual({ topicId: "omt-topic", rootMessageId: "m-topic" });
    expect(createMessage).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: "chat", msg_type: "interactive", content: JSON.stringify({ schema: "2.0" }), uuid: "binding-1" }
    });
  });
});

describe("Lark topic sharing", () => {
  it("resolves a root message to its thread and forwards the native topic card", async () => {
    getMessage.mockResolvedValue({ data: { items: [{ message_id: "om_root", thread_id: "omt_thread" }] } });
    forwardThread.mockResolvedValue({ data: { message_id: "om_forwarded" } });
    const adapter = new LarkSdkAdapter({ appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" });

    await expect(adapter.shareThread("om_root", "oc_target")).resolves.toEqual({ messageId: "om_forwarded" });
    expect(getMessage).toHaveBeenCalledWith({ path: { message_id: "om_root" } });
    expect(forwardThread).toHaveBeenCalledWith({
      path: { thread_id: "omt_thread" }, params: { receive_id_type: "chat_id" }, data: { receive_id: "oc_target" }
    });
  });

  it("forwards a persisted thread id without another lookup", async () => {
    forwardThread.mockResolvedValue({ data: { message_id: "om_forwarded" } });
    const adapter = new LarkSdkAdapter({ appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" });

    await adapter.shareThread("omt_thread", "oc_target");

    expect(getMessage).not.toHaveBeenCalled();
    expect(forwardThread).toHaveBeenCalledWith(expect.objectContaining({ path: { thread_id: "omt_thread" } }));
  });
});

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

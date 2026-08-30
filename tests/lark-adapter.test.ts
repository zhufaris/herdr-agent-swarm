import { beforeEach, describe, expect, it, vi } from "vitest";

const createMessage = vi.fn();
const replyMessage = vi.fn();
const patchMessage = vi.fn();
const getMessage = vi.fn();
const forwardThread = vi.fn();
const createCard = vi.fn();
const streamContent = vi.fn();
const updateSettings = vi.fn();
const updateCardEntity = vi.fn();
const convertCardId = vi.fn();
let clientOptions: Record<string, unknown> | undefined;
let registeredHandlers: Record<string, (data: unknown) => Promise<unknown>> = {};
vi.mock("@larksuiteoapi/node-sdk", () => ({
  Client: class {
    constructor(options: Record<string, unknown>) { clientOptions = options; }
    im = { v1: { message: { create: createMessage, reply: replyMessage, patch: patchMessage, get: getMessage }, thread: { forward: forwardThread } } };
    cardkit = { v1: { card: { create: createCard, settings: updateSettings, update: updateCardEntity, idConvert: convertCardId }, cardElement: { content: streamContent } } };
  },
  defaultHttpInstance: { request: vi.fn(), get: vi.fn(), delete: vi.fn(), head: vi.fn(), options: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn() },
  WSClient: class { async start() {} close() {} },
  EventDispatcher: class { register(handlers: Record<string, (data: unknown) => Promise<unknown>>) { registeredHandlers = handlers; return this; } }
}));

import { LarkSdkAdapter, normalizeCardActionEvent, normalizeMessage } from "../src/adapters/lark-adapter.js";

beforeEach(() => {
  createMessage.mockReset(); replyMessage.mockReset(); patchMessage.mockReset(); getMessage.mockReset(); forwardThread.mockReset();
  createCard.mockReset(); streamContent.mockReset(); updateSettings.mockReset(); updateCardEntity.mockReset(); convertCardId.mockReset();
  clientOptions = undefined;
  registeredHandlers = {};
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

  it("replies with a persisted CardKit reference and stable idempotency key", async () => {
    replyMessage.mockResolvedValue({ data: { message_id: "answer-1" } });
    const adapter = new LarkSdkAdapter({ appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot", requestTimeoutMs: 12_345 });
    const http = clientOptions?.httpInstance as { get: (url: string, options?: object) => Promise<unknown> };

    await expect(adapter.replyStreamingCardReference("root-1", "card-1", "outbox-1")).resolves.toEqual({ messageId: "answer-1" });
    expect(replyMessage).toHaveBeenCalledWith({
      path: { message_id: "root-1" },
      data: { msg_type: "interactive", content: JSON.stringify({ type: "card", data: { card_id: "card-1" } }), reply_in_thread: true, uuid: "outbox-1" }
    });
    await http.get("/probe", { headers: { test: "yes" } });
    const sdk = await import("@larksuiteoapi/node-sdk");
    expect(sdk.defaultHttpInstance.get).toHaveBeenCalledWith("/probe", { headers: { test: "yes" }, timeout: 12_345 });
  });

  it("maps long durable keys to stable Lark UUIDs within the API limit", async () => {
    replyMessage.mockResolvedValue({ data: { message_id: "answer-1" } });
    const adapter = new LarkSdkAdapter({ appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" });
    const durableKey = "project-selection:create:211c0d79-ca14-47a8-b2fc-e2fe995f5480";

    await adapter.replyCard("root-1", { schema: "2.0" }, durableKey);
    await adapter.replyCard("root-1", { schema: "2.0" }, durableKey);

    const firstUuid = replyMessage.mock.calls[0]?.[0].data.uuid as string;
    const secondUuid = replyMessage.mock.calls[1]?.[0].data.uuid as string;
    expect(firstUuid).toBe(secondUuid);
    expect(firstUuid).toMatch(/^bridge_[a-f0-9]{40}$/);
    expect(firstUuid.length).toBeLessThanOrEqual(50);
    expect(firstUuid).not.toBe(durableKey);
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

  it("finalizes a completed streaming card through settings without replacing its card tree", async () => {
    updateSettings.mockResolvedValue({});
    const adapter = new LarkSdkAdapter({ appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" });

    await adapter.finishStreamingCard("card-1", 5, "Completed");

    expect(updateSettings).toHaveBeenCalledWith({ path: { card_id: "card-1" }, data: { settings: JSON.stringify({ config: { streaming_mode: false, summary: { content: "Completed" } } }), sequence: 5, uuid: "finish-card-1-5" } });
    expect(updateCardEntity).not.toHaveBeenCalled();
  });

  it("normalizes element ids when replying with or updating a non-CardKit card", async () => {
    replyMessage.mockResolvedValue({ data: { message_id: "answer-1" } });
    patchMessage.mockResolvedValue({});
    const adapter = new LarkSdkAdapter({ appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" });
    const card = { schema: "2.0", body: { elements: [{ element_id: "answer_content_legacy_identifier_that_is_too_long_0" }] } };

    await adapter.replyCard("root-1", card);
    await adapter.updateCard("answer-1", card);

    const normalized = { schema: "2.0", body: { elements: [{ element_id: "element_e8aa1ef57445" }] } };
    expect(replyMessage).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ content: JSON.stringify(normalized) }) }));
    expect(patchMessage).toHaveBeenCalledWith({ path: { message_id: "answer-1" }, data: { content: JSON.stringify(normalized) } });
  });

  it("updates a Main Card through its CardKit entity with a monotonic view sequence", async () => {
    convertCardId.mockResolvedValue({ code: 0, data: { card_id: "main-card-1" } });
    updateCardEntity.mockResolvedValue({ code: 0 });
    const adapter = new LarkSdkAdapter({ appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" });
    const card = { schema: "2.0", body: { elements: [{ tag: "markdown", content: "最近活动" }] } };

    await adapter.updateCardKit("main-message-1", card, 42);

    expect(convertCardId).toHaveBeenCalledWith({ data: { message_id: "main-message-1" } });
    expect(updateCardEntity).toHaveBeenCalledWith({
      path: { card_id: "main-card-1" },
      data: { card: { type: "card_json", data: JSON.stringify(card) }, sequence: 42, uuid: "update-main-card-1-42" }
    });
    expect(patchMessage).not.toHaveBeenCalled();
  });

  it("evicts old message-to-card identities and reloads them from Lark", async () => {
    convertCardId.mockImplementation(async ({ data }: { data: { message_id: string } }) => ({ data: { card_id: `card-${data.message_id}` } }));
    updateCardEntity.mockResolvedValue({ code: 0 });
    const adapter = new LarkSdkAdapter({ appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot", cardIdCacheCapacity: 2 });

    await adapter.updateCardKit("m1", {}, 1);
    await adapter.updateCardKit("m2", {}, 1);
    await adapter.updateCardKit("m1", {}, 2);
    await adapter.updateCardKit("m3", {}, 1);
    await adapter.updateCardKit("m2", {}, 2);

    expect(convertCardId.mock.calls.map(([request]) => request.data.message_id)).toEqual(["m1", "m2", "m3", "m2"]);
  });

  it("retries an unsupported fenced language as a plain code fence", async () => {
    streamContent
      .mockRejectedValueOnce(new Error("unsupported markdown code fence language: bash"))
      .mockResolvedValueOnce({});
    const adapter = new LarkSdkAdapter({ appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" });

    await adapter.streamCardContent("card-1", "answer-content-p1", "```bash\necho ok\n```", 4);

    expect(streamContent).toHaveBeenCalledTimes(2);
    expect(streamContent).toHaveBeenLastCalledWith({
      path: { card_id: "card-1", element_id: "answer_content_p1" },
      data: { content: "```\necho ok\n```", sequence: 4, uuid: "stream-card-1-4" }
    });
  });

  it("does not alter content for unrelated CardKit failures", async () => {
    streamContent.mockRejectedValueOnce(new Error("network unavailable"));
    const adapter = new LarkSdkAdapter({ appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" });

    await expect(adapter.streamCardContent("card-1", "answer-content-p1", "```bash\necho ok\n```", 4)).rejects.toThrow("network unavailable");
    expect(streamContent).toHaveBeenCalledTimes(1);
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
    getMessage
      .mockResolvedValueOnce({ data: { items: [{ message_id: "om_root", thread_id: "omt_thread" }] } })
      .mockResolvedValueOnce({ data: { items: [{ message_id: "om_spaces", thread_id: "omt_spaces" }] } });
    forwardThread.mockResolvedValue({ data: { message_id: "om_forwarded" } });
    const adapter = new LarkSdkAdapter({ appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" });

    await expect(adapter.shareThread("om_root", { messageId: "om_spaces", chatId: "oc_target" })).resolves.toEqual({ messageId: "om_forwarded" });
    expect(getMessage).toHaveBeenCalledWith({ path: { message_id: "om_root" } });
    expect(getMessage).toHaveBeenNthCalledWith(1, { path: { message_id: "om_root" } });
    expect(getMessage).toHaveBeenNthCalledWith(2, { path: { message_id: "om_spaces" } });
    expect(forwardThread).toHaveBeenCalledWith({
      path: { thread_id: "omt_thread" }, params: { receive_id_type: "thread_id" }, data: { receive_id: "omt_spaces" }
    });
  });

  it("resolves source and target threads concurrently before forwarding", async () => {
    const release = new Map<string, () => void>();
    getMessage.mockImplementation((request: { path: { message_id: string } }) => new Promise((resolve) => {
      release.set(request.path.message_id, () => resolve({ data: { items: [{ thread_id: `omt-${request.path.message_id}` }] } }));
    }));
    forwardThread.mockResolvedValue({ data: { message_id: "om_forwarded" } });
    const adapter = new LarkSdkAdapter({ appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" });

    const shared = adapter.shareThread("om_root", { messageId: "om_spaces", chatId: "oc_target" });
    await vi.waitFor(() => expect(getMessage.mock.calls.map(([request]) => request.path.message_id).sort()).toEqual(["om_root", "om_spaces"]));
    release.get("om_root")!();
    release.get("om_spaces")!();

    await expect(shared).resolves.toEqual({ messageId: "om_forwarded" });
  });

  it("forwards a persisted thread id without another lookup", async () => {
    getMessage.mockResolvedValue({ data: { items: [{ message_id: "om_spaces", thread_id: "omt_spaces" }] } });
    forwardThread.mockResolvedValue({ data: { message_id: "om_forwarded" } });
    const adapter = new LarkSdkAdapter({ appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" });

    await adapter.shareThread("omt_thread", { messageId: "om_spaces", chatId: "oc_target" });

    expect(getMessage).toHaveBeenCalledWith({ path: { message_id: "om_spaces" } });
    expect(forwardThread).toHaveBeenCalledWith({
      path: { thread_id: "omt_thread" }, params: { receive_id_type: "thread_id" }, data: { receive_id: "omt_spaces" }
    });
  });

  it("does not forward a topic into itself", async () => {
    getMessage.mockResolvedValue({ data: { items: [{ message_id: "om_spaces", thread_id: "omt_thread" }] } });
    replyMessage.mockResolvedValue({ data: { message_id: "om_notice" } });
    const adapter = new LarkSdkAdapter({ appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" });

    await expect(adapter.shareThread("omt_thread", { messageId: "om_spaces", chatId: "oc_target" })).resolves.toEqual({ messageId: "om_notice" });

    expect(forwardThread).not.toHaveBeenCalled();
    expect(replyMessage).toHaveBeenCalledWith({
      path: { message_id: "om_spaces" },
      data: { msg_type: "text", content: JSON.stringify({ text: "当前已在该项目话题中。" }), reply_in_thread: true }
    });
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
      messageId: "m2", rootMessageId: "root-1", topicId: "thread-1", text: "continue", mentionsBot: false, isRootMessage: false,
      hasUnsupportedContent: false
    });
  });

  it("marks plain continuation post content as supported", () => {
    const post = {
      ...base,
      message: {
        ...base.message,
        message_type: "post",
        content: JSON.stringify({ content: [[{ tag: "text", text: "继续" }]] }),
        mentions: []
      }
    };

    expect(normalizeMessage(post, "bot")).toMatchObject({ text: "继续", hasUnsupportedContent: false });
  });

  it("marks a continuation post with a discarded rich-content node as unsupported", () => {
    const post = {
      ...base,
      message: {
        ...base.message,
        message_type: "post",
        content: JSON.stringify({ content: [[
          { tag: "text", text: "继续" },
          { tag: "img", image_key: "img-1" }
        ]] }),
        mentions: []
      }
    };

    expect(normalizeMessage(post, "bot")).toMatchObject({ text: "继续", hasUnsupportedContent: true });
  });

  it("normalizes a bare command from a topic-group post", () => {
    const post = {
      ...base,
      event_id: "e-post",
      message: {
        ...base.message,
        message_id: "m-post",
        message_type: "post",
        content: JSON.stringify({
          title: "",
          content: [[{ tag: "text", text: "/projects", style: [] }]],
          content_v2: [[{ tag: "text", text: "/projects", style: [] }]]
        }),
        mentions: []
      }
    };

    expect(normalizeMessage(post, "bot")).toMatchObject({
      messageId: "m-post", text: "/projects", mentionsBot: false, isRootMessage: true
    });
  });

  it("removes only the configured bot mention from a topic-group post", () => {
    const post = {
      ...base,
      event_id: "e-post-mention",
      message: {
        ...base.message,
        message_id: "m-post-mention",
        message_type: "post",
        content: JSON.stringify({
          title: "",
          content: [[
            { tag: "at", user_id: "@_user_1", user_name: "Bridge", style: [] },
            { tag: "text", text: " /projects", style: [] }
          ]]
        })
      }
    };

    expect(normalizeMessage(post, "bot")).toMatchObject({ text: "/projects", mentionsBot: true });
    expect(normalizeMessage(post, "someone-else")).toMatchObject({ text: "@_user_1 /projects", mentionsBot: false });
  });

  it("ignores malformed and non-text post content", () => {
    const post = { ...base, message: { ...base.message, message_type: "post", mentions: [] } };

    expect(normalizeMessage({ ...post, message: { ...post.message, content: "not-json" } }, "bot")).toBeNull();
    expect(normalizeMessage({
      ...post,
      message: { ...post.message, content: JSON.stringify({ content: [[{ tag: "img", image_key: "img-1" }]] }) }
    }, "bot")).toBeNull();
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

  it("preserves the selected static option", () => {
    expect(normalizeCardActionEvent({
      context: { open_message_id: "om_model", open_chat_id: "oc_1" }, operator: { open_id: "ou_1" },
      action: { tag: "select_static", option: "GPT-5.6-Terra", value: { action: "select_model", bindingId: "binding-1" } }
    })).toMatchObject({
      messageId: "om_model", option: "GPT-5.6-Terra", value: { action: "select_model", bindingId: "binding-1" }
    });
  });

  it("normalizes string form values and drops non-string input", () => {
    expect(normalizeCardActionEvent({
      context: { open_message_id: "om_form", open_chat_id: "oc_1" }, operator: { open_id: "ou_1" },
      action: { tag: "button", value: { action: "submit_supplement" }, form_value: { supplement: "add tests", ignored: { secret: true } } }
    } as never)).toMatchObject({ formValues: { supplement: "add tests" } });
  });

  it("wraps callback replacement cards in the CardKit raw response envelope", async () => {
    const info = vi.fn();
    const adapter = new LarkSdkAdapter({ appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" }, { info, warn: vi.fn(), error: vi.fn() } as never);
    await adapter.start(async () => undefined, async () => ({ toast: { type: "success", content: "已加入当前执行" }, card: { schema: "2.0" } }));

    await expect(registeredHandlers["card.action.trigger"]!({
      context: { open_message_id: "om_1", open_chat_id: "chat" }, operator: { open_id: "ou_1" },
      action: { value: { action: "submit_supplement" }, form_value: { supplement: "add tests" } }
    })).resolves.toEqual({ toast: { type: "success", content: "已加入当前执行" }, card: { type: "raw", data: { schema: "2.0" } } });
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: "lark-card-action-received", action: "submit_supplement", messageId: "om_1", outcome: "accepted" }), "Lark card action received");
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: "lark-card-action-completed", action: "submit_supplement", messageId: "om_1", outcome: "responded", responseKind: "toast_and_card", durationMs: expect.any(Number) }), "Lark card action completed");
    expect(JSON.stringify(info.mock.calls)).not.toContain("add tests");
  });

  it("leaves Toast-only callback responses unchanged", async () => {
    const adapter = new LarkSdkAdapter({ appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" });
    await adapter.start(async () => undefined, async () => ({ toast: { type: "success", content: "完成" } }));

    await expect(registeredHandlers["card.action.trigger"]!({
      context: { open_message_id: "om_toast", open_chat_id: "chat" }, operator: { open_id: "ou_1" },
      action: { value: { action: "noop" } }
    })).resolves.toEqual({ toast: { type: "success", content: "完成" } });
  });

  it("returns a safe error Toast and logs redacted metadata when a card action handler throws", async () => {
    const info = vi.fn(); const error = vi.fn();
    const adapter = new LarkSdkAdapter({ appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" }, { info, warn: vi.fn(), error } as never);
    await adapter.start(async () => undefined, async () => { throw new Error("private form value must not leak"); });

    await expect(registeredHandlers["card.action.trigger"]!({
      context: { open_message_id: "om_failed", open_chat_id: "chat" }, operator: { open_id: "ou_1" },
      action: { value: { action: "instance_create_form", secret: "private payload" } }
    })).resolves.toEqual({ toast: { type: "error", content: "操作失败，请稍后重试。" } });
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ event: "lark-card-action-failed", action: "instance_create_form", messageId: "om_failed", outcome: "failed", durationMs: expect.any(Number), err: expect.objectContaining({ message: "private form value must not leak" }) }), "Lark card action failed");
    expect(JSON.stringify([...info.mock.calls, ...error.mock.calls])).not.toContain("private payload");
  });
});

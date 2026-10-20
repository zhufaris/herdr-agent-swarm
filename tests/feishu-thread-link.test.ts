import { describe, expect, it } from "vitest";
import { feishuThreadLink } from "../src/cards/feishu-thread-link.js";

describe("feishuThreadLink", () => {
  it("builds a direct Thread AppLink from canonical chat and Thread IDs", () => {
    expect(feishuThreadLink("oc_chat-1", "omt_thread-1")).toBe(
      "https://applink.feishu.cn/client/thread/open?chatid=oc_chat-1&threadid=omt_thread-1&thread_position=-1"
    );
  });

  it.each([
    ["chat", "omt_thread"],
    ["oc_chat", "thread"],
    ["oc_chat", null]
  ])("rejects a non-canonical chat/Thread identity", (chatId, threadId) => {
    expect(feishuThreadLink(chatId, threadId)).toBeNull();
  });
});

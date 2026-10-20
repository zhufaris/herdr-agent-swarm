const FEISHU_THREAD_LINK = "https://applink.feishu.cn/client/thread/open";
const CHAT_ID = /^oc_[A-Za-z0-9_-]+$/;
const THREAD_ID = /^omt_[A-Za-z0-9_-]+$/;

export function feishuThreadLink(chatId: string, threadId: string | null | undefined): string | null {
  if (!CHAT_ID.test(chatId) || !threadId || !THREAD_ID.test(threadId)) return null;
  const link = new URL(FEISHU_THREAD_LINK);
  link.searchParams.set("chatid", chatId);
  link.searchParams.set("threadid", threadId);
  link.searchParams.set("thread_position", "-1");
  return link.toString();
}

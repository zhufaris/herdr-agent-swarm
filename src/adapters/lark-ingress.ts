export interface IncomingLarkCardAction { messageId: string; chatId: string; operatorOpenId: string; value: unknown; option?: string | null; formValues?: Record<string, string> }
export interface LarkCardActionResult { toast?: { type: "success" | "warning" | "error"; content: string }; card?: object }
export interface IncomingLarkMessage { eventId: string; messageId: string; parentMessageId: string | null; chatId: string; topicId: string | null; rootMessageId: string | null; actorOpenId: string; text: string; mentionsBot: boolean; isRootMessage: boolean; hasUnsupportedContent?: boolean }

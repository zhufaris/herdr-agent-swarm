import { createHash } from "node:crypto";

export interface ChoiceSelectionRef {
  actionSetId: string;
  optionId: string;
  sourceMessageId: string;
}

/** Immutable, provider-neutral content for one human Agent Input. */
export interface HumanInputMessageV2 {
  schemaVersion: 2;
  text: string;
  choice?: ChoiceSelectionRef;
}

export function humanInputMessage(text: string, choice?: ChoiceSelectionRef): HumanInputMessageV2 {
  return choice ? { schemaVersion: 2, text, choice: { ...choice } } : { schemaVersion: 2, text };
}

export function canonicalHumanInputJson(input: HumanInputMessageV2): string {
  return JSON.stringify(input.choice
    ? { schemaVersion: 2, text: input.text, choice: { actionSetId: input.choice.actionSetId, optionId: input.choice.optionId, sourceMessageId: input.choice.sourceMessageId } }
    : { schemaVersion: 2, text: input.text });
}

export function humanInputDigest(input: HumanInputMessageV2): string {
  return createHash("sha256").update(canonicalHumanInputJson(input)).digest("hex");
}

export function inputFromIncomingMessage(message: Pick<IncomingLarkMessage, "text" | "input">): HumanInputMessageV2 {
  return message.input ? humanInputMessage(message.input.text, message.input.choice) : humanInputMessage(message.text);
}

export interface IncomingLarkCardAction { messageId: string; chatId: string; operatorOpenId: string; value: unknown; option?: string | null; formValues?: Record<string, string> }
export interface LarkCardActionResult { toast?: { type: "success" | "warning" | "error"; content: string }; card?: object }
/** `text` remains a compatibility projection; new durable paths use `input`. */
export interface IncomingLarkMessage { gatewayId?: string; eventId: string; messageId: string; parentMessageId: string | null; chatId: string; topicId: string | null; rootMessageId: string | null; actorOpenId: string; text: string; input?: HumanInputMessageV2; mentionsBot: boolean; isRootMessage: boolean; hasUnsupportedContent?: boolean; inputTooLarge?: boolean }

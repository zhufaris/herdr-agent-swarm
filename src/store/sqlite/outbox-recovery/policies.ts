import type { DeliveryEffectCertainty } from "../../../domain/delivery.js";
import type { DeliveryFailureMetadata, OutboundReply, OutboxLaneClass } from "../../../domain/types.js";

export function normalizedEffectCertainty(metadata: DeliveryFailureMetadata): DeliveryEffectCertainty {
  if (metadata.effectCertainty) return metadata.effectCertainty;
  if (metadata.httpStatus !== null || metadata.larkErrorCode !== null || metadata.failureClass === "permanent") return "rejected";
  return metadata.failureClass === "transient" ? "not-started" : "uncertain";
}

export function outboundLaneClass(reply: OutboundReply): OutboxLaneClass {
  if (reply.cardRole === "answer" && reply.promptId && (reply.kind === "stream_content" || reply.kind === "stream_finish")) return "answer_stream";
  if (reply.targetRole === "session_status" && reply.kind === "card_update") return "main_card";
  if (reply.kind === "card_update") return "replaceable_card";
  return "immutable";
}

export function streamContentPageIndex(payload: string): number | null {
  try {
    const decoded = JSON.parse(payload) as { pageIndex?: unknown };
    return Number.isInteger(decoded.pageIndex) ? Number(decoded.pageIndex) : null;
  } catch {
    return null;
  }
}

export function lightweightAnswerCardPayload(payload: string): string {
  const decoded = JSON.parse(payload) as {
    card?: {
      schemaVersion?: unknown;
      nodes?: Array<Record<string, unknown>>;
      body?: { elements?: Array<Record<string, unknown>> };
    };
    stream?: { elementId?: unknown };
  };
  if (!decoded.card || !decoded.stream || typeof decoded.stream.elementId !== "string") {
    throw new Error("Answer continuation metadata missing for lightweight recovery");
  }
  if (decoded.card.schemaVersion === 1 && Array.isArray(decoded.card.nodes)) {
    let replaced = false;
    decoded.card.nodes = replaceGatewaySlotContent(decoded.card.nodes, decoded.stream.elementId, () => {
      replaced = true;
    });
    if (!replaced) throw new Error("Answer card streaming element missing for lightweight recovery");
    return JSON.stringify(decoded);
  }
  const elements = decoded.card.body?.elements;
  if (!Array.isArray(elements)) throw new Error("Answer card body missing for lightweight recovery");
  let replaced = false;
  decoded.card.body!.elements = elements.map((element) => {
    if (element.element_id !== decoded.stream!.elementId) return element;
    replaced = true;
    return { ...element, content: "正在恢复本页内容…" };
  });
  if (!replaced) throw new Error("Answer card streaming element missing for lightweight recovery");
  return JSON.stringify(decoded);
}

function replaceGatewaySlotContent(
  nodes: Array<Record<string, unknown>>,
  slot: string,
  replaced: () => void,
): Array<Record<string, unknown>> {
  return nodes.map((node) => {
    if (node.kind === "markdown" && node.slot === slot) {
      replaced();
      return { ...node, content: "正在恢复本页内容…" };
    }
    const next = { ...node };
    if (Array.isArray(next.nodes)) {
      next.nodes = replaceGatewaySlotContent(next.nodes as Array<Record<string, unknown>>, slot, replaced);
    }
    if (Array.isArray(next.columns)) {
      next.columns = (next.columns as Array<Record<string, unknown>>).map((column) => ({
        ...column,
        ...(Array.isArray(column.nodes)
          ? { nodes: replaceGatewaySlotContent(column.nodes as Array<Record<string, unknown>>, slot, replaced) }
          : {}),
      }));
    }
    return next;
  });
}

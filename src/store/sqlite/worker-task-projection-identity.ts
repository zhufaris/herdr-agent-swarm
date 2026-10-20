import type { SqliteContext } from "./context.js";
import type { EnqueueOutboundReplyInput } from "./outbox-queue-store.js";

export function withWorkerTaskProjectionIdentity(context: SqliteContext, input: EnqueueOutboundReplyInput): EnqueueOutboundReplyInput {
  if (!input.workerTurnId || input.projectionKey !== undefined) return input;
  let pageIndex = input.streamPageIndex ?? 0;
  let payload = input.payload;
  if (input.kind === "stream_card_create" || input.kind === "stream_content" || input.kind === "stream_finish") {
    try {
      const parsed = JSON.parse(input.payload) as { pageIndex?: unknown; stream?: { pageIndex?: unknown } };
      const candidate = input.kind === "stream_card_create" ? parsed.stream?.pageIndex : parsed.pageIndex;
      if (Number.isInteger(candidate)) pageIndex = Number(candidate);
      if (input.kind === "stream_card_create" && !parsed.stream && input.streamPageIndex !== null && input.streamPageIndex !== undefined) {
        const page = context.database.prepare("SELECT page_start, element_id FROM worker_turn_card_pages WHERE turn_id=? AND page_index=? AND state='creating'").get(
          input.workerTurnId,
          input.streamPageIndex,
        ) as { page_start: number; element_id: string } | undefined;
        if (!page) throw new Error(`Worker Task continuation page disappeared during preparation: ${input.workerTurnId}:${input.streamPageIndex}`);
        pageIndex = input.streamPageIndex;
        payload = JSON.stringify({
          card: parsed,
          stream: { pageIndex, pageStart: Number(page.page_start), elementId: page.element_id },
        });
      }
    } catch { /* deterministic preparation owns malformed-payload rejection */ }
  }
  return {
    ...input,
    payload,
    projectionKey: `worker-task:${input.workerTurnId}:page:${pageIndex}`,
    snapshotRevision: input.snapshotRevision ?? input.cardSequence ?? input.viewVersion ?? 1,
    streamPageIndex: input.streamPageIndex ?? pageIndex,
  };
}

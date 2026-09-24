export type AnswerTimelineToolCategory = "read" | "search" | "edit" | "command" | "test" | "step";
export type AnswerTimelineToolState = "running" | "succeeded" | "failed";

interface AnswerTimelineItemBase { id: string; sequence: number }

export type AnswerTimelineItem =
  | AnswerTimelineItemBase & { kind: "agent_message"; markdown: string }
  | AnswerTimelineItemBase & { kind: "tool"; category: AnswerTimelineToolCategory; label: string; command?: string; resultPreview?: string; state: AnswerTimelineToolState }
  | AnswerTimelineItemBase & { kind: "status"; label: string; state: "running" | "blocked" | "failed" }
  | AnswerTimelineItemBase & { kind: "final_answer"; markdown: string };

/** A stable-ID upsert emitted in canonical transcript order. */
export type AnswerTimelineDelta = AnswerTimelineItem;

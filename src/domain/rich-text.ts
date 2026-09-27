export interface RichTextDocument {
  title?: string;
  markdown: string;
}

export interface RichTextAnswerPayload {
  pageIndex: number;
  pageStart: number;
  elementId: string;
  sourceEnd?: number;
  terminal?: boolean;
  pageState?: "active" | "frozen" | "finished";
  document: RichTextDocument;
}

export function initialRichTextAnswerPayload(pageIndex: number, pageStart: number, elementId: string): RichTextAnswerPayload {
  return {
    pageIndex,
    pageStart,
    elementId,
    document: {
      ...(pageIndex > 0 ? { title: `回答（续 ${pageIndex + 1}）` } : {}),
      markdown: "正在生成… ▌"
    }
  };
}

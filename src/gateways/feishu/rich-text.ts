import type { RichTextDocument } from "../../domain/rich-text.js";

export function materializeFeishuRichText(document: RichTextDocument): object {
  return {
    zh_cn: {
      title: document.title ?? "",
      content: [[{ tag: "md", text: document.markdown }]]
    }
  };
}

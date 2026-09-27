import type { RichTextDocument } from "../../domain/rich-text.js";

export function materializeFeishuRichText(document: RichTextDocument): object {
  const heading = document.title
    ? [[{ tag: "text", text: document.title, style: ["bold"] }]]
    : [];
  return {
    zh_cn: {
      title: document.title ?? "",
      content: [...heading, [{ tag: "md", text: document.markdown }]]
    }
  };
}

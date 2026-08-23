import { truncateLarkMarkdown } from "../runtime/lark-markdown.js";

export function renderModelResultCard(input: { spaceName: string; paneId: string; output: string; switched: boolean }): object {
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: "Herdr 模型" } },
    header: {
      title: { tag: "plain_text", content: truncate(`TraeX · ${input.spaceName} / ${input.paneId}`, 96) },
      subtitle: { tag: "plain_text", content: "HERDR MODEL" },
      template: input.switched ? "green" : "blue"
    },
    body: { elements: [{ tag: "markdown", content: truncateLarkMarkdown(input.output.trim() || "TraeX 未返回模型信息。", 8_000) }] }
  };
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

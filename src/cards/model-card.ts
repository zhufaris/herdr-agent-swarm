import { truncateLarkMarkdown } from "../runtime/lark-markdown.js";

export function renderModelResultCard(input: { bindingId: string; spaceName: string; paneId: string; output: string; switched: boolean }): object {
  const selector = parseModelSelector(input.output);
  const elements: object[] = [];
  if (selector.options.length) {
    elements.push(
      { tag: "markdown", content: selector.current ? `当前模型：**${selector.current}**` : "请选择 TraeX 模型。" },
      {
        tag: "select_static", name: "model", placeholder: { tag: "plain_text", content: "选择模型" },
        ...(selector.current ? { initial_option: selector.current } : {}),
        options: selector.options.map((model) => ({ text: { tag: "plain_text", content: model }, value: model })),
        behaviors: [{ type: "callback", value: { action: "select_model", bindingId: input.bindingId } }]
      }
    );
  } else {
    elements.push({ tag: "markdown", content: truncateLarkMarkdown(input.output.trim() || "TraeX 未返回模型信息。", 8_000) });
  }
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: "Herdr 模型" } },
    header: {
      title: { tag: "plain_text", content: truncate(`TraeX · ${input.spaceName} / ${input.paneId}`, 96) },
      subtitle: { tag: "plain_text", content: "HERDR MODEL" },
      template: input.switched ? "green" : "blue"
    },
    body: { elements }
  };
}

function parseModelSelector(output: string): { current: string | null; options: string[] } {
  const options: string[] = [];
  let current: string | null = null;
  for (const line of output.split("\n")) {
    const match = /^\s*\d+\.\s+(\S+)/u.exec(line);
    if (!match) continue;
    const model = match[1]!;
    if (!options.includes(model)) options.push(model);
    if (/\(current\)/i.test(line)) current = model;
    if (options.length >= 100) break;
  }
  return { current, options };
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

import type { RichTextDocument } from "../../domain/rich-text.js";

export function materializeFeishuRichText(document: RichTextDocument): object {
  return {
    zh_cn: {
      title: document.title ?? "",
      content: materializeMarkdown(document.markdown)
    }
  };
}

type FeishuPostElement =
  | { tag: "md"; text: string }
  | { tag: "code_block"; text: string; language?: string };

const FEISHU_CODE_LANGUAGES: Readonly<Record<string, string>> = {
  bash: "BASH", sh: "BASH", shell: "SHELL", zsh: "BASH",
  python: "PYTHON", py: "PYTHON",
  javascript: "JAVASCRIPT", js: "JAVASCRIPT", jsx: "JAVASCRIPT",
  typescript: "TYPESCRIPT", ts: "TYPESCRIPT", tsx: "TYPESCRIPT",
  c: "C", cpp: "CPP", "c++": "CPP", cc: "CPP", cxx: "CPP",
  go: "GO", golang: "GO", java: "JAVA", kotlin: "KOTLIN", swift: "SWIFT",
  php: "PHP", ruby: "RUBY", rust: "RUST", sql: "SQL", json: "JSON",
  xml: "XML", yaml: "YAML", yml: "YAML", html: "HTML", thrift: "THRIFT"
};

function materializeMarkdown(markdown: string): FeishuPostElement[][] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const content: FeishuPostElement[][] = [];
  let markdownStart = 0;
  let cursor = 0;
  while (cursor < lines.length) {
    const opening = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/.exec(lines[cursor]!);
    if (!opening) { cursor += 1; continue; }
    const marker = opening[1]!;
    let closing = cursor + 1;
    while (closing < lines.length && !isClosingFence(lines[closing]!, marker)) closing += 1;
    if (closing >= lines.length) break;
    appendMarkdown(content, lines.slice(markdownStart, cursor).join("\n"));
    const language = feishuCodeLanguage(opening[2] ?? "");
    content.push([{ tag: "code_block", text: lines.slice(cursor + 1, closing).join("\n"), ...(language ? { language } : {}) }]);
    cursor = closing + 1;
    markdownStart = cursor;
  }
  appendMarkdown(content, lines.slice(markdownStart).join("\n"));
  return content.length > 0 ? content : [[{ tag: "md", text: markdown }]];
}

function appendMarkdown(content: FeishuPostElement[][], markdown: string): void {
  const text = markdown.replace(/^\n+|\n+$/g, "");
  if (text) content.push([{ tag: "md", text }]);
}

function isClosingFence(line: string, marker: string): boolean {
  const escaped = marker[0] === "`" ? "`" : "~";
  return new RegExp(`^ {0,3}${escaped}{${marker.length},}\\s*$`).test(line);
}

function feishuCodeLanguage(info: string): string | undefined {
  const language = info.trim().split(/\s+/, 1)[0]?.toLowerCase();
  return language ? FEISHU_CODE_LANGUAGES[language] : undefined;
}

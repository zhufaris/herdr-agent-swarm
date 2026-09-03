export type FinalAnswerElement = { tag: string; [key: string]: unknown };

const CODE_FOLD_LINE_LIMIT = 80;
const CODE_FOLD_CHARACTER_LIMIT = 6_000;

/** Turns final answer text into CardKit content without adding card metadata or delivery state. */
export function foldFinalAnswerContent(content: string): FinalAnswerElement[] {
  return splitFinalAnswerBlocks(content).map((block) => {
    if (block.kind === "markdown") return { tag: "markdown", content: block.content };
    const lineCount = block.code.length === 0 ? 0 : block.code.split("\n").length;
    if (lineCount <= CODE_FOLD_LINE_LIMIT && block.code.length <= CODE_FOLD_CHARACTER_LIMIT) return { tag: "markdown", content: block.source };
    return {
      tag: "collapsible_panel",
      expanded: false,
      border: { color: "grey", corner_radius: "6px" },
      header: { title: { tag: "plain_text", content: foldedCodeTitle(block.language, lineCount, block.code.length) } },
      elements: [{ tag: "markdown", content: block.source }]
    };
  });
}

function splitFinalAnswerBlocks(content: string): Array<{ kind: "markdown"; content: string } | { kind: "code"; source: string; language: string; code: string }> {
  const lines = content.split("\n");
  const result: Array<{ kind: "markdown"; content: string } | { kind: "code"; source: string; language: string; code: string }> = [];
  let markdown: string[] = [];
  for (let index = 0; index < lines.length;) {
    const opening = /^```([^`]*)$/.exec(lines[index]!);
    if (!opening) { markdown.push(lines[index]!); index += 1; continue; }
    const closingIndex = lines.findIndex((line, candidate) => candidate > index && line === "```");
    if (closingIndex < 0) { markdown.push(...lines.slice(index)); break; }
    if (markdown.length) { result.push({ kind: "markdown", content: markdown.join("\n").trim() }); markdown = []; }
    const language = opening[1]!.trim();
    const code = lines.slice(index + 1, closingIndex).join("\n");
    result.push({ kind: "code", source: lines.slice(index, closingIndex + 1).join("\n"), language, code });
    index = closingIndex + 1;
  }
  if (markdown.length) result.push({ kind: "markdown", content: markdown.join("\n").trim() });
  return result.filter((block) => block.kind === "code" || block.content.length > 0);
}

function foldedCodeTitle(language: string, lineCount: number, characterCount: number): string {
  return `${fencedBlockLabel(language)} · ${lineCount} 行 · ${characterCount} 字符`;
}

function fencedBlockLabel(language: string): string {
  const normalized = language.toLowerCase();
  if (["bash", "sh", "shell", "zsh"].includes(normalized)) return "命令";
  if (normalized === "text") return "执行输出";
  if (["diff", "patch"].includes(normalized)) return "变更 Diff";
  if (["json", "yaml", "yml", "toml", "ini", "conf"].includes(normalized)) return "配置 / JSON";
  const languages: Record<string, string> = { c: "C", cpp: "C++", csharp: "C#", cs: "C#", css: "CSS", dart: "Dart", go: "Go", html: "HTML", java: "Java", javascript: "JavaScript", js: "JavaScript", jsx: "JSX", kotlin: "Kotlin", lua: "Lua", php: "PHP", py: "Python", python: "Python", r: "R", ruby: "Ruby", rust: "Rust", scala: "Scala", sql: "SQL", swift: "Swift", ts: "TypeScript", tsx: "TSX", typescript: "TypeScript", xml: "XML" };
  return languages[normalized] ? `${languages[normalized]} 代码` : "代码块";
}

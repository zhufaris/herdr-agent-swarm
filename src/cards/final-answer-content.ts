import { appendWithinCardLimit } from "./card-payload.js";

export type FinalAnswerElement = { tag: string; [key: string]: unknown };

const CODE_FOLD_LINE_LIMIT = 80;
const CODE_FOLD_CHARACTER_LIMIT = 6_000;
const COMMAND_TARGET_LIMIT = 160;
const COMMAND_OUTPUT_LIMIT = 4_000;
const COMMAND_HEADING = /^◆ \*\*Ran\*\*(?: · (.+))?$/;
const ACTIVITY_EMOJI = { Skill: "🧩", Read: "📖", Search: "🔍", Edit: "✏️", Wait: "⏳", Agent: "🤖", Tool: "🛠️" } as const;

type AnswerContentBlock =
  | { kind: "markdown"; content: string }
  | { kind: "code"; source: string; language: string; code: string }
  | { kind: "command"; source: string; title: string; compact: string; command: string; output: string | null; terminal: boolean };

/** Replaces exact bridge-generated command blocks with Herdr-like summary rows. */
export function compactAnswerToolActivity(content: string): string {
  const lines = content.split("\n");
  const rendered: string[] = [];
  let fenceMarker: string | null = null;
  for (let index = 0; index < lines.length;) {
    const fence = /^ {0,3}(`{3,})/.exec(lines[index]!);
    if (fenceMarker) {
      rendered.push(lines[index]!);
      if (new RegExp(`^ {0,3}${fenceMarker}{${fenceMarker.length},}\\s*$`).test(lines[index]!)) fenceMarker = null;
      index += 1;
      continue;
    }
    if (fence) { fenceMarker = "`"; rendered.push(lines[index]!); index += 1; continue; }
    const command = parseCommandBlock(lines, index);
    if (!command) { rendered.push(decorateActivityLine(lines[index]!)); index += 1; continue; }
    rendered.push(command.block.compact);
    index = command.nextIndex;
  }
  return rendered.join("\n");
}

/** Turns final answer text into CardKit content without adding card metadata or delivery state. */
export function foldFinalAnswerContent(content: string, payloadLimit = 12_000): FinalAnswerElement[] {
  const elements: FinalAnswerElement[] = [];
  for (const block of splitFinalAnswerBlocks(content)) {
    const additions = renderBlock(block);
    if (block.kind === "command" && !appendWithinCardLimit(elements, additions, 800, payloadLimit)) elements.push({ tag: "markdown", content: block.compact });
    else elements.push(...additions);
  }
  return elements;
}

function renderBlock(block: AnswerContentBlock): FinalAnswerElement[] {
  if (block.kind === "markdown") return [{ tag: "markdown", content: compactAnswerToolActivity(block.content) }];
  if (block.kind === "command") {
    if (!block.terminal) return [{ tag: "markdown", content: block.compact }];
    const detail = block.output
      ? ["```bash", block.command, "```", "", "```text", block.output, "```"].join("\n")
      : ["```bash", block.command, "```", "", "命令已完成，无可展示输出。"].join("\n");
    return [{
      tag: "collapsible_panel", expanded: false, border: { color: "grey", corner_radius: "6px" },
      header: { title: { tag: "plain_text", content: block.title } },
      elements: [{ tag: "markdown", content: detail }]
    }];
  }
  const lineCount = block.code.length === 0 ? 0 : block.code.split("\n").length;
  if (lineCount <= CODE_FOLD_LINE_LIMIT && block.code.length <= CODE_FOLD_CHARACTER_LIMIT) return [{ tag: "markdown", content: block.source }];
  return [{
    tag: "collapsible_panel", expanded: false, border: { color: "grey", corner_radius: "6px" },
    header: { title: { tag: "plain_text", content: foldedCodeTitle(block.language, lineCount, block.code.length) } },
    elements: [{ tag: "markdown", content: block.source }]
  }];
}

function splitFinalAnswerBlocks(content: string): AnswerContentBlock[] {
  const lines = content.split("\n");
  const result: AnswerContentBlock[] = [];
  let markdown: string[] = [];
  const flushMarkdown = (): void => {
    const value = markdown.join("\n").trim();
    if (value) result.push({ kind: "markdown", content: value });
    markdown = [];
  };
  for (let index = 0; index < lines.length;) {
    const command = parseCommandBlock(lines, index);
    if (command) { flushMarkdown(); result.push(command.block); index = command.nextIndex; continue; }
    const opening = /^```([^`]*)$/.exec(lines[index]!);
    if (!opening) { markdown.push(lines[index]!); index += 1; continue; }
    const closingIndex = lines.findIndex((line, candidate) => candidate > index && line === "```");
    if (closingIndex < 0) { markdown.push(...lines.slice(index)); break; }
    flushMarkdown();
    const language = opening[1]!.trim();
    const code = lines.slice(index + 1, closingIndex).join("\n");
    result.push({ kind: "code", source: lines.slice(index, closingIndex + 1).join("\n"), language, code });
    index = closingIndex + 1;
  }
  flushMarkdown();
  return result;
}

function parseCommandBlock(lines: readonly string[], start: number): { block: Extract<AnswerContentBlock, { kind: "command" }>; nextIndex: number } | null {
  const heading = COMMAND_HEADING.exec(lines[start] ?? "");
  if (!heading) return null;
  let index = start + 1;
  if (lines[index] === "") index += 1;
  if (lines[index] !== "```bash") return null;
  const commandEnd = lines.indexOf("```", index + 1);
  if (commandEnd < 0) return null;
  const command = lines.slice(index + 1, commandEnd).join("\n");
  if (!command || command.includes("\n")) return null;
  index = commandEnd + 1;
  if (lines[index] === "") index += 1;
  let output: string | null = null;
  if (lines[index] === "```text") {
    const outputEnd = lines.indexOf("```", index + 1);
    if (outputEnd < 0) return null;
    output = lines.slice(index + 1, outputEnd).join("\n");
    index = outputEnd + 1;
  }
  const state = commandState(heading[1]);
  const terminal = heading[1] !== "运行中";
  const normalizedCommand = command.replace(/\s+/g, " ").trim();
  const plainCommand = truncateWithEllipsis(normalizedCommand, COMMAND_TARGET_LIMIT);
  output = output === null ? null : truncateWithEllipsis(output, COMMAND_OUTPUT_LIMIT);
  const title = `⚙️ Ran · ${plainCommand} · ${state}`;
  const compact = `⚙️ **Ran** · \`${plainCommand.replaceAll("`", "\\`")}\` · ${state}`;
  return { block: { kind: "command", source: lines.slice(start, index).join("\n"), title, compact, command: plainCommand, output, terminal }, nextIndex: index };
}

function truncateWithEllipsis(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;
}

function decorateActivityLine(line: string): string {
  const activity = /^(✓|…|✗) (Skill|Read|Search|Edit|Agent|Tool) · (.+)$/.exec(line);
  if (activity) {
    const [, , category, detail] = activity;
    return `${ACTIVITY_EMOJI[category as keyof typeof ACTIVITY_EMOJI]} ${category} · ${detail}`;
  }
  const wait = /^(✓ 等待完成|… 等待命令完成|✗ 等待后台任务完成) · (.+)$/.exec(line);
  if (!wait) return line;
  const state = wait[1]!.startsWith("✓") ? "✓ 完成" : wait[1]!.startsWith("…") ? "… 运行中" : "✗ 失败";
  return `${ACTIVITY_EMOJI.Wait} Wait · ${wait[2]} · ${state}`;
}

function commandState(value: string | undefined): string {
  if (!value) return "✓ 完成";
  if (value === "运行中") return "… 运行中";
  return value.startsWith("✗") ? value : `✓ ${value}`;
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

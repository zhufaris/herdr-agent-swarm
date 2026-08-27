export type ToolActivityCategory = "Skill" | "Read" | "Search" | "Edit" | "Command" | "Wait" | "Agent" | "Tool";

export interface ToolActivityDescriptor {
  category: ToolActivityCategory;
  target: string;
  skillNames: string[];
}

export interface ProjectedToolCall {
  descriptor: ToolActivityDescriptor;
  entry: string;
}

const TARGET_LIMIT = 160;
const FAILURE_DETAIL_LIMIT = 4_000;
const FAILURE_LINE_LIMIT = 20;
const TRUSTED_SKILL_PATH = /\/data00\/home\/[^/\s"']+\/(?:\.trae\/skills|\.agents\/skills|\.trae\/plugins)\/[A-Za-z0-9._+@=\/-]+\/SKILL\.md/g;

export function projectToolCall(name: string, argumentsJson: string): ProjectedToolCall {
  const parsed = parseArguments(argumentsJson);
  const skillNames = skillNamesFromArguments(parsed);
  if (skillNames.length > 0) {
    return { descriptor: { category: "Skill", target: skillNames.join(", "), skillNames }, entry: "" };
  }
  const descriptor = describeCall(name, parsed);
  return { descriptor, entry: "▶ " + descriptor.category + " · " + descriptor.target };
}

export function projectToolResult(descriptor: ToolActivityDescriptor, output: unknown): string {
  const normalized = normalizeOutput(output);
  const status = explicitStatus(output, normalized);
  if (status.kind === "running") return "▶ " + descriptor.category + " · 仍在运行";
  if (status.kind === "failed") {
    const detail = failureTail(normalized);
    const heading = "✗ " + descriptor.category + " · " + status.summary;
    if (!detail) return heading;
    const prefix = heading + "\n\n```text\n";
    const suffix = "\n```";
    const room = Math.max(0, FAILURE_DETAIL_LIMIT - prefix.length - suffix.length);
    return prefix + detail.slice(-room) + suffix;
  }
  if (descriptor.category === "Skill") return "✓ Skill · " + descriptor.target + " · 已加载";
  return "✓ " + descriptor.category + " · " + successSummary(descriptor, normalized);
}

function describeCall(name: string, parsed: unknown): ToolActivityDescriptor {
  const record = asRecord(parsed);
  const normalized = name.toLowerCase();
  if (normalized === "exec" && typeof record?.input === "string") {
    const inner = nestedToolCall(record.input);
    if (inner) return describeCall(inner.name, inner.arguments);
  }
  if (normalized.includes("read") || normalized === "view_image") {
    return descriptor("Read", firstValue(record, ["path", "file", "filename"]) ?? name);
  }
  if (normalized.includes("search") || normalized === "grep" || normalized === "rg") {
    const query = firstValue(record, ["query", "pattern", "regex"]);
    const scope = firstValue(record, ["path", "workdir", "directory"]);
    return descriptor("Search", [query, scope].filter(Boolean).join(" · ") || name);
  }
  if (normalized.includes("patch") || normalized.includes("edit") || normalized.includes("write_file")) {
    return descriptor("Edit", firstValue(record, ["path", "file", "filename"]) ?? name);
  }
  if (normalized === "exec_command" || normalized === "shell" || normalized === "bash" || normalized === "exec") {
    return descriptor("Command", firstValue(record, ["cmd", "command"]) ?? name);
  }
  if (normalized === "wait" || normalized === "write_stdin" || normalized.includes("wait_agent")) {
    const session = firstValue(record, ["session_id", "cell_id", "target"]);
    return descriptor("Wait", session ? "session " + session : name);
  }
  if (normalized.startsWith("collaboration__")) {
    return descriptor("Agent", firstValue(record, ["task_name", "target"]) ?? name.replace("collaboration__", ""));
  }
  return descriptor("Tool", name);
}

function descriptor(category: ToolActivityCategory, target: string): ToolActivityDescriptor {
  return { category, target: boundTarget(target), skillNames: [] };
}

function nestedToolCall(value: string): { name: string; arguments: unknown } | null {
  const match = /tools\.([A-Za-z0-9_]+)\s*\(\s*\{([\s\S]*?)\}\s*\)/.exec(value);
  if (!match) return null;
  const body = match[2] ?? "";
  const fields: Record<string, unknown> = {};
  for (const key of ["cmd", "command", "path", "query", "pattern", "task_name", "target"]) {
    const field = new RegExp(key + "\\s*:\\s*([\\\"'])((?:\\\\.|(?!\\1)[\\s\\S])*?)\\1").exec(body);
    if (field?.[2]) fields[key] = field[2].replace(/\\([\\"'])/g, "$1");
  }
  return { name: match[1]!, arguments: fields };
}

function skillNamesFromArguments(value: unknown): string[] {
  const names = new Set<string>();
  visitValues(value, (text) => {
    for (const match of text.matchAll(TRUSTED_SKILL_PATH)) {
      const name = match[0].split("/").at(-2);
      if (name) names.add(name);
    }
  });
  return [...names];
}

function visitValues(value: unknown, visit: (value: string) => void, depth = 0): void {
  if (depth > 16) return;
  if (typeof value === "string") { visit(value); return; }
  if (Array.isArray(value)) { for (const item of value) visitValues(item, visit, depth + 1); return; }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) visitValues(item, visit, depth + 1);
  }
}

function parseArguments(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstValue(record: Record<string, unknown> | null, keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if ((typeof value === "string" || typeof value === "number") && String(value).trim()) return String(value).trim();
  }
  return null;
}

function boundTarget(value: string): string {
  const safe = redactToolActivitySecrets(value).replace(/[\r\n]+/g, " ")
    .replace(/\b[A-Z][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)/g, (assignment) => assignment.slice(0, assignment.indexOf("=")) + "=[REDACTED]")
    .replaceAll("\\", "\\\\")
    .replaceAll(String.fromCharCode(96), "\\" + String.fromCharCode(96))
    .replace(/\s+/g, " ").trim();
  return safe.length <= TARGET_LIMIT ? safe : safe.slice(0, TARGET_LIMIT - 1).trimEnd() + "…";
}

function normalizeOutput(output: unknown): string {
  if (typeof output === "string") return output.trim();
  if (!Array.isArray(output)) return "";
  return output.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const record = part as Record<string, unknown>;
    return (record.type === "input_text" || record.type === "output_text") && typeof record.text === "string" ? [record.text.trim()] : [];
  }).filter(Boolean).join("\n");
}

function explicitStatus(output: unknown, normalized: string): { kind: "success" | "running" | "failed"; summary: string } {
  const parsed = typeof output === "string" ? parseArguments(output) : output;
  const record = asRecord(parsed);
  const exitCode = typeof record?.exit_code === "number" ? record.exit_code : null;
  if (exitCode !== null && exitCode !== 0) return { kind: "failed", summary: "exit " + exitCode };
  const status = typeof record?.status === "string" ? record.status.toLowerCase() : "";
  if (["failed", "failure", "error"].includes(status) || record?.error) return { kind: "failed", summary: status || "失败" };
  const textualExit = /Process exited with code\s+(-?\d+)/i.exec(normalized);
  if (textualExit && textualExit[1] !== "0") return { kind: "failed", summary: "exit " + textualExit[1] };
  if (/^Script failed\b/m.test(normalized)) return { kind: "failed", summary: "失败" };
  if (record && (record.session_id !== undefined || record.cell_id !== undefined) && record.exit_code === undefined) return { kind: "running", summary: "仍在运行" };
  return { kind: "success", summary: "成功" };
}

function successSummary(descriptor: ToolActivityDescriptor, output: string): string {
  if (descriptor.category === "Command") {
    const files = /Test Files\s+(\d+) passed/i.exec(output)?.[1];
    const tests = /Tests\s+(\d+) passed/i.exec(output)?.[1];
    if (files && tests) return files + " files / " + tests + " tests passed";
    const generic = /(\d+) passed(?:,\s*(\d+) failed)?(?:,\s*(\d+) skipped)?/i.exec(output);
    if (generic) return [generic[1] + " passed", generic[2] ? generic[2] + " failed" : "", generic[3] ? generic[3] + " skipped" : ""].filter(Boolean).join(" / ");
    const build = /generated\s+dist\/build-info\.json\s+\((sha256:[a-f0-9]+)\)/i.exec(output)?.[1];
    if (build) return "build " + build.slice(0, 15) + "…";
    return "成功";
  }
  if (descriptor.category === "Read") {
    const lines = /(?:^|\n)(\d+)\s+lines?\b/i.exec(output)?.[1];
    return lines ? "已读取 · " + lines + " 行" : "已读取";
  }
  if (descriptor.category === "Search") {
    const matches = /(?:found|matches?)\D{0,8}(\d+)/i.exec(output)?.[1];
    return matches ? "发现 " + matches + " 条" : "搜索完成";
  }
  if (descriptor.category === "Edit") return "已更新";
  if (descriptor.category === "Agent") return "状态已更新";
  return "已完成";
}

function failureTail(output: string): string {
  const lines = redactToolActivitySecrets(output).split("\n").map((line) => line.trimEnd())
    .filter((line) => line.trim() && !/^(?:Script failed|Process exited with code\s+-?\d+|Wall time\b|Output:)$/i.test(line.trim()));
  return lines.slice(-FAILURE_LINE_LIMIT).join("\n");
}

export function redactToolActivitySecrets(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s"'&,;}]+/gi, "$1[REDACTED]")
    .replace(/(bearer\s+)[a-z0-9._~-]+/gi, "$1[REDACTED]")
    .replace(/((?:access[_-]?token|api[_-]?key|token|secret|password)\s*[=:]\s*["']?)([^\s"'&,;}]+)/gi, "$1[REDACTED]")
    .replace(/([?&](?:access_token|api_key|token|secret|password)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]");
}

function fence(language: string, value: string): string {
  const ticks = String.fromCharCode(96).repeat(3);
  const spacedTicks = String.fromCharCode(96) + " " + String.fromCharCode(96) + " " + String.fromCharCode(96);
  return ticks + language + "\n" + value.replaceAll(ticks, spacedTicks) + "\n" + ticks;
}

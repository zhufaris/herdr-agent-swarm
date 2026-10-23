import { redactSecrets } from "./redact-secrets.js";
import { createBoundedTurnOutput } from "./bounded-turn-output.js";

export type ToolActivityCategory = "Skill" | "Read" | "Search" | "Edit" | "Command" | "Wait" | "Agent" | "Tool";

export interface ToolActivityDescriptor {
  category: ToolActivityCategory;
  action: string;
  target: string;
  skillNames: string[];
  diff?: string;
}

export interface ProjectedToolCall {
  descriptor: ToolActivityDescriptor;
  nestedIndex?: number;
}

/** Safely extracts static terminal commands nested in a Code Mode functions.exec input. */
export function nestedExecCommands(input: string): string[] {
  const commands: string[] = [];
  const pattern = /tools\.exec_command\s*\(\s*\{[\s\S]{0,8192}?\bcmd\s*:\s*(["\'])((?:\\.|(?!\1)[\s\S])*)\1/g;
  for (const match of input.matchAll(pattern)) {
    const value = match[2]?.replace(/\\([\\\'"nrt])/g, (_full, escaped: string) => escaped === "n" ? "\n" : escaped === "r" ? "\r" : escaped === "t" ? "\t" : escaped);
    if (value?.trim()) commands.push(value);
  }
  return [...new Set(commands)];
}

/** Extracts only file identities from a static apply_patch payload. */
export function nestedPatchFiles(input: string): string[] {
  return [...new Set(nestedPatchChanges(input).map(({ file }) => file))];
}

export function isStatusVisibleToolActivity(_descriptor: ToolActivityDescriptor): boolean { return true; }

export function isAnswerVisibleToolActivity(_descriptor: ToolActivityDescriptor): boolean { return true; }

export function toolActivityKey(callId: string, descriptor: ToolActivityDescriptor): string {
  if (descriptor.category === "Wait") return `wait:${descriptor.target || callId}`;
  if (descriptor.category === "Agent") return `agent:${descriptor.target || callId}`;
  return `tool:${callId}`;
}

const TARGET_LIMIT = 160;
const TRUSTED_SKILL_PATH = /\/data00\/home\/[^/\s"']+\/(?:\.trae\/skills|\.agents\/skills|\.trae\/plugins)\/[A-Za-z0-9._+@=\/-]+\/SKILL\.md/g;

export function projectToolCall(name: string, argumentsJson: string): ProjectedToolCall {
  const parsed = parseArguments(argumentsJson);
  const skillNames = skillNamesFromArguments(parsed === null ? argumentsJson : parsed);
  if (skillNames.length > 0) {
    return { descriptor: { category: "Skill", action: "Skill", target: skillNames.join(", "), skillNames } };
  }
  const descriptor = describeCall(name, parsed, parsed === null ? argumentsJson : undefined);
  return { descriptor };
}

/** Projects every statically visible Tool nested in one Core Code Mode exec. */
export function projectToolCalls(name: string, argumentsJson: string): ProjectedToolCall[] {
  const normalized = name.toLowerCase();
  if (normalized === "update_plan") return [];
  const parsed = parseArguments(argumentsJson);
  const record = asRecord(parsed);
  const input = (normalized === "exec" || normalized === "functions.exec")
    ? typeof record?.input === "string" ? record.input : parsed === null ? argumentsJson : null
    : null;
  if (!input) return [projectToolCall(name, argumentsJson)];
  const nested = nestedToolCalls(input)
    .filter((call) => call.name.toLowerCase() !== "update_plan")
    .map((call, nestedIndex) => {
      const skillNames = skillNamesFromArguments(call.source);
      const projectedDescriptor = skillNames.length > 0
        ? { category: "Skill" as const, action: "Skill", target: skillNames.join(", "), skillNames }
        : call.name.toLowerCase().includes("apply_patch")
          ? descriptor("Edit", nestedPatchTarget(input) || call.name, nestedPatchDiff(input) ?? undefined)
          : describeCall(call.name, call.arguments);
      return { descriptor: projectedDescriptor, nestedIndex };
    });
  if (nested.length === 0) return [];
  if (nested.length === 1) return [{ descriptor: nested[0]!.descriptor }];
  return [{ descriptor: descriptor("Tool", name) }, ...nested];
}

export function projectToolResultState(output: unknown): "active" | "done" | "failed" {
  const normalized = normalizeToolOutput(output);
  const status = explicitStatus(output, normalized);
  return status.kind === "success" ? "done" : status.kind === "running" ? "active" : "failed";
}

/** Produces the durable, bounded and redacted terminal outcome without inferring timeouts from prose. */
export function projectToolResultSummary(output: unknown, options: { isError?: boolean; sourceTruncated?: boolean } = {}): { outcome: "success" | "failure" | "timeout"; text: string } {
  const parsed = typeof output === "string" ? parseArguments(output) : output;
  const record = asRecord(parsed);
  const timeout = structuredTimeout(record);
  const outcome = options.isError ? "failure" : timeout ? "timeout" : projectToolResultState(output) === "failed" ? "failure" : "success";
  return { outcome, text: normalizeToolResultForDisplay(output, options.sourceTruncated) };
}

export function summarizeToolActivity(descriptor: ToolActivityDescriptor): string {
  if (descriptor.category === "Wait") return `Wait · ${descriptor.target || "command"}`;
  if (descriptor.category !== "Command") return descriptor.target || descriptor.category;
  const target = descriptor.target;
  const command = target.replace(/^(?:(?:env\s+)?[A-Za-z_][A-Za-z0-9_]*=(?:\[[^\]]*\]|[^\s]+)\s+)+/, "");
  const sqlite = /(?:^|\s)sqlite3(?:\s+[^\s]+)*\s+([^\s]+\.(?:db|sqlite|sqlite3))(?:\s|$)/i.exec(target);
  if (sqlite?.[1]) return `Query · ${basename(sqlite[1])}`;
  if (/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|compile)(?:\s|$)/i.test(command)) return "Build · project";
  const test = /(?:^|\s)([^\s/]+\.(?:test|spec)\.[cm]?[jt]sx?)(?:\s|$)/i.exec(command);
  if (test?.[1]) return `Test · ${basename(test[1])}`;
  if (/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:\s|$)|(?:^|\s)(?:vitest|jest|pytest)(?:\s|$)/i.test(command)) return "Test · project";
  const executable = /^(?:[^\s/]+\/)*([^\s/]+)/.exec(command)?.[1];
  return executable ? `Run · ${executable}` : "Command";
}

function describeCall(name: string, parsed: unknown, rawArguments?: string): ToolActivityDescriptor {
  const record = asRecord(parsed);
  const normalized = name.toLowerCase();
  const codeModeInput = typeof record?.input === "string" ? record.input : rawArguments;
  if ((normalized === "exec" || normalized === "functions.exec") && codeModeInput) {
    const patchTarget = nestedPatchTarget(codeModeInput);
    if (patchTarget) return descriptor("Edit", patchTarget, nestedPatchDiff(codeModeInput) ?? undefined);
    const commands = nestedExecCommands(codeModeInput);
    if (commands.length) return descriptor("Command", commands[0]!);
    const inner = nestedToolCall(codeModeInput);
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
    const patchSource = typeof parsed === "string" ? parsed : rawArguments;
    const diff = normalized.includes("apply_patch") && patchSource ? nestedPatchDiff(patchSource) : null;
    return descriptor("Edit", firstValue(record, ["path", "file", "filename"]) ?? name, diff ?? undefined);
  }
  if (normalized === "exec_command" || normalized === "shell" || normalized === "bash" || normalized === "exec" || normalized === "functions.exec") {
    return descriptor("Command", firstValue(record, ["cmd", "command"]) ?? "");
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

function descriptor(category: ToolActivityCategory, target: string, diff?: string): ToolActivityDescriptor {
  const boundedTarget = boundTarget(target, category !== "Command");
  return { category, action: toolAction(category, boundedTarget), target: boundedTarget, skillNames: [], ...(diff ? { diff } : {}) };
}

function toolAction(category: ToolActivityCategory, target: string): string {
  if (category === "Command") return summarizeToolActivity({ category, action: "", target, skillNames: [] }).split(" · ", 1)[0] || "Command";
  return category;
}

function nestedPatchTarget(input: string): string {
  return nestedPatchChanges(input).map(({ file, added, removed }) => `${file} (+${added} -${removed})`).join(", ");
}

function nestedPatchDiff(input: string): string | null {
  const normalized = input.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n");
  const matches = [...normalized.matchAll(/\*\*\* Begin Patch\r?\n([\s\S]*?)\r?\n\*\*\* End Patch/g)];
  if (matches.length !== 1 || !matches[0]?.[1]?.trim()) return null;
  return redactToolActivitySecrets(matches[0][1].trim());
}

function nestedPatchChanges(input: string): Array<{ file: string; added: number; removed: number }> {
  if (!/tools\.apply_patch\s*\(/.test(input)) return [];
  const normalized = input.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n");
  const pattern = /^\*\*\* (?:Add|Update|Delete) File:\s*([^\r\n"]+)/gm;
  const matches = [...normalized.matchAll(pattern)];
  return matches.map((match, index) => {
    const file = basename(match[1]!.trim());
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? normalized.indexOf("*** End Patch", start);
    const body = normalized.slice(start, end < 0 ? normalized.length : end);
    const lines = body.split("\n");
    const added = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
    const removed = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
    return { file, added, removed };
  });
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

function nestedToolCalls(value: string): Array<{ name: string; arguments: unknown; source: string }> {
  const calls: Array<{ name: string; arguments: unknown; source: string }> = [];
  for (const start of toolCallStarts(value)) {
    const { name, open } = start;
    const close = matchingParen(value, open);
    if (!name || close < 0) continue;
    const source = value.slice(start.index, close + 1);
    calls.push({ name, arguments: staticCallArguments(value.slice(open + 1, close)), source });
  }
  return calls;
}

function toolCallStarts(value: string): Array<{ index: number; name: string; open: number }> {
  const starts: Array<{ index: number; name: string; open: number }> = [];
  let quote = ""; let escaped = false; let lineComment = false; let blockComment = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!; const next = value[index + 1] ?? "";
    if (lineComment) { if (char === "\n") lineComment = false; continue; }
    if (blockComment) { if (char === "*" && next === "/") { blockComment = false; index += 1; } continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === quote) quote = "";
      continue;
    }
    if (char === "/" && next === "/") { lineComment = true; index += 1; continue; }
    if (char === "/" && next === "*") { blockComment = true; index += 1; continue; }
    if (char === "\"" || char === "'" || char === "`") { quote = char; continue; }
    if (!value.startsWith("tools.", index) || /[A-Za-z0-9_$]/.test(value[index - 1] ?? "")) continue;
    const match = /^tools\.([A-Za-z0-9_]+)\s*\(/.exec(value.slice(index));
    if (match?.[1]) starts.push({ index, name: match[1], open: index + match[0].length - 1 });
  }
  return starts;
}

function matchingParen(value: string, open: number): number {
  let depth = 0; let quote = ""; let escaped = false; let lineComment = false; let blockComment = false;
  for (let index = open; index < value.length; index += 1) {
    const char = value[index]!; const next = value[index + 1] ?? "";
    if (lineComment) { if (char === "\n") lineComment = false; continue; }
    if (blockComment) { if (char === "*" && next === "/") { blockComment = false; index += 1; } continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === quote) quote = "";
      continue;
    }
    if (char === "/" && next === "/") { lineComment = true; index += 1; continue; }
    if (char === "/" && next === "*") { blockComment = true; index += 1; continue; }
    if (char === "\"" || char === "'" || char === "`") { quote = char; continue; }
    if (char === "(") depth += 1;
    if (char === ")" && --depth === 0) return index;
  }
  return -1;
}

function staticCallArguments(body: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const key of ["cmd", "command", "path", "file", "filename", "query", "pattern", "regex", "workdir", "directory", "task_name", "target", "session_id", "cell_id"]) {
    const field = new RegExp("(?:[\\\"']?" + key + "[\\\"']?)\\s*:\\s*([\\\"'])((?:\\\\.|(?!\\1)[\\s\\S])*?)\\1").exec(body);
    if (field?.[2]) fields[key] = field[2].replace(/\\([\\\"'nrt])/g, (_full, escaped: string) => escaped === "n" ? "\n" : escaped === "r" ? "\r" : escaped === "t" ? "\t" : escaped);
  }
  return fields;
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

function boundTarget(value: string, escapeInlineMarkdown = true): string {
  let safe = redactToolActivitySecrets(value).replace(/[\r\n]+/g, " ")
    .replace(/\b[A-Z][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)/g, (assignment) => assignment.slice(0, assignment.indexOf("=")) + "=[REDACTED]")
    .replace(/\s+/g, " ").trim();
  if (escapeInlineMarkdown) safe = safe.replaceAll("\\", "\\\\").replaceAll(String.fromCharCode(96), "\\" + String.fromCharCode(96));
  return safe.length <= TARGET_LIMIT ? safe : safe.slice(0, TARGET_LIMIT - 1).trimEnd() + "…";
}

function basename(value: string): string { return value.replace(/["']/g, "").split("/").at(-1) ?? value; }

export function normalizeToolOutput(output: unknown): string {
  const text = typeof output === "string" ? output.trim() : Array.isArray(output) ? output.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const record = part as Record<string, unknown>;
    return (record.type === "input_text" || record.type === "output_text") && typeof record.text === "string" ? [record.text.trim()] : [];
  }).filter(Boolean).join("\n") : "";
  return unwrapToolOutput(text);
}

export function normalizeToolResultForDisplay(output: unknown, sourceTruncated = false): string {
  const normalized = normalizeToolOutput(output);
  const marked = `${normalized}${sourceTruncated ? "\n\n… source event truncated" : ""}`;
  return createBoundedTurnOutput(redactSecrets(marked)).text;
}

function unwrapToolOutput(value: string): string {
  const withoutHeader = stripExecutionHeader(value);
  const parsed = parseArguments(withoutHeader);
  if (!parsed || typeof parsed !== "object") return withoutHeader;
  if (Array.isArray(parsed) ? parsed.length === 0 : Object.keys(parsed).length === 0) return "";
  const outputs = collectStructuredOutputs(parsed);
  return outputs.length > 0 ? outputs.join("\n") : withoutHeader;
}

function stripExecutionHeader(value: string): string {
  const lines = value.split("\n");
  if (lines[0] !== "Script completed" || !lines[1]?.startsWith("Wall time " ) || lines[2] !== "Output:") return value;
  return lines.slice(3).join("\n").trim();
}

function collectStructuredOutputs(value: unknown, depth = 0): string[] {
  if (depth > 8 || !value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectStructuredOutputs(item, depth + 1));
  const record = value as Record<string, unknown>;
  const isResultEnvelope = ["exit_code", "chunk_id", "session_id", "cell_id", "wall_time_seconds", "original_token_count", "timed_out", "status", "code", "error"].some((key) => key in record);
  if (isResultEnvelope && typeof record.output === "string") return record.output.trim() ? [record.output.trim()] : [];
  return Object.values(record).flatMap((item) => collectStructuredOutputs(item, depth + 1));
}

function explicitStatus(output: unknown, normalized: string): { kind: "success" | "running" | "failed"; summary: string } {
  const parsed = typeof output === "string" ? parseArguments(output) : output;
  const record = asRecord(parsed);
  const exitCode = typeof record?.exit_code === "number" ? record.exit_code : null;
  if (exitCode !== null && exitCode !== 0) return { kind: "failed", summary: "exit " + exitCode };
  if (structuredTimeout(record)) return { kind: "failed", summary: "timeout" };
  const status = typeof record?.status === "string" ? record.status.toLowerCase() : "";
  if (["failed", "failure", "error"].includes(status) || record?.error) return { kind: "failed", summary: status || "失败" };
  const textualExit = /Process exited with code\s+(-?\d+)/i.exec(normalized);
  if (textualExit && textualExit[1] !== "0") return { kind: "failed", summary: "exit " + textualExit[1] };
  if (/^Script failed\b/m.test(normalized)) return { kind: "failed", summary: "失败" };
  if (record && (record.session_id !== undefined || record.cell_id !== undefined) && record.exit_code === undefined) return { kind: "running", summary: "仍在运行" };
  return { kind: "success", summary: "成功" };
}

function structuredTimeout(record: Record<string, unknown> | null): boolean {
  const status = typeof record?.status === "string" ? record.status.trim().toLowerCase() : "";
  const code = typeof record?.code === "string" ? record.code.trim().toUpperCase() : "";
  const error = asRecord(record?.error);
  const errorCode = typeof error?.code === "string" ? error.code.trim().toUpperCase() : "";
  return record?.timed_out === true || ["timeout", "timed_out"].includes(status)
    || ["TIMEOUT", "TIMED_OUT", "ETIMEDOUT"].includes(code) || ["TIMEOUT", "TIMED_OUT", "ETIMEDOUT"].includes(errorCode);
}

export function redactToolActivitySecrets(value: string): string {
  return redactSecrets(value);
}

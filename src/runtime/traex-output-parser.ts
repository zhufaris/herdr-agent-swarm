/** Remove TraeX's orchestration UI; it is not part of the agent's answer. */
function isSubagentConsoleLine(line: string): boolean {
  const trimmed = line.trim();
  return /^(?:\d+\s+agents?\s+running\b)/iu.test(trimmed)
    || /^(?:↓\s+to\s+select\s+agents|…\s*\+\d+\s+completed)$/u.test(trimmed)
    || /^\s*[●○]\s+[^\n]+\[(?:default|subagent|worker|explorer|reviewer|plan)\]\s+(?:running|idle|done|blocked)\b[^\n]*$/iu.test(line);
}

export function stripTraexConsoleStatus(source: string): string {
  return source.replace(/\r\n?/g, "\n").split("\n").filter((line) => !isSubagentConsoleLine(line)).join("\n").trim();
}

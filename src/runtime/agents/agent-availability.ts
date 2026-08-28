import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { CommandRunner } from "../../infra/command-runner.js";

export function discoverExecutable(executable: string, pathValue = process.env.PATH ?? ""): string | null {
  const candidates = isAbsolute(executable) || executable.includes("/") ? [executable] : pathValue.split(delimiter).filter(Boolean).map((directory) => join(directory, executable));
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); return candidate; } catch {}
  }
  return null;
}

export async function detectAgentRuntimeAvailability(input: { runner: CommandRunner; herdrExecutable: string; agentExecutable: string; herdrKind: "pi" | "claude" | "codex"; pathValue?: string }): Promise<boolean> {
  if (!discoverExecutable(input.agentExecutable, input.pathValue)) return false;
  try {
    const result = await input.runner.run(input.herdrExecutable, ["agent", "start", "--help"]);
    const kinds = `${result.stdout}\n${result.stderr}`.match(/possible values:\s*([^\n]+)/i)?.[1]?.split("|").map((kind) => kind.trim()) ?? [];
    return kinds.includes(input.herdrKind);
  } catch { return false; }
}

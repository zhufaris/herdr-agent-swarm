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

export async function detectAgentRuntimeAvailabilities(input: {
  runner: CommandRunner;
  herdrExecutable: string;
  agents: { codex: string; claude: string; pi: string };
  pathValue?: string;
}): Promise<{ codex: boolean; claude: boolean; pi: boolean }> {
  const executables = {
    codex: discoverExecutable(input.agents.codex, input.pathValue) !== null,
    claude: discoverExecutable(input.agents.claude, input.pathValue) !== null,
    pi: discoverExecutable(input.agents.pi, input.pathValue) !== null
  };
  if (!executables.codex && !executables.claude && !executables.pi) return executables;
  try {
    const kinds = await detectHerdrAgentKinds(input.runner, input.herdrExecutable);
    return { codex: executables.codex && kinds.has("codex"), claude: executables.claude && kinds.has("claude"), pi: executables.pi && kinds.has("pi") };
  } catch { return { codex: false, claude: false, pi: false }; }
}

async function detectHerdrAgentKinds(runner: CommandRunner, herdrExecutable: string): Promise<ReadonlySet<string>> {
  const result = await runner.run(herdrExecutable, ["agent", "start", "--help"]);
  return new Set(`${result.stdout}\n${result.stderr}`
    .match(/possible values:\s*([^\]\n]+)/i)?.[1]
    ?.split(/\s*[|,]\s*/u)
    .map((kind) => kind.trim()) ?? []);
}

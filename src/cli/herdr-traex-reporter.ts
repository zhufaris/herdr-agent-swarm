import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TraexAgentReporter, type ReporterInput, type ReporterOperations } from "../runtime/herdr-traex-reporter.js";

async function main(): Promise<void> {
  const configPath = process.env.HERDR_TRAEX_SHIM_CONFIG;
  if (!configPath) throw new Error("Missing installed shim config");
  const config = JSON.parse(await readFile(configPath, "utf8")) as { realHerdr?: unknown };
  if (typeof config.realHerdr !== "string" || !config.realHerdr.startsWith("/")) throw new Error("Invalid real Herdr path");
  const input = parseInput(process.argv[2]);
  await new TraexAgentReporter(operations(config.realHerdr, input.executable)).run(input);
}

function operations(realHerdr: string, executable: string): ReporterOperations {
  return {
    processIdentity: async (paneId, pid) => {
      const result = resultOf(await run(realHerdr, ["pane", "process-info", "--pane", paneId])) as { process_info?: { foreground_processes?: Array<{ pid?: number; argv?: string[] }> } };
      const process = result.process_info?.foreground_processes?.find((entry) => entry.pid === pid);
      const actualExecutable = process ? await readExecutable(pid) : null;
      const startTicks = process ? await readStartTicks(pid) : null;
      return process && actualExecutable === executable && startTicks ? { executable, pid, startTicks } : null;
    },
    reportAgent: async (paneId, state, sequence) => { await run(realHerdr, ["pane", "report-agent", paneId, "--source", "herdr-traex-shim", "--agent", "codex", "--state", state, "--seq", sequence]); },
    reportMetadata: async (paneId, sequence) => { await run(realHerdr, ["pane", "report-metadata", paneId, "--source", "herdr-traex-shim", "--agent", "codex", "--display-agent", "traex", "--seq", sequence]); },
    clearMetadata: async (paneId, sequence) => { await run(realHerdr, ["pane", "report-metadata", paneId, "--source", "herdr-traex-shim", "--agent", "codex", "--clear-display-agent", "--seq", sequence]); },
    renameAgent: async (paneId, name) => { await run(realHerdr, ["agent", "rename", paneId, name]); },
    releaseAgent: async (paneId, source, agent, sequence) => { await run(realHerdr, ["pane", "release-agent", paneId, "--source", source, "--agent", agent, "--seq", sequence]); },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  };
}

function run(executable: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(executable, args, { encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}
function resultOf(stdout: string): unknown { return (JSON.parse(stdout) as { result?: unknown }).result; }
async function readStartTicks(pid: number): Promise<string | null> {
  try { const stat = await readFile(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).split(" " )[19] ?? null; } catch { return null; }
}
async function readExecutable(pid: number): Promise<string | null> {
  try { return realpathSync(await readlink(`/proc/${pid}/exe`)); } catch { return null; }
}
function parseInput(raw: string | undefined): ReporterInput {
  if (!raw) throw new Error("Missing reporter input");
  const value = JSON.parse(raw) as Partial<ReporterInput>;
  if (!value.paneId || !value.name || !value.executable?.startsWith("/") || !Number.isInteger(value.pid) || !value.processStartTicks) throw new Error("Invalid reporter input");
  return value as ReporterInput;
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) main().catch(() => { process.exitCode = 1; });

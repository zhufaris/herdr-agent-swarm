import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
      const process = result.process_info?.foreground_processes?.find((entry) => entry.pid === pid && entry.argv?.[0] === executable);
      const startTicks = process ? await readStartTicks(pid) : null;
      return process && startTicks ? { executable, pid, startTicks } : null;
    },
    readPane: (paneId) => run(realHerdr, ["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", "240", "--format", "text"]),
    explainCodexSnapshot: async (snapshot) => {
      const directory = await mkdtemp(join(tmpdir(), "herdr-traex-explain-"));
      const path = join(directory, "snapshot.txt");
      try {
        await writeFile(path, snapshot, { mode: 0o600 });
        const result = resultOf(await run(realHerdr, ["agent", "explain", "--file", path, "--agent", "codex", "--format", "json"]));
        return findState(result);
      } finally { await rm(directory, { recursive: true, force: true }); }
    },
    reportAgent: async (paneId, state, sequence) => { await run(realHerdr, ["pane", "report-agent", paneId, "--source", "herdr-traex-shim", "--agent", "traex", "--state", state, "--seq", sequence]); },
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
function findState(value: unknown): unknown {
  if (!value || typeof value !== "object") return "unknown";
  const record = value as Record<string, unknown>;
  if (typeof record.state === "string") return record.state;
  if (record.explanation && typeof record.explanation === "object") return (record.explanation as Record<string, unknown>).state;
  return "unknown";
}
function parseInput(raw: string | undefined): ReporterInput {
  if (!raw) throw new Error("Missing reporter input");
  const value = JSON.parse(raw) as Partial<ReporterInput>;
  if (!value.paneId || !value.name || !value.executable?.startsWith("/") || !Number.isInteger(value.pid) || !value.processStartTicks) throw new Error("Invalid reporter input");
  return value as ReporterInput;
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(() => { process.exitCode = 1; });

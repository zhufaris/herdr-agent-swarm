import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { parseHerdrShimInvocation, runHerdrTraexStart, type TraexLaunchConfig, type TraexStartDependencies } from "../runtime/herdr-traex-shim.js";

async function main(): Promise<void> {
  const configPath = process.env.HERDR_TRAEX_SHIM_CONFIG;
  if (!configPath) throw new Error("HERDR_TRAEX_SHIM_CONFIG is not set by the installed launcher");
  const config = parseConfig(JSON.parse(await readFile(configPath, "utf8")));
  const invocation = parseHerdrShimInvocation(process.argv.slice(2));
  if (invocation.kind !== "start-traex") throw new Error("Shim entrypoint accepts only agent start --kind traex");
  const result = await runHerdrTraexStart(invocation, config, dependencies(config));
  process.stdout.write(`${JSON.stringify({ id: "cli:agent:start", result })}\n`);
}

function dependencies(config: TraexLaunchConfig): TraexStartDependencies {
  return {
    runHerdr: (args, timeoutMs) => run(config.realHerdr, args, timeoutMs),
    writeRequest: async (bytes) => {
      await mkdir(config.requestDir, { recursive: true, mode: 0o700 });
      await chmod(config.requestDir, 0o700);
      const id = randomBytes(16).toString("hex");
      await writeFile(`${config.requestDir}/${id}`, bytes, { flag: "wx", mode: 0o600 });
      return id;
    },
    removeRequest: (id) => rm(`${config.requestDir}/${id}`, { force: true }),
    processStartTicks: async (pid) => processStartTicks(pid),
    startReporter: (input) => {
      const child = spawn(process.execPath, [config.reporter, JSON.stringify(input)], { detached: true, stdio: "ignore", env: process.env });
      child.unref();
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now
  };
}

function run(executable: string, args: string[], timeoutMs = 30_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => execFile(executable, args, { timeout: timeoutMs, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error(`Official Herdr command failed (${args.slice(0, 2).join(" " )})`, { cause: error }));
    else resolve({ stdout, stderr });
  }));
}

async function processStartTicks(pid: number): Promise<string | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    return stat.slice(close + 2).split(" " )[19] ?? null;
  } catch { return null; }
}

function parseConfig(value: unknown): TraexLaunchConfig {
  if (!value || typeof value !== "object") throw new Error("Invalid TraeX shim config");
  const record = value as Record<string, unknown>;
  const keys = ["realHerdr", "traex", "launcher", "reporter", "requestDir", "validatedHerdrVersion"] as const;
  for (const key of keys) if (typeof record[key] !== "string" || !record[key]) throw new Error(`Invalid TraeX shim config field: ${key}`);
  return Object.fromEntries(keys.map((key) => [key, record[key]])) as unknown as TraexLaunchConfig;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "agent_start_failed";
    process.stderr.write(`${code}: ${error instanceof Error ? error.message : "TraeX start failed"}\n`);
    process.exitCode = 1;
  });
}

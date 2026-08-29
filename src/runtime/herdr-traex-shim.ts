import { isAbsolute, resolve } from "node:path";

export type HerdrShimInvocation =
  | { kind: "delegate"; argv: string[] }
  | { kind: "project"; argv: string[] }
  | { kind: "start-traex"; name: string; paneId: string; timeoutMs: number; traexArgs: string[] };

export interface ShimConfig {
  realHerdr: string;
  traex: string;
  shim: string;
  installVersion: string;
  validatedHerdrVersion: string;
}

export interface TraexStartInput {
  name: string;
  paneId: string;
  timeoutMs: number;
  traexArgs: string[];
}

export interface TraexLaunchConfig {
  realHerdr: string;
  traex: string;
  launcher: string;
  reporter: string;
  lifecycleReporter: string;
  requestDir: string;
  validatedHerdrVersion: string;
}

export interface TraexStartDependencies {
  runHerdr(args: string[], timeoutMs?: number): Promise<{ stdout: string; stderr: string }>;
  writeRequest(bytes: Buffer): Promise<string>;
  removeRequest(requestId: string): Promise<void>;
  processExecutable(pid: number): Promise<string | null>;
  processStartTicks(pid: number): Promise<string | null>;
  startReporter(input: { paneId: string; name: string; executable: string; pid: number; processStartTicks: string; reporter: string }): void | Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export class TraexStartError extends Error {
  constructor(readonly code: "agent_start_failed" | "agent_start_uncertain", message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TraexStartError";
  }
}

export function parseHerdrShimInvocation(argv: readonly string[]): HerdrShimInvocation {
  const delegated = { kind: "delegate" as const, argv: [...argv] };
  if (projectsAgentJson(argv)) return { kind: "project", argv: [...argv] };
  if (argv[0] !== "agent" || argv[1] !== "start") return delegated;

  const separator = argv.indexOf("--", 2);
  const commandArgs = argv.slice(2, separator < 0 ? undefined : separator);
  const traexArgs = separator < 0 ? [] : argv.slice(separator + 1);
  const kindValues = optionValues(commandArgs, "--kind");
  if (!kindValues.includes("traex")) return delegated;

  const name = commandArgs[0];
  if (!name || name.startsWith("-")) throw new Error("TraeX agent start requires a name");
  let paneId: string | undefined;
  let timeoutMs = 30_000;
  let seenKind = false;
  let seenPane = false;
  let seenTimeout = false;
  for (let index = 1; index < commandArgs.length; index += 1) {
    const option = commandArgs[index]!;
    if (!["--kind", "--pane", "--timeout"].includes(option)) throw new Error(`Unknown TraeX start option: ${option}`);
    const value = commandArgs[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
    index += 1;
    if (option === "--kind") {
      if (seenKind) throw new Error("Duplicate --kind option");
      seenKind = true;
      if (value !== "traex") throw new Error("TraeX start requires --kind traex");
    } else if (option === "--pane") {
      if (seenPane) throw new Error("Duplicate --pane option");
      seenPane = true;
      paneId = value;
    } else {
      if (seenTimeout) throw new Error("Duplicate --timeout option");
      seenTimeout = true;
      if (!/^[0-9]+$/.test(value)) throw new Error("TraeX start timeout must be an integer");
      timeoutMs = Number(value);
      if (timeoutMs < 1 || timeoutMs > 300_000) throw new Error("TraeX start timeout must be between 1 and 300000 milliseconds");
    }
  }
  if (!seenKind) throw new Error("TraeX agent start requires --kind traex");
  if (!paneId) throw new Error("TraeX agent start requires --pane");
  return { kind: "start-traex", name, paneId, timeoutMs, traexArgs };
}

function projectsAgentJson(argv: readonly string[]): boolean {
  if (argv[0] === "api" && argv[1] === "snapshot") return true;
  if (argv[0] === "pane" && ["list", "get", "current"].includes(argv[1] ?? "")) return true;
  return argv[0] === "agent" && ["list", "get", "prompt", "wait", "focus", "rename"].includes(argv[1] ?? "");
}

export function projectTraexAgentJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(projectTraexAgentJson);
  if (!value || typeof value !== "object") return value;
  const projected = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, projectTraexAgentJson(child)]));
  if (projected.display_agent === "traex" && projected.agent === "codex") {
    projected.agent = "traex";
    const session = projected.agent_session;
    if (session && typeof session === "object" && !Array.isArray(session)) {
      const record = session as Record<string, unknown>;
      if (record.agent === "codex") projected.agent_session = { ...record, agent: "traex" };
    }
  }
  return projected;
}

export function validateShimPaths(config: ShimConfig): void {
  for (const [label, value] of [["real Herdr", config.realHerdr], ["TraeX", config.traex], ["shim", config.shim]] as const) {
    if (!isAbsolute(value)) throw new Error(`${label} path must be absolute`);
  }
  if (resolve(config.realHerdr) === resolve(config.shim)) throw new Error("Real Herdr and shim paths must be different");
  if (!config.installVersion || !config.validatedHerdrVersion) throw new Error("Shim version metadata is required");
}

export function encodeLaunchRequest(executable: string, args: readonly string[]): Buffer {
  if (!isAbsolute(executable)) throw new Error("TraeX executable path must be absolute");
  if ([executable, ...args].some((value) => value.includes("\0"))) throw new Error("Launch arguments cannot contain NUL bytes");
  return Buffer.from(`${[executable, ...args].join("\0")}\0`);
}

export async function runHerdrTraexStart(input: TraexStartInput, config: TraexLaunchConfig, dependencies: TraexStartDependencies): Promise<Record<string, unknown>> {
  const deadline = dependencies.now() + input.timeoutMs;
  let requestId: string | null = null;
  let launched = false;
  try {
    const version = await dependencies.runHerdr(["--version"], input.timeoutMs);
    if (!version.stdout.includes(config.validatedHerdrVersion)) {
      throw new TraexStartError("agent_start_failed", "Herdr version is not validated for the installed TraeX shim");
    }
    const before = parseProcessInfo((await dependencies.runHerdr(["pane", "process-info", "--pane", input.paneId], input.timeoutMs)).stdout);
    if (!isAvailableShell(before)) throw new TraexStartError("agent_start_failed", `Pane ${input.paneId} is not an available shell`);
    requestId = await dependencies.writeRequest(encodeLaunchRequest(config.traex, [
      ...shimLifecycleArguments(config.realHerdr, config.lifecycleReporter),
      ...input.traexArgs
    ]));
    // Once pane.run is invoked, its command may have reached the terminal even
    // if the CLI later returns an error. Fence all later failures as uncertain.
    launched = true;
    await dependencies.runHerdr(["pane", "run", input.paneId, launchCommand(config.launcher, requestId)], input.timeoutMs);
    const process = await waitForTraexProcess(input.paneId, config.traex, deadline, dependencies);
    const processStartTicks = await dependencies.processStartTicks(process.pid);
    if (!processStartTicks) throw new Error("TraeX process identity disappeared before reporter startup");
    await dependencies.startReporter({ paneId: input.paneId, name: input.name, executable: config.traex, pid: process.pid, processStartTicks, reporter: config.reporter });
    const managed = await waitForManagedAgent(input, deadline, dependencies);
    return { type: "agent_started", agent: projectTraexAgentJson(managed.agent), argv: ["traex"] };
  } catch (cause) {
    if (!launched) {
      if (requestId) await dependencies.removeRequest(requestId).catch(() => undefined);
      if (cause instanceof TraexStartError) throw cause;
      throw new TraexStartError("agent_start_failed", `TraeX did not start: ${boundedCause(cause)}`, { cause });
    }
    throw new TraexStartError("agent_start_uncertain", `TraeX may have started in pane ${input.paneId}; inspect it before retrying`, { cause });
  }
}

export function shimLifecycleArguments(realHerdr: string, lifecycleReporter: string): string[] {
  const command = `HERDR_TRAEX_REAL_HERDR=${shellQuote(realHerdr)} node ${shellQuote(lifecycleReporter)}`;
  return [
    "-c", lifecycleHookArgument("SessionStart", "startup|resume", command),
    "-c", lifecycleHookArgument("UserPromptSubmit", ".*", command),
    "-c", lifecycleHookArgument("Stop", null, command)
  ];
}

function lifecycleHookArgument(event: "SessionStart" | "UserPromptSubmit" | "Stop", matcher: string | null, command: string): string {
  const match = matcher === null ? "" : `matcher=${JSON.stringify(matcher)},`;
  return `hooks.${event}=[{${match}hooks=[{type="command",command=${JSON.stringify(command)},timeout=5}]}]`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function boundedCause(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.replace(/[\r\n]+/g, " " ).slice(0, 256);
}

function launchCommand(launcher: string, requestId: string): string {
  if (!/^\/[A-Za-z0-9_./-]+$/.test(launcher) || !/^[a-f0-9-]+$/.test(requestId)) {
    throw new Error("Unsafe TraeX launcher path or request ID");
  }
  return `${launcher} ${requestId}`;
}

interface ProcessRecord { pid: number; name?: string; argv: string[] }
interface ProcessInfo { shellPid: number | null; foreground: ProcessRecord[] }

function parseProcessInfo(stdout: string): ProcessInfo {
  const value = parseEnvelope(stdout) as { process_info?: { shell_pid?: unknown; foreground_processes?: unknown } };
  const raw = value.process_info;
  if (!raw || !Array.isArray(raw.foreground_processes)) throw new Error("Invalid Herdr process-info response");
  const foreground = raw.foreground_processes.flatMap((entry): ProcessRecord[] => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as { pid?: unknown; name?: unknown; argv?: unknown };
    if (!Number.isInteger(item.pid)) return [];
    return [{ pid: item.pid as number, ...(typeof item.name === "string" ? { name: item.name } : {}), argv: Array.isArray(item.argv) && item.argv.every((arg) => typeof arg === "string") ? item.argv : [] }];
  });
  return { shellPid: Number.isInteger(raw.shell_pid) ? raw.shell_pid as number : null, foreground };
}

function isAvailableShell(info: ProcessInfo): boolean {
  if (info.foreground.length !== 1) return false;
  const process = info.foreground[0]!;
  return process.pid === info.shellPid && /^(?:ba|z|fi|da|k)?sh$/.test(process.name ?? "");
}

async function waitForTraexProcess(paneId: string, executable: string, deadline: number, dependencies: TraexStartDependencies): Promise<ProcessRecord> {
  let first = true;
  while (first || dependencies.now() <= deadline) {
    first = false;
    const info = parseProcessInfo((await dependencies.runHerdr(["pane", "process-info", "--pane", paneId])).stdout);
    for (const process of info.foreground) {
      if (await dependencies.processExecutable(process.pid) === executable) return process;
    }
    await dependencies.sleep(50);
  }
  throw new Error("Timed out waiting for the TraeX process");
}

async function waitForManagedAgent(input: TraexStartInput, deadline: number, dependencies: TraexStartDependencies): Promise<Record<string, unknown>> {
  let first = true;
  while (first || dependencies.now() <= deadline) {
    first = false;
    try {
      const result = parseEnvelope((await dependencies.runHerdr(["agent", "get", input.name])).stdout) as { agent?: Record<string, unknown> };
      const agent = result.agent;
      if (agent?.pane_id === input.paneId && agent.agent === "codex" && agent.display_agent === "traex" && agent.agent_status !== "unknown") return result;
    } catch {
      // The detached reporter names the already-running agent asynchronously.
      // A transient agent_not_found is expected until that structured update lands.
    }
    await dependencies.sleep(50);
  }
  throw new Error("Timed out waiting for managed TraeX identity");
}

function parseEnvelope(stdout: string): unknown {
  const parsed = JSON.parse(stdout) as { result?: unknown };
  if (!("result" in parsed)) throw new Error("Invalid Herdr JSON response");
  return parsed.result;
}

function optionValues(args: readonly string[], option: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === option) values.push(args[index + 1]!);
  }
  return values;
}

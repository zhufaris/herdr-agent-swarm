import { isAbsolute } from "node:path";
import type { TraexTranscriptCursorPort, TraexTranscriptOpenResult, TraexTranscriptObservation } from "../domain/ports/external.js";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROMPT_START_SETTLEMENT_MS = 5_000;

export type HerdrShimInvocation =
  | { kind: "delegate"; argv: string[] }
  | { kind: "project"; argv: string[] }
  | TraexPromptInput & { kind: "prompt-traex" }
  | { kind: "steer-traex"; target: string; text: string; turnId: string; idempotencyKey: string; agentSession: { source: string; agent: string; kind: "id" | "path"; value: string }; timeoutMs: number }
  | { kind: "model-list-traex"; target: string; agentSession: { source: string; agent: string; kind: "id"; value: string }; timeoutMs: number }
  | { kind: "model-prompt-prepare"; target: string; model: string; revision: number; promptSha256: string; agentSession: { source: string; agent: string; kind: "id"; value: string }; timeoutMs: number }
  | { kind: "model-prompt-commit"; operationId: string; text: string; promptSha256: string; timeoutMs: number }
  | { kind: "start-traex"; name: string; paneId: string; timeoutMs: number; traexArgs: string[] };

export interface TraexStartInput {
  name: string;
  paneId: string;
  timeoutMs: number;
  traexArgs: string[];
}

export interface TraexPromptInput {
  target: string;
  text: string;
  argv: string[];
  timeoutMs: number | null;
  until: string[];
}

interface TraexPromptAgent {
  agent?: unknown;
  display_agent?: unknown;
  agent_status?: unknown;
  agent_session?: { source?: unknown; agent?: unknown; kind?: unknown; value?: unknown };
}

export interface TraexPromptCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  result?: { agent: TraexPromptAgent };
}

export interface TraexPromptDependencies {
  resolveAgent(target: string): Promise<TraexPromptAgent | null>;
  openTranscript(session: { source: string; agent: string; kind: "id"; value: string }, expectedPrompt: string): Promise<TraexTranscriptOpenResult>;
  submit(argv: string[], timeoutMs: number | null): Promise<TraexPromptCommandResult>;
  currentAgent(target: string): Promise<TraexPromptAgent | null>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface TraexLaunchConfig {
  realHerdr: string;
  traex: string;
  launcher: string;
  reporter: string;
  requestDir: string;
  sessionPeersDir: string;
  steeringOperationDir: string;
  validatedHerdrVersion: string;
}

export interface TraexStartDependencies {
  runHerdr(args: string[], timeoutMs?: number): Promise<{ stdout: string; stderr: string }>;
  writeRequest(bytes: Buffer): Promise<string>;
  removeRequest(requestId: string): Promise<void>;
  processExecutable(pid: number): Promise<string | null>;
  processStartTicks(pid: number): Promise<string | null>;
  startReporter(input: { paneId: string; name: string; executable: string; pid: number; processStartTicks: string; launchCorrelationId: string; reporter: string }): void | Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  generateSessionId(): string;
}

export class TraexStartError extends Error {
  constructor(readonly code: "agent_start_failed" | "agent_start_uncertain", message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TraexStartError";
  }
}

export function parseHerdrShimInvocation(argv: readonly string[]): HerdrShimInvocation {
  const delegated = { kind: "delegate" as const, argv: [...argv] };
  if (argv[0] === "agent" && argv[1] === "steer") return parseTraexSteer(argv.slice(2));
  if (argv[0] === "agent" && argv[1] === "model-list") return parseTraexModelList(argv.slice(2));
  if (argv[0] === "agent" && argv[1] === "model-prompt") return parseTraexModelPrompt(argv.slice(2));
  if (argv[0] === "agent" && argv[1] === "prompt") return parseTraexPrompt(argv) ?? { kind: "project", argv: [...argv] };
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

function parseTraexPrompt(argv: readonly string[]): (TraexPromptInput & { kind: "prompt-traex" }) | null {
  const target = argv[2];
  const text = argv[3];
  if (!target || !text || target.startsWith("-")) return null;
  let wait = false;
  let timeoutMs: number | null = null;
  const until: string[] = [];
  for (let index = 4; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--wait") { if (wait) return null; wait = true; continue; }
    if (option !== "--timeout" && option !== "--until") return null;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) return null;
    index += 1;
    if (option === "--timeout") {
      if (timeoutMs !== null || !/^[0-9]+$/.test(value) || Number(value) < 1) return null;
      timeoutMs = Number(value);
    } else {
      if (!["idle", "working", "blocked", "done", "unknown"].includes(value)) return null;
      until.push(value);
    }
  }
  if (!wait) return null;
  return { kind: "prompt-traex", target, text, argv: [...argv], timeoutMs, until };
}

export async function runHerdrTraexPrompt(input: TraexPromptInput, dependencies: TraexPromptDependencies): Promise<TraexPromptCommandResult> {
  const agent = await dependencies.resolveAgent(input.target).catch(() => null);
  const session = managedTraexSession(agent);
  if (!session) return dependencies.submit(input.argv, input.timeoutMs);
  const opened = await dependencies.openTranscript(session, input.text).catch(() => null);
  const dispatchStartedMs = dependencies.now();
  const dispatchBoundaryMs = Math.floor(dispatchStartedMs / 1_000) * 1_000;
  const submitted = await dependencies.submit(input.argv, input.timeoutMs);
  if (submitted.exitCode === 0 || structuredResultErrorCode(submitted.stderr) !== "agent_prompt_stalled" || opened?.mode !== "typed" || !completionMatchesUntil(input.until)) return submitted;
  const turnDeadline = input.timeoutMs === null ? null : dispatchStartedMs + input.timeoutMs;
  const startDeadline = dispatchStartedMs + Math.min(PROMPT_START_SETTLEMENT_MS, input.timeoutMs ?? PROMPT_START_SETTLEMENT_MS);
  let owned: NonNullable<TraexTranscriptObservation["turnLifecycle"]> | null = null;
  let previousSignature = "";
  for (;;) {
    const currentTime = dependencies.now();
    if (!owned && currentTime >= startDeadline) return promptNotStartedResult();
    if (owned && turnDeadline !== null && currentTime >= turnDeadline) return submitted;
    let observation: TraexTranscriptObservation;
    try { observation = opened.cursor.readObservation ? await opened.cursor.readObservation() : { answerDelta: await opened.cursor.readDelta() }; }
    catch { return submitted; }
    const lifecycle = observation.turnLifecycle;
    const signature = JSON.stringify(observation);
    if (!owned) {
      if (!observation.freshTurnStart) {
        await dependencies.sleep(signature === previousSignature ? 100 : 50);
        previousSignature = signature;
        continue;
      }
      if (!lifecycle || lifecycle.turnId !== observation.turnId) return submitted;
      if (Date.parse(lifecycle.startedAt) < dispatchBoundaryMs) {
        await dependencies.sleep(signature === previousSignature ? 100 : 50);
        previousSignature = signature;
        continue;
      }
      owned = lifecycle;
    } else if (observation.freshTurnStart && lifecycle && lifecycle.turnId !== owned.turnId) {
      return submitted;
    } else if (lifecycle && lifecycle.turnId === owned.turnId && lifecycle.startedAt === owned.startedAt) {
      owned = lifecycle;
    }
    if (owned.state === "aborted") return submitted;
    if (owned.state === "completed") {
      const next = await readImmediately(opened.cursor).catch(() => null);
      if (next?.freshTurnStart && next.turnLifecycle?.turnId !== owned.turnId) return submitted;
      const current = await dependencies.currentAgent(input.target).catch(() => null);
      if (!sameManagedTraexSession(current, session)) return submitted;
      const settledAgent = { ...current, agent_status: "idle" };
      const result = { agent: settledAgent };
      return { exitCode: 0, stdout: JSON.stringify({ id: "cli:agent:prompt", result }), stderr: "", result };
    }
    if (signature === previousSignature && !observation.answerDelta) await dependencies.sleep(100);
    else await dependencies.sleep(50);
    previousSignature = signature;
  }
}

function promptNotStartedResult(): TraexPromptCommandResult {
  return {
    exitCode: 1,
    stdout: "",
    stderr: JSON.stringify({ error: { code: "agent_prompt_not_started", message: "No matching TraeX turn started within the settlement window" } })
  };
}

function managedTraexSession(agent: TraexPromptAgent | null): { source: string; agent: string; kind: "id"; value: string } | null {
  const session = agent?.agent_session;
  if (agent?.display_agent !== "traex" || agent.agent !== "traex" || session?.source !== "herdr-traex-shim" || session.agent !== "traex" || session.kind !== "id" || typeof session.value !== "string" || !SESSION_ID.test(session.value)) return null;
  return { source: session.source, agent: session.agent, kind: session.kind, value: session.value };
}

function sameManagedTraexSession(agent: TraexPromptAgent | null, expected: { value: string }): boolean {
  return managedTraexSession(agent)?.value === expected.value;
}

function completionMatchesUntil(until: readonly string[]): boolean {
  return until.length === 0 || until.includes("idle") || until.includes("done");
}

function structuredResultErrorCode(stderr: string): string | null {
  const start = stderr.indexOf("{");
  if (start < 0) return null;
  try { const value = JSON.parse(stderr.slice(start)) as { error?: { code?: unknown } }; return typeof value.error?.code === "string" ? value.error.code : null; }
  catch { return null; }
}

async function readImmediately(cursor: TraexTranscriptCursorPort): Promise<TraexTranscriptObservation | null> {
  if (typeof cursor.readObservation !== "function") return null;
  const observation = await cursor.readObservation();
  return observation.freshTurnStart ? observation : null;
}

function parseTraexSteer(args: readonly string[]): Extract<HerdrShimInvocation, { kind: "steer-traex" }> {
  const target = args[0];
  const text = args[1];
  if (!target || target.startsWith("-")) throw new Error("TraeX steer requires an Agent target");
  if (!text || !text.trim()) throw new Error("TraeX steer requires non-empty text");
  let turnId: string | undefined;
  let idempotencyKey: string | undefined;
  let agentSession: Extract<HerdrShimInvocation, { kind: "steer-traex" }>["agentSession"] | undefined;
  let timeoutMs = 10_000;
  for (let index = 2; index < args.length; index += 1) {
    const option = args[index];
    if (!["--turn-id", "--idempotency-key", "--agent-session", "--timeout"].includes(option ?? "")) throw new Error(`Unknown TraeX steer option: ${option}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
    index += 1;
    if (option === "--turn-id") { if (turnId) throw new Error("Duplicate --turn-id option"); turnId = value; }
    else if (option === "--idempotency-key") { if (idempotencyKey) throw new Error("Duplicate --idempotency-key option"); idempotencyKey = value; }
    else if (option === "--agent-session") {
      if (agentSession) throw new Error("Duplicate --agent-session option");
      let decoded: unknown;
      try { decoded = JSON.parse(value); } catch { throw new Error("TraeX steer --agent-session must be valid JSON"); }
      if (!decoded || typeof decoded !== "object") throw new Error("TraeX steer --agent-session is invalid");
      const record = decoded as Record<string, unknown>;
      if (typeof record.source !== "string" || typeof record.agent !== "string" || !["id", "path"].includes(String(record.kind)) || typeof record.value !== "string" || !record.value) throw new Error("TraeX steer --agent-session is invalid");
      agentSession = { source: record.source, agent: record.agent, kind: record.kind as "id" | "path", value: record.value };
    }
    else {
      if (!/^[0-9]+$/.test(value)) throw new Error("TraeX steer timeout must be an integer");
      timeoutMs = Number(value);
      if (timeoutMs < 1 || timeoutMs > 300_000) throw new Error("TraeX steer timeout must be between 1 and 300000 milliseconds");
    }
  }
  if (!turnId) throw new Error("TraeX steer requires --turn-id");
  if (!idempotencyKey) throw new Error("TraeX steer requires --idempotency-key");
  if (!agentSession) throw new Error("TraeX steer requires --agent-session");
  return { kind: "steer-traex", target, text, turnId, idempotencyKey, agentSession, timeoutMs };
}

function parseTraexModelList(args: readonly string[]): Extract<HerdrShimInvocation, { kind: "model-list-traex" }> {
  const target = args[0];
  if (!target || target.startsWith("-")) throw new Error("TraeX model list requires an Agent target");
  let agentSession: Extract<HerdrShimInvocation, { kind: "model-list-traex" }>["agentSession"] | undefined;
  let timeoutMs = 10_000;
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    if (option !== "--agent-session" && option !== "--timeout") throw new Error(`Unknown TraeX model list option: ${option}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
    index += 1;
    if (option === "--agent-session") {
      if (agentSession) throw new Error("Duplicate --agent-session option");
      let decoded: unknown;
      try { decoded = JSON.parse(value); } catch { throw new Error("TraeX model list --agent-session must be valid JSON"); }
      if (!decoded || typeof decoded !== "object") throw new Error("TraeX model list Agent session is invalid");
      const record = decoded as Record<string, unknown>;
      if (record.source !== "herdr-traex-shim" || record.agent !== "traex" || record.kind !== "id" || typeof record.value !== "string" || !SESSION_ID.test(record.value)) throw new Error("TraeX model list Agent session is invalid");
      agentSession = { source: record.source, agent: record.agent, kind: "id", value: record.value };
    } else {
      if (!/^[0-9]+$/.test(value)) throw new Error("TraeX model list timeout must be an integer");
      timeoutMs = Number(value);
      if (timeoutMs < 1 || timeoutMs > 300_000) throw new Error("TraeX model list timeout must be between 1 and 300000 milliseconds");
    }
  }
  if (!agentSession) throw new Error("TraeX model list requires --agent-session");
  return { kind: "model-list-traex", target, agentSession, timeoutMs };
}

function parseTraexModelPrompt(args: readonly string[]): Extract<HerdrShimInvocation, { kind: "model-prompt-prepare" | "model-prompt-commit" }> {
  const action = args[0];
  if (action === "prepare") {
    const target = args[1]; if (!target || target.startsWith("-")) throw new Error("TraeX model prompt prepare requires an Agent target");
    const values = parseUniqueOptions(args.slice(2), ["--model", "--model-revision", "--prompt-sha256", "--agent-session", "--timeout"]);
    const model = values.get("--model"); const revisionText = values.get("--model-revision"); const promptSha256 = values.get("--prompt-sha256"); const sessionText = values.get("--agent-session");
    if (!model || !revisionText || !promptSha256 || !sessionText) throw new Error("TraeX model prompt prepare requires model, revision, digest, and Agent session");
    const revision = Number(revisionText); if (!Number.isInteger(revision) || revision < 1) throw new Error("Invalid model revision");
    if (!/^[a-f0-9]{64}$/.test(promptSha256)) throw new Error("Invalid prompt SHA-256");
    const agentSession = parseManagedSession(sessionText, "model prompt");
    return { kind: "model-prompt-prepare", target, model, revision, promptSha256, agentSession, timeoutMs: parseTimeout(values.get("--timeout"), "model prompt") };
  }
  if (action === "commit") {
    const operationId = args[1]; const text = args[2]; if (!operationId || !text) throw new Error("TraeX model prompt commit requires operation ID and text");
    const values = parseUniqueOptions(args.slice(3), ["--prompt-sha256", "--timeout"]); const promptSha256 = values.get("--prompt-sha256");
    if (!/^[a-f0-9]{64}$/.test(operationId) || !promptSha256 || !/^[a-f0-9]{64}$/.test(promptSha256)) throw new Error("Invalid model prompt commit identity");
    return { kind: "model-prompt-commit", operationId, text, promptSha256, timeoutMs: parseTimeout(values.get("--timeout"), "model prompt") };
  }
  throw new Error("TraeX model prompt requires prepare or commit");
}

function parseUniqueOptions(args: readonly string[], allowed: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) { const option = args[index]; const value = args[index + 1]; if (!option || !allowed.includes(option)) throw new Error(`Unknown option: ${option}`); if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}`); if (values.has(option)) throw new Error(`Duplicate ${option} option`); values.set(option, value); }
  return values;
}
function parseTimeout(value: string | undefined, label: string): number { if (value === undefined) return 10_000; if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 300_000) throw new Error(`Invalid ${label} timeout`); return Number(value); }
function parseManagedSession(value: string, label: string): { source: string; agent: string; kind: "id"; value: string } { let decoded: unknown; try { decoded = JSON.parse(value); } catch { throw new Error(`TraeX ${label} Agent session is invalid`); } const record = decoded && typeof decoded === "object" ? decoded as Record<string, unknown> : {}; if (record.source !== "herdr-traex-shim" || record.agent !== "traex" || record.kind !== "id" || typeof record.value !== "string" || !SESSION_ID.test(record.value)) throw new Error(`TraeX ${label} Agent session is invalid`); return { source: record.source, agent: record.agent, kind: "id", value: record.value }; }

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
      if (record.source === "herdr:codex" && record.agent === "codex") {
        projected.agent_session = { ...record, source: "herdr-traex-shim", agent: "traex" };
      }
    }
  }
  return projected;
}

export function encodeLaunchRequest(executable: string, args: readonly string[]): Buffer {
  if (!isAbsolute(executable)) throw new Error("TraeX executable path must be absolute");
  if ([executable, ...args].some((value) => value.includes("\0"))) throw new Error("Launch arguments cannot contain NUL bytes");
  return Buffer.from(`${[executable, ...args].join("\0")}\0`);
}

export async function runHerdrTraexStart(input: TraexStartInput, config: TraexLaunchConfig, dependencies: TraexStartDependencies): Promise<Record<string, unknown>> {
  rejectCallerSessionIdentity(input.traexArgs);
  const launchCorrelationId = dependencies.generateSessionId();
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
      "--session-id", launchCorrelationId,
      ...input.traexArgs
    ]));
    // Once pane.run is invoked, its command may have reached the terminal even
    // if the CLI later returns an error. Fence all later failures as uncertain.
    launched = true;
    await dependencies.runHerdr(["pane", "run", input.paneId, launchCommand(config.launcher, requestId)], input.timeoutMs);
    const process = await waitForTraexProcess(input.paneId, config.traex, deadline, dependencies);
    const processStartTicks = await dependencies.processStartTicks(process.pid);
    if (!processStartTicks) throw new Error("TraeX process identity disappeared before reporter startup");
    await dependencies.startReporter({ paneId: input.paneId, name: input.name, executable: config.traex, pid: process.pid, processStartTicks, launchCorrelationId, reporter: config.reporter });
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

function rejectCallerSessionIdentity(args: readonly string[]): void {
  if (args.some((arg) => arg === "--session-id" || arg.startsWith("--session-id=") || arg === "--resume" || arg.startsWith("--resume="))) {
    throw new Error("TraeX session identity is owned by the Herdr shim");
  }
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
  let attempt = 0;
  while (first || dependencies.now() <= deadline) {
    first = false;
    const info = parseProcessInfo((await dependencies.runHerdr(["pane", "process-info", "--pane", paneId])).stdout);
    for (const process of info.foreground) {
      if (await dependencies.processExecutable(process.pid) === executable) return process;
    }
    await dependencies.sleep(pollingDelay(attempt++));
  }
  throw new Error("Timed out waiting for the TraeX process");
}

async function waitForManagedAgent(input: TraexStartInput, deadline: number, dependencies: TraexStartDependencies): Promise<Record<string, unknown>> {
  let first = true;
  let attempt = 0;
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
    await dependencies.sleep(pollingDelay(attempt++));
  }
  throw new Error("Timed out waiting for managed TraeX identity");
}

export function pollingDelay(attempt: number): number { return Math.min(1_000, 50 * (2 ** Math.max(0, Math.floor(attempt)))); }

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

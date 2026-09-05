import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseHerdrShimInvocation, projectTraexAgentJson, runHerdrTraexPrompt, runHerdrTraexStart, type TraexLaunchConfig, type TraexPromptCommandResult, type TraexStartDependencies } from "../runtime/herdr-traex-shim.js";
import { findTraexSessionPeer } from "../runtime/traex-session-peer.js";
import { steerTraexTurn } from "../runtime/traex-native-steering.js";
import { TraexPromptTranscriptReader } from "../runtime/traex-prompt-settlement.js";
import { listTraexModels } from "../runtime/traex-model-protocol.js";
import { commitTraexModelPrompt, prepareTraexModelPrompt } from "../runtime/traex-model-prompt.js";

async function main(): Promise<void> {
  const configPath = process.env.HERDR_TRAEX_SHIM_CONFIG;
  if (!configPath) throw new Error("HERDR_TRAEX_SHIM_CONFIG is not set by the installed launcher");
  const config = parseConfig(JSON.parse(await readFile(configPath, "utf8")));
  const invocation = parseHerdrShimInvocation(process.argv.slice(2));
  if (invocation.kind === "project") {
    const delegated = await runProjected(config.realHerdr, invocation.argv);
    let stdout = delegated.stdout;
    try { stdout = `${JSON.stringify(projectTraexAgentJson(JSON.parse(stdout)))}\n`; } catch { /* Preserve non-JSON native output. */ }
    if (stdout) process.stdout.write(stdout);
    if (delegated.stderr) process.stderr.write(delegated.stderr);
    process.exitCode = delegated.exitCode;
    return;
  }
  if (invocation.kind === "prompt-traex") {
    const reader = new TraexPromptTranscriptReader(resolve(dirname(config.sessionPeersDir), "sessions"));
    const outcome = await runHerdrTraexPrompt(invocation, {
      resolveAgent: async (target) => projectTraexAgentJson(parseAgent((await run(config.realHerdr, ["agent", "get", target], 10_000)).stdout)) as ReturnType<typeof parseAgent>,
      openTranscript: (session, expectedPrompt) => reader.open(session, expectedPrompt),
      submit: (argv, timeoutMs) => runCaptured(config.realHerdr, argv, timeoutMs === null ? undefined : timeoutMs + 10_000),
      currentAgent: async (target) => projectTraexAgentJson(parseAgent((await run(config.realHerdr, ["agent", "get", target], 10_000)).stdout)) as ReturnType<typeof parseAgent>,
      sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
      now: Date.now
    });
    let stdout = outcome.stdout;
    try { stdout = `${JSON.stringify(projectTraexAgentJson(JSON.parse(stdout)))}\n`; } catch { /* Preserve non-JSON native output. */ }
    if (stdout) process.stdout.write(stdout.endsWith("\n") ? stdout : `${stdout}\n`);
    if (outcome.stderr) process.stderr.write(outcome.stderr.endsWith("\n") ? outcome.stderr : `${outcome.stderr}\n`);
    process.exitCode = outcome.exitCode;
    return;
  }
  if (invocation.kind === "steer-traex") {
    const rawTarget = parseAgent((await run(config.realHerdr, ["agent", "get", invocation.target], invocation.timeoutMs)).stdout);
    const target = projectTraexAgentJson(rawTarget) as typeof rawTarget;
    const session = target.agent_session;
    if (target.display_agent !== "traex" || !session || session.source !== "herdr-traex-shim" || session.kind !== "id" || typeof session.value !== "string") {
      throw Object.assign(new Error("Target does not expose a shim-managed TraeX native session"), { code: "agent_steer_unsupported" });
    }
    if (session.source !== invocation.agentSession.source || target.agent !== invocation.agentSession.agent || session.kind !== invocation.agentSession.kind || session.value !== invocation.agentSession.value) {
      process.stdout.write(`${JSON.stringify({ id: "cli:agent:steer", result: { type: "agent_steered", status: "not-active", reason: "Agent session identity changed" } })}\n`);
      return;
    }
    const peer = await findTraexSessionPeer(config.sessionPeersDir, session.value);
    if (!peer) throw Object.assign(new Error("TraeX native session peer is unavailable"), { code: "agent_steer_unsupported" });
    const result = await steerTraexTurn({ peer, expectedTurnId: invocation.turnId, text: invocation.text, idempotencyKey: invocation.idempotencyKey }, { operationDir: config.steeringOperationDir, timeoutMs: invocation.timeoutMs });
    process.stdout.write(`${JSON.stringify({ id: "cli:agent:steer", result: { type: "agent_steered", ...result } })}\n`);
    return;
  }
  if (invocation.kind === "model-list-traex") {
    const rawTarget = parseAgent((await run(config.realHerdr, ["agent", "get", invocation.target], invocation.timeoutMs)).stdout);
    const target = projectTraexAgentJson(rawTarget) as typeof rawTarget;
    const session = target.agent_session;
    if (target.display_agent !== "traex" || target.agent !== "traex" || !session || session.source !== invocation.agentSession.source || session.kind !== invocation.agentSession.kind || session.value !== invocation.agentSession.value) {
      throw Object.assign(new Error("Agent session identity changed"), { code: "agent_model_list_stale" });
    }
    const peer = await findTraexSessionPeer(config.sessionPeersDir, invocation.agentSession.value);
    if (!peer) throw Object.assign(new Error("TraeX native session peer is unavailable"), { code: "agent_model_list_unsupported" });
    const models = await listTraexModels(peer, { timeoutMs: invocation.timeoutMs });
    process.stdout.write(`${JSON.stringify({ id: "cli:agent:model-list", result: { type: "agent_models", models } })}\n`);
    return;
  }
  const modelPromptOperationDir = resolve(dirname(config.steeringOperationDir), "model-prompt-operations");
  if (invocation.kind === "model-prompt-prepare") {
    const rawTarget = parseAgent((await run(config.realHerdr, ["agent", "get", invocation.target], invocation.timeoutMs)).stdout);
    const target = projectTraexAgentJson(rawTarget) as typeof rawTarget; const session = target.agent_session;
    if (target.display_agent !== "traex" || target.agent !== "traex" || target.agent_status !== "idle" && target.agent_status !== "done" || !session || session.source !== invocation.agentSession.source || session.kind !== invocation.agentSession.kind || session.value !== invocation.agentSession.value) throw Object.assign(new Error("Agent session identity or state changed"), { code: "agent_model_prompt_stale" });
    const peer = await findTraexSessionPeer(config.sessionPeersDir, invocation.agentSession.value); if (!peer) throw Object.assign(new Error("TraeX native session peer is unavailable"), { code: "agent_model_prompt_unsupported" });
    const models = await listTraexModels(peer, { timeoutMs: invocation.timeoutMs });
    if (!models.some((entry) => entry.name === invocation.model)) throw Object.assign(new Error("Selected model is no longer available"), { code: "agent_model_prompt_stale" });
    const result = await prepareTraexModelPrompt({ peer, target: invocation.target, model: invocation.model, revision: invocation.revision, promptSha256: invocation.promptSha256 }, { operationDir: modelPromptOperationDir, timeoutMs: invocation.timeoutMs });
    process.stdout.write(`${JSON.stringify({ id: "cli:agent:model-prompt:prepare", result: { type: "agent_model_prompt", ...result } })}\n`); return;
  }
  if (invocation.kind === "model-prompt-commit") {
    const result = await commitTraexModelPrompt({ operationId: invocation.operationId, text: invocation.text, promptSha256: invocation.promptSha256 }, { operationDir: modelPromptOperationDir, timeoutMs: invocation.timeoutMs });
    process.stdout.write(`${JSON.stringify({ id: "cli:agent:model-prompt:commit", result: { type: "agent_model_prompt", ...result } })}\n`); return;
  }
  if (invocation.kind !== "start-traex") throw new Error("Shim entrypoint accepts only managed TraeX commands");
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
    processExecutable: async (pid) => { try { return realpathSync(await readlink(`/proc/${pid}/exe`)); } catch { return null; } },
    processStartTicks: async (pid) => processStartTicks(pid),
    startReporter: (input) => {
      const child = spawn(process.execPath, [config.reporter, JSON.stringify(input)], { detached: true, stdio: "ignore", env: process.env });
      child.unref();
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    generateSessionId: randomUUID
  };
}

function run(executable: string, args: string[], timeoutMs = 30_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => execFile(executable, args, { timeout: timeoutMs, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error(`Official Herdr command failed (${args.slice(0, 2).join(" " )})`, { cause: error }));
    else resolve({ stdout, stderr });
  }));
}

function runProjected(executable: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => execFile(executable, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    const exitCode = error && typeof error === "object" && "code" in error && typeof error.code === "number" ? error.code : error ? 1 : 0;
    resolve({ stdout, stderr, exitCode });
  }));
}

function runCaptured(executable: string, args: string[], timeout?: number): Promise<TraexPromptCommandResult> {
  return new Promise((resolveResult) => execFile(executable, args, { ...(timeout === undefined ? {} : { timeout }), encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    const exitCode = error && typeof error === "object" && "code" in error && typeof error.code === "number" ? error.code : error ? 1 : 0;
    resolveResult({ exitCode, stdout, stderr });
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
  const keys = ["realHerdr", "traex", "launcher", "reporter", "requestDir", "sessionPeersDir", "steeringOperationDir", "validatedHerdrVersion"] as const;
  for (const key of keys) if (typeof record[key] !== "string" || !record[key]) throw new Error(`Invalid TraeX shim config field: ${key}`);
  return Object.fromEntries(keys.map((key) => [key, record[key]])) as unknown as TraexLaunchConfig;
}

function parseAgent(stdout: string): Record<string, unknown> & { agent_session?: { source?: unknown; kind?: unknown; value?: unknown } } {
  const envelope = JSON.parse(stdout) as { result?: { agent?: unknown } };
  if (!envelope.result?.agent || typeof envelope.result.agent !== "object") throw new Error("Official Herdr returned an invalid Agent response");
  return envelope.result.agent as Record<string, unknown> & { agent_session?: { source?: unknown; kind?: unknown; value?: unknown } };
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  main().catch((error) => {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "agent_start_failed";
    process.stderr.write(`${code}: ${error instanceof Error ? error.message : "TraeX start failed"}\n`);
    process.exitCode = 1;
  });
}

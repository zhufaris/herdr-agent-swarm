import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { ExecFileCommandRunner } from "../src/infra/command-runner.js";
import { HerdrCliAdapter } from "../src/adapters/herdr-adapter.js";
import { HerdrPaneHost } from "../src/runtime/herdr/pane-host.js";
import { CodexDriver } from "../src/runtime/agents/codex-driver.js";
import { ClaudeCodeDriver } from "../src/runtime/agents/claude-code-driver.js";
import { TraexDriver } from "../src/runtime/agents/traex-driver.js";
import { AgentDriverRegistry } from "../src/runtime/agents/agent-driver.js";
import { WorktreeManager } from "../src/runtime/worktree-manager.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";
import { InstanceWorkScheduler } from "../src/events/instance-work-scheduler.js";
import { InstanceMessagingWorkflow } from "../src/coordinator/instance-messaging-workflow.js";
import { InstanceControlWorkflow } from "../src/coordinator/instance-control-workflow.js";
import { PrimaryToolGateway } from "../src/runtime/primary-tool-gateway.js";
import { APPROVAL_POLICY_VERSION, classifyAction, fingerprintAction } from "../src/domain/approval-policy.js";

const execute = process.argv.includes("--execute");
const herdrBin = process.env.HERDR_BIN || "herdr";
const codexBin = process.env.CODEX_BIN || "codex";
const traexBin = process.env.TRAEX_BIN || "traex";
const claudeBin = process.env.CLAUDE_CODE_BIN || "claude";
const piBin = process.env.PI_BIN || "pi";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mcpEntrypoint = join(root, "dist/cli/primary-tools-mcp.js");
const versions = { herdr: await version(herdrBin), traex: await version(traexBin), codex: await version(codexBin), claudeCode: await version(claudeBin), pi: await optionalVersion(piBin) };
const help = await command(herdrBin, ["agent", "start", "--help"]);
const available = { traex: await executableExists(traexBin), codex: help.includes("codex") && await executableExists(codexBin), claudeCode: help.includes("claude") && await executableExists(claudeBin), pi: help.includes("pi") && await executableExists(piBin) };
const evidence: Record<string, unknown> = { mode: execute ? "execute" : "preflight", versions, available, productPath: false, executed: [] };
if (!execute) { process.stdout.write(`${JSON.stringify(evidence, null, 2)}\nRun with --execute inside a Herdr pane for the bounded product acceptance.\n`); process.exit(available.codex && available.traex ? 0 : 2); }
if (!process.env.HERDR_PANE_ID || !process.env.HERDR_WORKSPACE_ID) throw new Error("--execute requires a current Herdr pane and workspace");
if (!available.codex || !available.traex) throw new Error("--execute requires Codex and TraeX");
await access(mcpEntrypoint, constants.R_OK);

const temporary = await mkdtemp(join(tmpdir(), "herdr-agent-swarm-smoke-"));
const smokeRunId = temporary.slice(-6).toLowerCase();
const smokeProjectId = `smoke-${smokeRunId}`;
const repository = join(temporary, "project");
const state = join(temporary, "state");
const databasePath = join(state, "bridge.db");
const socketPath = join(state, "primary-tools.sock");
const runner = new ExecFileCommandRunner(180_000);
let store: SqliteBindingStore | undefined; let gateway: PrimaryToolGateway | undefined; let scheduler: InstanceWorkScheduler | undefined; let control: InstanceControlWorkflow | undefined;
const ownedPanes = new Set<string>();
try {
  await command("git", ["init", repository]); await command("git", ["-C", repository, "config", "user.email", "solo-smoke@example.invalid"]); await command("git", ["-C", repository, "config", "user.name", "Solo Smoke"]);
  await writeFile(join(repository, "README.md"), "isolated smoke repository\n"); await command("git", ["-C", repository, "add", "README.md"]); await command("git", ["-C", repository, "commit", "-m", "smoke fixture"]);
  const project = { id: smokeProjectId, displayName: "Smoke Project", description: "isolated acceptance", workspaceId: process.env.HERDR_WORKSPACE_ID, cwd: repository, maxInstances: 4, instances: [] };
  const herdr = new HerdrCliAdapter(runner, herdrBin, 180_000); const paneHost = new HerdrPaneHost(herdr);
  const drivers = new AgentDriverRegistry([new CodexDriver(herdr, codexBin, 180_000, true), new ClaudeCodeDriver(herdr, claudeBin, 180_000, true), new TraexDriver(herdr, traexBin, 180_000)]);
  store = new SqliteBindingStore(databasePath); scheduler = new InstanceWorkScheduler({ store, drivers });
  let messaging = new InstanceMessagingWorkflow({ store, drivers, paneHost, wake: () => undefined, idFactory: randomUUID });
  gateway = new PrimaryToolGateway(socketPath, process.execPath, [mcpEntrypoint], store, messaging, pino({ enabled: false })); await gateway.start();
  control = new InstanceControlWorkflow({ projects: [project], store, paneHost, drivers, worktrees: new WorktreeManager(runner, { timeoutMs: 180_000 }), idFactory: randomUUID, primaryTools: gateway });
  const primary = await control.create({ actor: { kind: "human", userId: "smoke", channel: "local" }, projectId: project.id, name: "primary", role: "primary", agentKind: "traex", model: null, start: true });
  ownedPanes.add(primary.pendingRuntimeRef?.paneId ?? primary.runtimeRef!.paneId);
  await prepareTemporaryRepositoryTrust(primary.runtimeRef!.paneId, "traex");
  const worker = await control.create({ actor: { kind: "human", userId: "smoke", channel: "local" }, projectId: project.id, name: "worker", role: "worker", agentKind: "traex", model: null, start: true });
  ownedPanes.add(worker.pendingRuntimeRef?.paneId ?? worker.runtimeRef!.paneId);
  await prepareTemporaryRepositoryTrust(worker.runtimeRef!.paneId, "traex");
  await messaging.submit({ idempotencyKey: "primary-smoke-turn", actor: { kind: "human", userId: "smoke", channel: "local" }, projectId: project.id, targetInstanceId: primary.id, content: { kind: "turn", text: `Use the herdr_agent_swarm MCP tools. First list instances. Then call prompt_instance for Worker ${worker.id} with task "Reply with exactly WORKER_OK. Do not modify files." and idempotencyKey "primary-to-worker-smoke". Do not create, remove, or retarget instances. After the tool accepts the task, reply with exactly PRIMARY_DISPATCHED.` } });
  await scheduler.drain(primary.id);
  await scheduler.drain(worker.id);
  const dispatchedWorkerTurn = store.listInstanceTurns(worker.id).find((turn) => turn.idempotencyKey === "primary-to-worker-smoke");
  if (!dispatchedWorkerTurn) throw new Error("Primary completed without creating the expected durable Worker turn");
  if (dispatchedWorkerTurn.state !== "completed") throw new Error(`Worker turn ended in ${dispatchedWorkerTurn.state}: ${dispatchedWorkerTurn.error ?? "no error recorded"}`);
  const primaryTurnsBeforeRestart = store.listInstanceTurns(primary.id).length; const workerTurnsBeforeRestart = store.listInstanceTurns(worker.id).length;
  if (primaryTurnsBeforeRestart !== 1 || workerTurnsBeforeRestart !== 1) throw new Error("Worker completion unexpectedly triggered a Primary turn or duplicate Worker turn");
  await scheduler.stop(); await gateway.stop(); store.close(); gateway = undefined; store = new SqliteBindingStore(databasePath);
  scheduler = new InstanceWorkScheduler({ store, drivers }); messaging = new InstanceMessagingWorkflow({ store, drivers, paneHost, wake: () => undefined, idFactory: randomUUID });
  gateway = new PrimaryToolGateway(socketPath, process.execPath, [mcpEntrypoint], store, messaging, pino({ enabled: false })); await gateway.start();
  control = new InstanceControlWorkflow({ projects: [project], store, paneHost, drivers, worktrees: new WorktreeManager(runner, { timeoutMs: 180_000 }), idFactory: randomUUID, primaryTools: gateway });
  const duplicate = await messaging.submit({ idempotencyKey: "primary-to-worker-smoke", actor: { kind: "primary-agent", projectId: project.id, instanceId: primary.id, generation: primary.generation, parentTurnId: store.listInstanceTurns(primary.id)[0]!.id }, projectId: project.id, targetInstanceId: worker.id, content: { kind: "turn", text: "Reply with exactly WORKER_OK. Do not modify files." } });
  if (duplicate.inserted) throw new Error("Restart accepted an already durable Worker turn again");
  await scheduler.drain(worker.id);
  const afterRestart = store.listInstanceTurns(worker.id); if (afterRestart.length !== 1 || afterRestart[0]?.state !== "completed") throw new Error("Restart changed or replayed durable Worker work");
  const remoteAction = { kind: "external-effect" as const, effect: "create-issue", resource: "smoke://issue" };
  const remoteTier = classifyAction(remoteAction, { workspaceRoots: [repository], remotelyApprovableEffects: ["create-issue"] }); if (remoteTier !== "remote-confirmation") throw new Error("Expected remote confirmation tier");
  const identity = { actorId: "feishu:smoke", projectId: project.id, instanceId: primary.id, instanceGeneration: primary.generation, actionFingerprint: fingerprintAction(remoteAction), resourceScope: "smoke://issue", policyVersion: APPROVAL_POLICY_VERSION };
  const request = store.createApprovalRequest({ ...identity, id: randomUUID(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const approved = store.resolveApprovalRequest({ requestId: request.id, actorId: identity.actorId, approved: true, now: new Date().toISOString(), grantId: randomUUID() }); if (!approved.grant || store.consumeApprovalGrant({ ...identity, grantId: approved.grant.id, now: new Date().toISOString() }) !== "consumed") throw new Error("Remote confirmation grant was not consumed exactly once");
  const localOnly = classifyAction({ kind: "git-push", remote: "origin", branch: "main" }, { workspaceRoots: [repository], remotelyApprovableEffects: ["create-issue"] }); if (localOnly !== "local-only") throw new Error("git push must remain local-only");
  await writeFile(join(repository, ".worktree/worker", "dirty.txt"), "retain me\n");
  await control.stop({ actor: { kind: "human", userId: "smoke", channel: "local" }, instanceId: primary.id }); ownedPanes.delete(primary.runtimeRef!.paneId);
  await control.stop({ actor: { kind: "human", userId: "smoke", channel: "local" }, instanceId: worker.id }); ownedPanes.delete(worker.runtimeRef!.paneId);
  await access(join(repository, ".worktree/worker", "dirty.txt"), constants.R_OK);
  evidence.productPath = true; evidence.executed = [
    { role: "primary", agentKind: "traex", instanceId: primary.id, paneId: primary.runtimeRef!.paneId, turnId: store.listInstanceTurns(primary.id)[0]!.id, result: "completed" },
    { role: "worker", agentKind: "traex", instanceId: worker.id, paneId: worker.runtimeRef!.paneId, turnId: afterRestart[0]!.id, result: "completed" }
  ];
  evidence.assertions = { primaryCalledExistingWorker: true, workerCompletionDidNotTriggerPrimary: true, restartDidNotReplay: true, remoteConfirmationConsumedOnce: true, gitPushLocalOnly: true, dirtyWorktreeRetainedAfterStop: true };
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} catch (error) {
  const diagnostics: Record<string, unknown> = { error: error instanceof Error ? error.message : String(error) };
  if (store) diagnostics.turns = [...store.listAgentInstances(smokeProjectId).flatMap((instance) => store!.listInstanceTurns(instance.id).map((turn) => ({ instance: instance.name, idempotencyKey: turn.idempotencyKey, state: turn.state, error: turn.error })))];
  diagnostics.panes = await Promise.all([...ownedPanes].map(async (paneId) => ({ paneId, output: await command(herdrBin, ["pane", "read", paneId, "--source", "visible", "--format", "text"]).catch((readError) => String(readError)) })));
  process.stderr.write(`${JSON.stringify(diagnostics, null, 2)}\n`);
  throw error;
} finally {
  await scheduler?.stop().catch(() => undefined); await gateway?.stop().catch(() => undefined); store?.close();
  try { for (const paneId of findOwnedPaneIds(parseJson(await command(herdrBin, ["api", "snapshot"])), repository)) ownedPanes.add(paneId); } catch {}
  await Promise.allSettled([...ownedPanes].map((paneId) => command(herdrBin, ["pane", "close", paneId])));
  await rm(temporary, { recursive: true, force: true });
}

async function command(executable: string, args: string[]): Promise<string> { const { stdout, stderr } = await runnerCommand(executable, args); return `${stdout}${stderr}`; }
async function runnerCommand(executable: string, args: string[]) { return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => { import("node:child_process").then(({ execFile }) => execFile(executable, args, { encoding: "utf8", timeout: 180_000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }))); }); }
async function executableExists(executable: string): Promise<boolean> { const candidates = executable.includes("/") ? [executable] : (process.env.PATH || "").split(delimiter).filter(Boolean).map((directory) => join(directory, executable)); for (const candidate of candidates) try { await access(candidate, constants.X_OK); return true; } catch {} return false; }
async function version(executable: string): Promise<string> { const output = await runnerCommand(executable, ["--version"]); return output.stdout.trim().split(/\r?\n/).find(Boolean) ?? output.stderr.trim().split(/\r?\n/).find((line) => !line.startsWith("WARNING:")) ?? "unknown"; }
async function optionalVersion(executable: string): Promise<string | null> { return await executableExists(executable) ? version(executable) : null; }
async function prepareTemporaryRepositoryTrust(paneId: string, kind: "codex" | "claude-code" | "traex"): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const output = await command(herdrBin, ["pane", "read", paneId, "--source", "visible", "--format", "text"]);
    if (output.includes("Do you trust the contents of this directory?") && output.includes("Yes, continue")) await command(herdrBin, ["pane", "send-keys", paneId, "enter"]);
    else if (output.includes("Press t to trust")) await command(herdrBin, ["pane", "send-text", paneId, "t"]);
    else if (kind === "codex" && output.includes("Hooks need review")) await command(herdrBin, ["pane", "send-keys", paneId, "down", "down", "enter"]);
    else if (kind === "codex" && output.includes("hook needs review")) await command(herdrBin, ["pane", "send-keys", paneId, "esc"]);
    else if (kind === "claude-code" && output.includes("Yes, I trust this folder")) await command(herdrBin, ["pane", "send-keys", paneId, "down", "enter"]);
    else {
      const status = findAgentStatus(parseJson(await command(herdrBin, ["agent", "get", paneId])));
      if (status === "idle" || status === "done") return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out preparing ${kind} in temporary trusted repository`);
}
function parseJson(output: string): unknown { const line = output.trim().split(/\r?\n/).findLast((candidate) => candidate.trim().startsWith("{")); return line ? JSON.parse(line) : null; }
function findAgentStatus(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.agent_status === "string") return record.agent_status;
  for (const child of Object.values(record)) { const status = findAgentStatus(child); if (status) return status; }
  return undefined;
}
function findOwnedPaneIds(value: unknown, repositoryRoot: string): string[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>; const found = new Set<string>();
  if (typeof record.pane_id === "string" && typeof record.cwd === "string" && record.cwd.replace(/ \(deleted\)$/, "").startsWith(repositoryRoot)) found.add(record.pane_id);
  for (const child of Object.values(record)) for (const paneId of Array.isArray(child) ? child.flatMap((item) => findOwnedPaneIds(item, repositoryRoot)) : findOwnedPaneIds(child, repositoryRoot)) found.add(paneId);
  return [...found];
}

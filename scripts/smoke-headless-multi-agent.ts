import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
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
import { SqliteStoreKernel } from "../src/store/sqlite-store-kernel.js";
import { InstanceWorkScheduler } from "../src/events/instance-work-scheduler.js";
import { InstanceMessagingWorkflow } from "../src/coordinator/instance-messaging-workflow.js";
import { InstanceControlWorkflow } from "../src/coordinator/instance-control-workflow.js";
import { PromptRunWorkflow } from "../src/coordinator/prompt-run-workflow.js";
import { TurnControlWorkflow } from "../src/coordinator/turn-control-workflow.js";
import { WorkerTurnObserver } from "../src/coordinator/worker-turn-observer.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { InProcessPromptWorkScheduler } from "../src/events/prompt-work-scheduler.js";
import { PrimaryToolGateway } from "../src/runtime/primary-tool-gateway.js";
import { TraexTranscriptReader } from "../src/runtime/traex-transcript.js";
import { APPROVAL_POLICY_VERSION, classifyAction, fingerprintAction } from "../src/domain/approval-policy.js";

const execute = process.argv.includes("--execute");
const traexKind = process.argv.includes("--traex-kind");
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
let traexKindStatus: string | null = null;
if (traexKind) {
  const status = await runnerCommand("bash", [join(root, "scripts/install-herdr-traex-shim.sh"), "status"]);
  traexKindStatus = `${status.stdout}${status.stderr}`.trim();
  if (!traexKindStatus.includes("status: ready")) throw new Error(`TraeX kind shim is not ready: ${traexKindStatus}`);
}
const evidence: Record<string, unknown> = { mode: execute ? "execute" : "preflight", versions, available, traexKind: traexKind ? traexKindStatus : "not requested", productPath: false, executed: [] };
if (!execute) { process.stdout.write(`${JSON.stringify(evidence, null, 2)}\nRun with --execute inside a Herdr pane for the bounded product acceptance.\n`); process.exit(available.codex && available.traex ? 0 : 2); }
if (!process.env.HERDR_PANE_ID || !process.env.HERDR_WORKSPACE_ID) throw new Error("--execute requires a current Herdr pane and workspace");
if (!available.codex || !available.traex) throw new Error("--execute requires Codex and TraeX");
await access(mcpEntrypoint, constants.R_OK);

const temporary = await mkdtemp(join(tmpdir(), "herdr-agent-swarm-smoke-"));
const smokeRunId = temporary.slice(-6).toLowerCase();
const smokeProjectId = `smoke-${smokeRunId}`;
const repository = root;
const state = join(temporary, "state");
const databasePath = join(state, "bridge.db");
const socketPath = join(state, "primary-tools.sock");
const runner = new ExecFileCommandRunner(180_000);
let store: SqliteStoreKernel | undefined; let gateway: PrimaryToolGateway | undefined; let scheduler: InstanceWorkScheduler | undefined; let promptRun: PromptRunWorkflow | undefined; let control: InstanceControlWorkflow | undefined;
const ownedPanes = new Set<string>();
try {
  const project = { id: smokeProjectId, displayName: "Smoke Project", description: "isolated acceptance", workspaceId: process.env.HERDR_WORKSPACE_ID, cwd: repository, maxInstances: 4, instances: [] };
  const herdr = new HerdrCliAdapter(runner, herdrBin, 180_000); const paneHost = new HerdrPaneHost(herdr);
  const drivers = new AgentDriverRegistry([new CodexDriver(herdr, codexBin, 180_000, true), new ClaudeCodeDriver(herdr, claudeBin, 180_000, true), new TraexDriver(herdr, traexBin, 180_000)]);
  store = new SqliteStoreKernel(databasePath);
  const transcriptReader = new TraexTranscriptReader();
  const workerObserver = new WorkerTurnObserver({ store, transcriptReader, wakeInstance: (instanceId) => scheduler?.wake(instanceId), wakeOutbound: () => undefined });
  scheduler = new InstanceWorkScheduler({ store, drivers, observer: workerObserver });
  const promptScheduler = new InProcessPromptWorkScheduler();
  const turnControl = new TurnControlWorkflow({ store, herdr, idFactory: randomUUID, wakePrimary: (bindingId) => promptScheduler.wake({ kind: "prompt-ready", bindingId }), wakeInstance: (instanceId) => scheduler?.wake(instanceId) });
  let messaging = new InstanceMessagingWorkflow({ store, turnControl, wake: (instanceId) => scheduler?.wake(instanceId), idFactory: randomUUID });
  gateway = new PrimaryToolGateway(socketPath, process.execPath, [mcpEntrypoint], store, messaging, pino({ enabled: false })); await gateway.start();
  control = new InstanceControlWorkflow({ projects: [project], store, paneHost, drivers, worktrees: new WorktreeManager(runner, { timeoutMs: 180_000 }), idFactory: randomUUID });

  const bindingId = randomUUID();
  let primary = store.createPendingBinding({ id: bindingId, projectId: project.id, workspaceId: project.workspaceId, chatId: "smoke", topicId: "smoke-topic", rootMessageId: "smoke-root", title: "Smoke Primary" });
  const primaryTools = gateway.issueBinding(bindingId, primary.generation);
  const primaryPane = await paneHost.allocatePane(project.workspaceId, project.cwd, { bindingId, generation: primary.generation, projectId: project.id, placement: "dedicated-tab", title: `smoke-primary-${smokeRunId}`, titlePolicy: "complete", environment: primaryTools.environment });
  ownedPanes.add(primaryPane.paneId);
  primary = store.updateBindingMetadata(bindingId, paneIdentity(primaryPane));
  primary = store.transitionBinding(bindingId, { type: "pane_created" });
  await drivers.get("traex")!.start({ herdrWorkspaceId: project.workspaceId, paneId: primaryPane.paneId, nativeSessionId: null }, { projectId: project.id, name: "primary", model: null, primaryTools });
  await requireAgentReady(primaryPane.paneId, "traex");
  const observedPrimary = await requirePane(paneHost, primaryPane.paneId);
  primary = store.updateBindingMetadata(bindingId, paneIdentity(observedPrimary));
  primary = store.transitionBinding(bindingId, { type: "runtime_started", runtime: observedPrimary.agentState });
  primary = store.transitionBinding(bindingId, { type: "thread_created" });
  primary = store.transitionBinding(bindingId, { type: "activate", runtime: observedPrimary.agentState });

  promptRun = new PromptRunWorkflow({ store, herdr, bus: new BridgeEventBus(), scheduler: promptScheduler, outboundWork: { wake() {} }, logger: pino({ enabled: false }), turnTimeoutMs: 180_000, transcriptReader });
  promptRun.start();
  const workerResult = await control.createWorker({ actor: { kind: "human", userId: "smoke", channel: "local" }, projectId: project.id, bindingId, name: "worker", agentKind: "traex", model: null, start: true });
  if (workerResult.instance.pendingRuntimeRef?.paneId) ownedPanes.add(workerResult.instance.pendingRuntimeRef.paneId);
  if (workerResult.status !== "created" || !workerResult.instance.runtimeRef) throw new Error(`Worker startup failed: ${workerResult.error ?? "runtime was not attached"}`);
  const worker = workerResult.instance;
  ownedPanes.add(worker.runtimeRef.paneId);
  await requireAgentReady(worker.runtimeRef!.paneId, "traex");

  const primaryPromptId = randomUUID();
  const primaryRequest = `Use the herdr_agent_swarm MCP tools. First list instances. Then call prompt_instance for Worker ${worker.id} with task "Reply with exactly WORKER_OK. Do not modify files." and idempotencyKey "primary-to-worker-smoke". Do not create, remove, or retarget instances. After the tool accepts the task, reply with exactly PRIMARY_DISPATCHED.`;
  const primaryView = createQueuedRunCard({ promptId: primaryPromptId, bindingId, bindingGeneration: primary.generation, title: "Primary to Worker smoke", sessionTitle: primary.title, workspaceId: project.workspaceId, paneId: primary.paneId, requestText: primaryRequest, queuePosition: 1, occurredAt: new Date().toISOString() });
  store.acceptPrompt({ prompt: { id: primaryPromptId, bindingId, larkMessageId: `smoke-${primaryPromptId}`, actorOpenId: "smoke", body: primaryRequest }, view: primaryView, rootMessageId: primary.rootMessageId!, answerCard: {} });
  promptScheduler.wake({ kind: "prompt-ready", bindingId });
  await waitFor(() => store!.getPrompt(primaryPromptId)?.state === "delivered", 240_000, "Primary prompt completion");
  await waitFor(() => store!.listInstanceTurns(worker.id).items.some((turn) => turn.idempotencyKey === "primary-to-worker-smoke" && ["completed", "failed", "cancelled", "dispatch-uncertain"].includes(turn.state)), 240_000, "Worker turn completion");
  const dispatchedWorkerTurn = store.listInstanceTurns(worker.id).items.find((turn) => turn.idempotencyKey === "primary-to-worker-smoke");
  if (!dispatchedWorkerTurn) throw new Error("Primary completed without creating the expected durable Worker turn");
  if (dispatchedWorkerTurn.state !== "completed") throw new Error(`Worker turn ended in ${dispatchedWorkerTurn.state}: ${dispatchedWorkerTurn.error ?? "no error recorded"}`);
  if (!dispatchedWorkerTurn.result?.includes("WORKER_OK")) throw new Error(`Worker result did not contain WORKER_OK: ${dispatchedWorkerTurn.result ?? "empty"}`);
  const primaryPromptCountBeforeRestart = countRows(store, "prompt_jobs"); const workerTurnsBeforeRestart = store.listInstanceTurns(worker.id).items.length;
  if (primaryPromptCountBeforeRestart !== 1 || workerTurnsBeforeRestart !== 1) throw new Error("Worker completion unexpectedly triggered a Primary prompt or duplicate Worker turn");
  await promptRun.stop(); promptRun = undefined; await scheduler.stop(); await gateway.stop(); store.close(); gateway = undefined; store = new SqliteStoreKernel(databasePath);
  scheduler = new InstanceWorkScheduler({ store, drivers });
  const restartedTurnControl = new TurnControlWorkflow({ store, herdr, idFactory: randomUUID, wakeInstance: (instanceId) => scheduler?.wake(instanceId) });
  messaging = new InstanceMessagingWorkflow({ store, turnControl: restartedTurnControl, wake: (instanceId) => scheduler?.wake(instanceId), idFactory: randomUUID });
  gateway = new PrimaryToolGateway(socketPath, process.execPath, [mcpEntrypoint], store, messaging, pino({ enabled: false })); await gateway.start();
  control = new InstanceControlWorkflow({ projects: [project], store, paneHost, drivers, worktrees: new WorktreeManager(runner, { timeoutMs: 180_000 }), idFactory: randomUUID });
  await scheduler.drain(worker.id);
  const afterRestart = store.listInstanceTurns(worker.id).items; if (afterRestart.length !== 1 || afterRestart[0]?.state !== "completed") throw new Error("Restart changed or replayed durable Worker work");
  const remoteAction = { kind: "external-effect" as const, effect: "create-issue", resource: "smoke://issue" };
  const remoteTier = classifyAction(remoteAction, { workspaceRoots: [repository], remotelyApprovableEffects: ["create-issue"] }); if (remoteTier !== "remote-confirmation") throw new Error("Expected remote confirmation tier");
  const identity = { actorId: "feishu:smoke", projectId: project.id, instanceId: worker.id, instanceGeneration: worker.generation, actionFingerprint: fingerprintAction(remoteAction), resourceScope: "smoke://issue", policyVersion: APPROVAL_POLICY_VERSION };
  const request = store.createApprovalRequest({ ...identity, id: randomUUID(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const approved = store.resolveApprovalRequest({ requestId: request.id, actorId: identity.actorId, approved: true, now: new Date().toISOString(), grantId: randomUUID() }); if (!approved.grant || store.consumeApprovalGrant({ ...identity, grantId: approved.grant.id, now: new Date().toISOString() }) !== "consumed") throw new Error("Remote confirmation grant was not consumed exactly once");
  const localOnly = classifyAction({ kind: "git-push", remote: "origin", branch: "main" }, { workspaceRoots: [repository], remotelyApprovableEffects: ["create-issue"] }); if (localOnly !== "local-only") throw new Error("git push must remain local-only");
  const workerWorkspace = control.inspect(worker.id).workspace.cwd;
  await control.stop({ actor: { kind: "human", userId: "smoke", channel: "local" }, instanceId: worker.id }); ownedPanes.delete(worker.runtimeRef!.paneId);
  const removalPlan = await control.planRemoval({ actor: { kind: "human", userId: "smoke", channel: "local" }, instanceId: worker.id });
  if (!removalPlan.safe || !await control.confirmRemoval({ actor: { kind: "human", userId: "smoke", channel: "local" }, planId: removalPlan.id })) throw new Error(`Worker cleanup was not safe: ${removalPlan.reason}`);
  await access(workerWorkspace, constants.F_OK).then(() => { throw new Error("Worker worktree still exists after confirmed removal"); }, () => undefined);
  await paneHost.releasePane(primaryPane.paneId); ownedPanes.delete(primaryPane.paneId);
  evidence.productPath = true; evidence.executed = [
    { role: "primary", agentKind: "traex", bindingId, paneId: primaryPane.paneId, turnId: primaryPromptId, result: "completed" },
    { role: "worker", agentKind: "traex", instanceId: worker.id, paneId: worker.runtimeRef!.paneId, turnId: afterRestart[0]!.id, result: "completed" }
  ];
  evidence.assertions = { primaryCalledExistingWorker: true, workerCompletionDidNotTriggerPrimary: true, restartDidNotReplay: true, remoteConfirmationConsumedOnce: true, gitPushLocalOnly: true, cleanWorkerWorktreeRemovedSafely: true };
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} catch (error) {
  const diagnostics: Record<string, unknown> = { error: error instanceof Error ? error.message : String(error) };
  if (store) diagnostics.turns = [...store.listAgentInstances(smokeProjectId).flatMap((instance) => store!.listInstanceTurns(instance.id).items.map((turn) => ({ instance: instance.name, idempotencyKey: turn.idempotencyKey, state: turn.state, error: turn.error })))];
  diagnostics.agents = await Promise.all([...ownedPanes].map(async (paneId) => ({ paneId, state: await command(herdrBin, ["agent", "get", paneId]).then(parseJson).catch((readError) => String(readError)) })));
  process.stderr.write(`${JSON.stringify(diagnostics, null, 2)}\n`);
  throw error;
} finally {
  await promptRun?.stop().catch(() => undefined); await scheduler?.stop().catch(() => undefined); await gateway?.stop().catch(() => undefined); store?.close();
  await Promise.allSettled([...ownedPanes].map((paneId) => command(herdrBin, ["pane", "close", paneId])));
  await rm(temporary, { recursive: true, force: true });
}

async function command(executable: string, args: string[]): Promise<string> { const { stdout, stderr } = await runnerCommand(executable, args); return `${stdout}${stderr}`; }
async function runnerCommand(executable: string, args: string[]) { return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => { import("node:child_process").then(({ execFile }) => execFile(executable, args, { encoding: "utf8", timeout: 180_000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }))); }); }
async function executableExists(executable: string): Promise<boolean> { const candidates = executable.includes("/") ? [executable] : (process.env.PATH || "").split(delimiter).filter(Boolean).map((directory) => join(directory, executable)); for (const candidate of candidates) try { await access(candidate, constants.X_OK); return true; } catch {} return false; }
async function version(executable: string): Promise<string> { const output = await runnerCommand(executable, ["--version"]); return output.stdout.trim().split(/\r?\n/).find(Boolean) ?? output.stderr.trim().split(/\r?\n/).find((line) => !line.startsWith("WARNING:")) ?? "unknown"; }
async function optionalVersion(executable: string): Promise<string | null> { return await executableExists(executable) ? version(executable) : null; }
async function requireAgentReady(paneId: string, kind: "codex" | "claude-code" | "traex"): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const status = findAgentStatus(parseJson(await command(herdrBin, ["agent", "get", paneId])));
    if (status === "idle" || status === "done") return;
    if (status === "blocked") throw new Error(`${kind} requires local input in ${paneId}; resolve it in Herdr and rerun the smoke`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for structured ${kind} readiness`);
}
function parseJson(output: string): unknown { const line = output.trim().split(/\r?\n/).findLast((candidate) => candidate.trim().startsWith("{")); return line ? JSON.parse(line) : null; }
function findAgentStatus(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.agent_status === "string") return record.agent_status;
  for (const child of Object.values(record)) { const status = findAgentStatus(child); if (status) return status; }
  return undefined;
}
function paneIdentity(pane: import("../src/domain/types.js").HerdrPane) {
  return { paneId: pane.paneId, traexSessionId: pane.terminalId ?? null, agentSessionSource: pane.agentSession?.source ?? null, agentSessionAgent: pane.agentSession?.agent ?? null, agentSessionKind: pane.agentSession?.kind ?? null, agentSessionValue: pane.agentSession?.value ?? null };
}
async function requirePane(paneHost: HerdrPaneHost, paneId: string) {
  const pane = await paneHost.inspectPane(paneId);
  if (!pane?.agentSession || pane.agentKind !== "traex") throw new Error(`Primary pane ${paneId} has no verified TraeX session`);
  return pane;
}
async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error(`Timed out waiting for ${label}`);
}
function countRows(store: SqliteStoreKernel, table: string): number { return (store.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count; }

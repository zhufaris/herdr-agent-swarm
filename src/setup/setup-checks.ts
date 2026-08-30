import { stat } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { ExecFileCommandRunner, type CommandRunner } from "../infra/command-runner.js";
import { discoverExecutable } from "../runtime/agents/agent-availability.js";
import type { SetupCheck, SetupCheckPolicy, SetupContext, SetupDraft } from "./setup-types.js";

export function evaluateSetupChecks(checks: readonly SetupCheck[]): SetupCheckPolicy {
  const hasFailures = checks.some((check) => check.status === "fail");
  const hasSkipped = checks.some((check) => check.status === "skipped");
  return {
    canSave: !hasFailures,
    canStart: !hasFailures && !hasSkipped,
    hasWarnings: checks.some((check) => check.status === "warning"),
    hasSkipped
  };
}

type PortState = "free" | "occupied-managed" | "occupied-other";

interface LocalSetupCheckDependencies {
  runner?: CommandRunner;
  nodeVersion?: string;
  pathValue?: string;
  resolveExecutable?: (executable: string, pathValue?: string) => string | null;
  inspectDirectoryMode?: (path: string) => Promise<number | null>;
  inspectPort?: (host: string, port: number, serviceName: string) => Promise<PortState>;
}

export async function runLocalSetupChecks(draft: SetupDraft, context: SetupContext, dependencies: LocalSetupCheckDependencies = {}): Promise<SetupCheck[]> {
  const runner = dependencies.runner ?? new ExecFileCommandRunner(5_000);
  const resolveExecutable = dependencies.resolveExecutable ?? discoverExecutable;
  const nodeVersion = dependencies.nodeVersion ?? process.versions.node;
  const pathValue = dependencies.pathValue ?? process.env.PATH ?? "";
  const checks: SetupCheck[] = [];
  checks.push(supportsNode(nodeVersion)
    ? { id: "local.node", status: "pass", summary: `Node.js ${nodeVersion} is supported` }
    : { id: "local.node", status: "fail", summary: `Node.js ${nodeVersion} is unsupported`, remediation: "Install Node.js 22.12 or newer." });

  try {
    await runner.run("systemctl", ["--user", "show-environment"], 5_000);
    checks.push({ id: "local.systemd", status: "pass", summary: "The user systemd manager is available" });
  } catch {
    checks.push({ id: "local.systemd", status: "fail", summary: "The user systemd manager is unavailable", remediation: "Enable a user systemd session before installing the service." });
  }

  const inspectDirectoryMode = dependencies.inspectDirectoryMode ?? directoryMode;
  const mode = await inspectDirectoryMode(context.configDirectory);
  checks.push(mode === null || (mode & 0o077) === 0
    ? { id: "local.config-directory", status: "pass", summary: mode === null ? "The configuration directory can be created privately" : "The configuration directory is private" }
    : { id: "local.config-directory", status: "fail", summary: "The configuration directory is accessible to other users", remediation: `Run chmod 700 ${context.configDirectory} before saving configuration.` });

  const host = draft.environment.BRIDGE_HTTP_HOST ?? "127.0.0.1";
  const port = Number(draft.environment.BRIDGE_HTTP_PORT ?? "8787");
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(host);
  checks.push(loopback
    ? { id: "local.http-host", status: "pass", summary: `HTTP host ${host} is loopback-only` }
    : { id: "local.http-host", status: "fail", summary: `HTTP host ${host} is not loopback-only`, remediation: "Use 127.0.0.1, localhost, or ::1." });

  const portState = Number.isInteger(port) && port >= 1 && port <= 65535
    ? await (dependencies.inspectPort ?? ((targetHost, targetPort, service) => inspectPortOwner(targetHost, targetPort, service, runner)))(host, port, context.serviceName)
    : "occupied-other";
  checks.push(portState === "occupied-other"
    ? { id: "local.http-port", status: "fail", summary: `Port ${port} is occupied by another process`, remediation: "Choose a free loopback port or stop the unrelated listener." }
    : { id: "local.http-port", status: "pass", summary: portState === "free" ? `Port ${port} is available` : `Port ${port} belongs to ${context.serviceName}` });

  for (const [name, fallback] of requiredExecutables(draft)) {
    const executable = draft.environment[name] ?? fallback;
    const id = `local.executable.${name.replace(/_BIN$/, "").toLowerCase().replace("claude_code", "claude-code")}`;
    checks.push(resolveExecutable(executable, pathValue)
      ? { id, status: "pass", summary: `${executable} is executable` }
      : { id, status: "fail", summary: `${executable} is unavailable`, remediation: `Install ${executable} or configure ${name} with an executable path.` });
  }
  return checks;
}

function supportsNode(version: string): boolean {
  const match = /^(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 12);
}

function requiredExecutables(draft: SetupDraft): Array<[string, string]> {
  const required = new Map<string, string>([["HERDR_BIN", "herdr"], ["TRAEX_BIN", "traex"]]);
  const mapping = { traex: ["TRAEX_BIN", "traex"], codex: ["CODEX_BIN", "codex"], "claude-code": ["CLAUDE_CODE_BIN", "claude"], pi: ["PI_BIN", "pi"] } as const;
  for (const project of draft.registry.projects) for (const instance of project.instances ?? []) {
    const [name, fallback] = mapping[instance.agent];
    required.set(name, fallback);
  }
  return [...required.entries()];
}

async function directoryMode(path: string): Promise<number | null> {
  try { return (await stat(path)).mode & 0o777; } catch {
    try { await stat(dirname(path)); return null; } catch { return 0o777; }
  }
}

async function inspectPortOwner(host: string, port: number, serviceName: string, runner: CommandRunner): Promise<PortState> {
  const free = await canListen(host, port);
  if (free) return "free";
  try {
    const [{ stdout: pidText }, { stdout: sockets }] = await Promise.all([
      runner.run("systemctl", ["--user", "show", serviceName, "--property=MainPID", "--value"], 5_000),
      runner.run("ss", ["-H", "-ltnp", "sport", "=", `:${port}`], 5_000)
    ]);
    const pid = Number(pidText.trim());
    return pid > 0 && new RegExp(`pid=${pid}(?:,|\\))`).test(sockets) ? "occupied-managed" : "occupied-other";
  } catch { return "occupied-other"; }
}

function canListen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

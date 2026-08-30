import { homedir } from "node:os";
import { resolve } from "node:path";
import { HerdrSetupProbe } from "../adapters/herdr-setup-probe.js";
import { LarkSetupProbe } from "../adapters/lark-setup-probe.js";
import { ExecFileCommandRunner } from "../infra/command-runner.js";
import { runLocalSetupChecks } from "../setup/setup-checks.js";
import { FileSetupConfigRepository } from "../setup/setup-config.js";
import { SetupCancelledError, TerminalSetupPrompts } from "../setup/setup-prompts.js";
import type { SetupContext } from "../setup/setup-types.js";
import { runSetupWorkflow, type SetupOutcome, type SetupWorkflowDependencies } from "../setup/setup-workflow.js";
import { createSetupLifecycleAdapter } from "./service-lifecycle.js";

interface SetupCliOverrides {
  context?: SetupContext;
  dependencies?: SetupWorkflowDependencies;
  runWorkflow?: (dependencies: SetupWorkflowDependencies, context: SetupContext) => Promise<SetupOutcome>;
  writeError?: (message: string) => void;
}

export function resolveSetupContext(environment: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): SetupContext {
  const root = resolve(environment.SWARM_ROOT || cwd);
  const configDirectory = resolve(environment.SWARM_CONFIG_DIR || `${environment.XDG_CONFIG_HOME || `${homedir()}/.config`}/herdr-agent-swarm`);
  const stateDirectory = resolve(environment.SWARM_STATE_DIR || `${environment.XDG_STATE_HOME || `${homedir()}/.local/state`}/herdr-agent-swarm`);
  return {
    root, configDirectory, stateDirectory, cwd: resolve(cwd),
    serviceName: "herdr-agent-swarm.service"
  };
}

export function createSetupCheckDependencies(environment: NodeJS.ProcessEnv) {
  const timeout = positiveMilliseconds(environment.COMMAND_TIMEOUT_MS, 10_000);
  const runner = new ExecFileCommandRunner(timeout);
  return {
    config: new FileSetupConfigRepository(),
    herdr: new HerdrSetupProbe(runner, environment.HERDR_BIN || "herdr", timeout, environment),
    lark: new LarkSetupProbe(),
    runLocalChecks: (draft: Parameters<typeof runLocalSetupChecks>[0], context: SetupContext) => runLocalSetupChecks(draft, context)
  };
}

export function createSetupDependencies(environment: NodeJS.ProcessEnv, skipNetwork: boolean, context = resolveSetupContext(environment)): SetupWorkflowDependencies {
  const lifecycleEnvironment = {
    ...environment, SWARM_ROOT: context.root, SWARM_CONFIG_DIR: context.configDirectory,
    SWARM_STATE_DIR: context.stateDirectory
  };
  return {
    prompts: new TerminalSetupPrompts(),
    ...createSetupCheckDependencies(environment),
    lifecycle: createSetupLifecycleAdapter(lifecycleEnvironment),
    skipNetwork
  };
}

export async function runSetupCli(args: readonly string[], environment: NodeJS.ProcessEnv = process.env, overrides: SetupCliOverrides = {}): Promise<number> {
  const writeError = overrides.writeError ?? ((message) => process.stderr.write(`${message}\n`));
  if (args.some((argument) => argument !== "--skip-network") || args.filter((argument) => argument === "--skip-network").length > 1) {
    writeError("usage: swarm:setup [--skip-network]");
    return 2;
  }
  const context = overrides.context ?? resolveSetupContext(environment);
  const dependencies = overrides.dependencies ?? createSetupDependencies(environment, args.includes("--skip-network"), context);
  if (args.includes("--skip-network")) dependencies.skipNetwork = true;
  try {
    const outcome = await (overrides.runWorkflow ?? runSetupWorkflow)(dependencies, context);
    return outcome.status === "cancelled" ? 130 : 0;
  } catch (error) {
    if (error instanceof SetupCancelledError) return 130;
    writeError(`setup failed: ${safeMessage(error, environment)}`);
    return 1;
  }
}

function positiveMilliseconds(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function safeMessage(error: unknown, environment: NodeJS.ProcessEnv): string {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  const secrets = [environment.LARK_APP_SECRET, environment.LARK_TENANT_ACCESS_TOKEN].filter((value): value is string => Boolean(value));
  return secrets.reduce((safe, secret) => safe.replaceAll(secret, "[redacted]"), message);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSetupCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

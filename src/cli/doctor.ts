import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { validateProjectRegistry } from "../config.js";
import { readEnvironmentFile } from "../runtime/environment-file.js";
import { evaluateSetupChecks } from "../setup/setup-checks.js";
import { renderSetupSummary } from "../setup/setup-summary.js";
import type { SetupCheck, SetupConfigPort, SetupContext, SetupDraft, SetupHerdrProbe, SetupLarkProbe, SetupLifecyclePort } from "../setup/setup-types.js";
import { createSetupCheckDependencies, resolveSetupContext } from "./setup.js";

interface DoctorDependencies {
  config: SetupConfigPort;
  herdr: SetupHerdrProbe;
  lark: SetupLarkProbe;
  lifecycle?: SetupLifecyclePort;
  runLocalChecks(draft: SetupDraft, context: SetupContext): Promise<SetupCheck[]>;
}

interface DoctorCliOverrides {
  context?: SetupContext;
  dependencies?: DoctorDependencies;
  write?: (message: string) => void;
  writeError?: (message: string) => void;
}

export async function runDoctorCli(args: readonly string[], environment: NodeJS.ProcessEnv = process.env, overrides: DoctorCliOverrides = {}): Promise<number> {
  const write = overrides.write ?? ((message) => process.stdout.write(`${message}\n`));
  const writeError = overrides.writeError ?? ((message) => process.stderr.write(`${message}\n`));
  const parsed = parseDoctorArgs(args);
  if (!parsed) { writeError("usage: swarm:doctor [--env <path>] [--projects <path>]"); return 2; }
  const baseContext = overrides.context ?? resolveSetupContext(environment);
  const environmentFile = resolve(parsed.environmentFile ?? `${baseContext.configDirectory}/.env`);
  const projectsFile = resolve(parsed.projectsFile ?? `${baseContext.configDirectory}/projects.json`);
  const context = { ...baseContext, configDirectory: dirname(environmentFile), environmentFile, projectsFile };
  const production = createSetupCheckDependencies(environment);
  const dependencies = overrides.dependencies ?? production;
  try {
    const draft = overrides.dependencies
      ? await dependencies.config.load(context)
      : await loadDraft(environmentFile, projectsFile);
    if (!draft) throw new Error(`configuration not found: ${environmentFile} and ${projectsFile}`);
    const checks = [
      ...await dependencies.config.validate(draft, context),
      ...await dependencies.runLocalChecks(draft, context),
      ...await dependencies.herdr.check(draft, context),
      ...await dependencies.lark.check(draft)
    ];
    const report = { checks, policy: evaluateSetupChecks(checks) };
    write(renderSetupSummary(draft, report, context));
    return report.policy.canSave ? 0 : 1;
  } catch (error) {
    writeError(`doctor failed: ${safeMessage(error, environment)}`);
    return 1;
  }
}

async function loadDraft(environmentFile: string, projectsFile: string): Promise<SetupDraft> {
  const environment = Object.fromEntries(Object.entries(readEnvironmentFile(environmentFile)).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const registry = validateProjectRegistry(JSON.parse(await readFile(projectsFile, "utf8")));
  return { environment, registry };
}

function parseDoctorArgs(args: readonly string[]): { environmentFile?: string; projectsFile?: string } | null {
  const result: { environmentFile?: string; projectsFile?: string } = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if ((flag !== "--env" && flag !== "--projects") || !args[index + 1]) return null;
    const value = args[++index]!;
    if (flag === "--env") { if (result.environmentFile) return null; result.environmentFile = value; }
    else { if (result.projectsFile) return null; result.projectsFile = value; }
  }
  return result;
}

function safeMessage(error: unknown, environment: NodeJS.ProcessEnv): string {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  const secrets = [environment.LARK_APP_SECRET, environment.LARK_TENANT_ACCESS_TOKEN].filter((value): value is string => Boolean(value));
  return secrets.reduce((safe, secret) => safe.replaceAll(secret, "[redacted]"), message);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDoctorCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

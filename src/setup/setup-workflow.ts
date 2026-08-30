import { basename, resolve } from "node:path";
import type { ProjectConfig } from "../domain/types.js";
import { evaluateSetupChecks } from "./setup-checks.js";
import { SetupCancelledError } from "./setup-prompts.js";
import { renderSetupSummary } from "./setup-summary.js";
import type { SetupCheck, SetupCommitResult, SetupConfigPort, SetupContext, SetupDraft, SetupHerdrProbe, SetupLarkProbe, SetupLifecyclePort, SetupPromptPort } from "./setup-types.js";

export type SetupOutcome =
  | { status: "saved"; commit: SetupCommitResult }
  | { status: "installed"; commit: SetupCommitResult }
  | { status: "started"; commit: SetupCommitResult }
  | { status: "cancelled" };

export interface SetupWorkflowDependencies {
  prompts: SetupPromptPort;
  config: SetupConfigPort;
  herdr: SetupHerdrProbe;
  lark: SetupLarkProbe;
  lifecycle: SetupLifecyclePort;
  runLocalChecks(draft: SetupDraft, context: SetupContext): Promise<SetupCheck[]>;
  skipNetwork?: boolean;
  onStep?(step: string): void;
}

export async function runSetupWorkflow(dependencies: SetupWorkflowDependencies, context: SetupContext): Promise<SetupOutcome> {
  const { prompts } = dependencies;
  try {
    const existing = await dependencies.config.load(context);
    dependencies.onStep?.("collect:lark");
    let draft = await collectLark(prompts, existing ?? emptyDraft(context));
    dependencies.onStep?.("collect:project");
    draft = await collectProjects(prompts, dependencies.herdr, draft, existing !== null, context);
    for (;;) {
      const report = await checkDraft(dependencies, draft, context);
      dependencies.onStep?.("review");
      prompts.write(renderSetupSummary(draft, report, context));
      if (!report.policy.canSave) {
        const section = sectionForFailures(report.checks);
        const action = await prompts.choose("Checks failed. Choose a section to correct or cancel", [
          { value: section, label: `Edit ${section} settings` }, { value: "cancel", label: "Cancel setup" }
        ] as const);
        if (action === "cancel") return { status: "cancelled" };
        if (action === "lark") { dependencies.onStep?.("collect:lark"); draft = await collectLark(prompts, draft); }
        else { dependencies.onStep?.("collect:project"); draft = await collectProjects(prompts, dependencies.herdr, draft, false, context); }
        continue;
      }
      if ((report.policy.hasWarnings || report.policy.hasSkipped) && !await prompts.confirm("Continue with the displayed warnings or skipped checks?", false)) return { status: "cancelled" };
      if (await prompts.confirm("Save this configuration?", false)) {
        const commit = await dependencies.config.commit(draft, context);
        return await runLifecycle(dependencies, context, commit, report.policy.canStart);
      }
      const action = await prompts.choose("Choose what to do next", [
        { value: "cancel", label: "Cancel setup" }, { value: "lark", label: "Edit Lark settings" }, { value: "project", label: "Edit project settings" }
      ] as const);
      if (action === "cancel") return { status: "cancelled" };
      if (action === "lark") { dependencies.onStep?.("collect:lark"); draft = await collectLark(prompts, draft); }
      else { dependencies.onStep?.("collect:project"); draft = await collectProjects(prompts, dependencies.herdr, draft, false, context); }
    }
  } catch (error) {
    if (error instanceof SetupCancelledError) return { status: "cancelled" };
    throw error;
  }
}

async function runLifecycle(dependencies: SetupWorkflowDependencies, context: SetupContext, commit: SetupCommitResult, canStart: boolean): Promise<SetupOutcome> {
  const { prompts } = dependencies;
  if (!canStart) return { status: "saved", commit };
  const service = await dependencies.lifecycle.inspect(context);
  prompts.write(`Service: ${service.summary}`);
  dependencies.onStep?.("confirm-install");
  if (!await prompts.confirm(service.installed ? "Update the managed service installation?" : "Install the managed service?", false)) return { status: "saved", commit };
  await dependencies.lifecycle.install(context);
  if (service.active) {
    dependencies.onStep?.("confirm-restart");
    if (!await prompts.confirm("Restart the active service using the safe-restart gate?", false)) return { status: "installed", commit };
    await dependencies.lifecycle.restart(context);
    return { status: "started", commit };
  }
  dependencies.onStep?.("confirm-start");
  if (!await prompts.confirm("Start the managed service?", false)) return { status: "installed", commit };
  await dependencies.lifecycle.start(context);
  return { status: "started", commit };
}

async function checkDraft(dependencies: SetupWorkflowDependencies, draft: SetupDraft, context: SetupContext) {
  const configChecks = await dependencies.config.validate(draft, context);
  const localChecks = await dependencies.runLocalChecks(draft, context);
  const herdrChecks = await dependencies.herdr.check(draft, context);
  const larkChecks: SetupCheck[] = dependencies.skipNetwork ? [
    { id: "lark.auth", status: "skipped", summary: "Lark authentication check explicitly skipped by operator" },
    { id: "lark.chat", status: "skipped", summary: "Lark chat check explicitly skipped by operator" },
    { id: "lark.bot", status: "skipped", summary: "Lark bot identity check explicitly skipped by operator" }
  ] : await dependencies.lark.check(draft);
  const checks = [...configChecks, ...localChecks, ...herdrChecks, ...larkChecks];
  return { checks, policy: evaluateSetupChecks(checks) };
}

function sectionForFailures(checks: readonly SetupCheck[]): "lark" | "project" {
  return checks.some((check) => check.status === "fail" && check.id.startsWith("lark.")) ? "lark" : "project";
}

async function collectLark(prompts: SetupPromptPort, draft: SetupDraft): Promise<SetupDraft> {
  const current = draft.environment;
  const appId = await prompts.text("Lark App ID (developer console credentials)", current.LARK_APP_ID);
  const secret = await prompts.secret("Lark App Secret", Boolean(current.LARK_APP_SECRET));
  const environment = {
    ...current, LARK_APP_ID: appId,
    LARK_APP_SECRET: secret.action === "retain" ? current.LARK_APP_SECRET! : secret.value,
    LARK_CHAT_ID: await prompts.text("Lark topic-group Chat ID", current.LARK_CHAT_ID),
    LARK_BOT_OPEN_ID: await prompts.text("Lark bot Open ID", current.LARK_BOT_OPEN_ID),
    LARK_OPERATOR_OPEN_IDS: await prompts.text("Allowed operator Open IDs (comma separated, optional)", current.LARK_OPERATOR_OPEN_IDS ?? "")
  };
  return { ...draft, environment };
}

async function collectProjects(prompts: SetupPromptPort, herdr: SetupHerdrProbe, draft: SetupDraft, hasExisting: boolean, context: SetupContext): Promise<SetupDraft> {
  if (hasExisting && !await prompts.confirm("Edit the existing project registry?", false)) return draft;
  const workspaces = await herdr.listWorkspaces();
  const current = draft.registry.projects.find((project) => project.id === draft.registry.defaultProjectId);
  const directory = basename(resolve(context.cwd));
  const fallbackId = normalizeProjectId(directory);
  const id = normalizeProjectId(await prompts.text("Project ID", current?.id ?? fallbackId));
  const displayName = await prompts.text("Project display name", current?.displayName ?? directory);
  const spaceName = await prompts.text("Space name", current?.spaceName ?? displayName);
  const preferred = workspaces.find((workspace) => workspace.id === current?.workspaceId) ?? workspaces.find((workspace) => workspace.current) ?? workspaces[0];
  const orderedWorkspaces = preferred ? [preferred, ...workspaces.filter((workspace) => workspace.id !== preferred.id)] : workspaces;
  if (orderedWorkspaces.length === 0) throw new Error("No Herdr workspaces are available");
  const workspaceId = await prompts.choose("Herdr workspace", orderedWorkspaces.map((workspace) => ({ value: workspace.id, label: `${workspace.name}${workspace.current ? " (current)" : ""}` })));
  const cwd = resolve(await prompts.text("Project working directory", current?.cwd ?? context.cwd));
  const project: ProjectConfig = {
    id, displayName, spaceName, description: current?.description ?? displayName, workspaceId: workspaceId || preferred?.id || "", cwd, maxInstances: current?.maxInstances ?? 8
  };
  const projects = current
    ? draft.registry.projects.map((candidate) => candidate.id === current.id ? project : candidate)
    : [...draft.registry.projects, project];
  return { ...draft, registry: { defaultProjectId: id, projects } };
}

function emptyDraft(context: SetupContext): SetupDraft {
  return {
    environment: {
      PROJECTS_CONFIG_PATH: `${context.configDirectory}/projects.json`,
      BRIDGE_DATABASE_PATH: `${context.stateDirectory}/bridge.db`,
      HERDR_BIN: "herdr", TRAEX_BIN: "traex", TRAEX_PERMISSION_MODE: "auto",
      BRIDGE_HTTP_HOST: "127.0.0.1", BRIDGE_HTTP_PORT: "8787"
    },
    registry: { defaultProjectId: "", projects: [] }
  };
}

export function normalizeProjectId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

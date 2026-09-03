import type { ProjectConfig } from "../domain/types.js";
import type { SetupCheckReport, SetupContext, SetupDraft } from "./setup-types.js";

export function renderSetupSummary(draft: SetupDraft, report: SetupCheckReport, context: SetupContext): string {
  const environment = draft.environment;
  const secret = environment.LARK_APP_SECRET ?? "";
  const secretState = secret ? "set" : "missing";
  const allowedUsers = countOpenIds(environment.LARK_ALLOWED_OPEN_IDS);
  const administrators = countOpenIds(environment.LARK_ADMIN_OPEN_IDS);
  const endpoint = `${environment.BRIDGE_HTTP_HOST ?? "127.0.0.1"}:${environment.BRIDGE_HTTP_PORT ?? "8787"}`;
  const projects = draft.registry.projects.flatMap((project) => renderProject(project));
  const redact = (value: string) => secret ? value.replaceAll(secret, "[redacted]") : value;
  const checks = report.checks.map((check) => `  [${check.status.toUpperCase()}] ${check.id}: ${redact(check.summary)}`);
  return [
    "Setup review",
    `Lark application: ${environment.LARK_APP_ID ?? "missing"}`,
    `Lark secret: ${secretState}`,
    `Lark chat: ${environment.LARK_CHAT_ID ?? "missing"}`,
    `Lark bot: ${environment.LARK_BOT_OPEN_ID ?? "missing"}`,
    `Lark allowed users: ${allowedUsers}`,
    `Lark administrators: ${administrators}`,
    `Default project: ${draft.registry.defaultProjectId}`,
    ...projects,
    `Configuration directory: ${context.configDirectory}`,
    `State directory: ${context.stateDirectory}`,
    `HTTP endpoint: ${endpoint}`,
    `Service unit: ${context.serviceName}`,
    "Checks:",
    ...checks,
    `Save allowed: ${report.policy.canSave ? "yes" : "no"}`,
    `Automatic startup allowed: ${report.policy.canStart ? "yes" : "no"}`
  ].join("\n");
}

function countOpenIds(value: string | undefined): string {
  const count = value?.split(",").map((item) => item.trim()).filter(Boolean).length ?? 0;
  return count ? `${count} configured` : "missing";
}

function renderProject(project: ProjectConfig): string[] {
  return [
    `Project ${project.id}: ${project.displayName} (${project.workspaceId} -> ${project.cwd})`,
    `  Space: ${project.spaceName ?? project.displayName}`,
    `  Worker limit: ${project.maxInstances ?? 8}`
  ];
}

import type { ProjectConfig } from "../domain/types.js";
import type { RuntimeYamlConfig } from "../runtime-config.js";

export type SetupCheckStatus = "pass" | "warning" | "fail" | "skipped";
export interface SetupCheck { id: string; status: SetupCheckStatus; summary: string; remediation?: string }
export interface SetupCheckPolicy { canSave: boolean; canStart: boolean; hasWarnings: boolean; hasSkipped: boolean }
export interface SetupProjectRegistry { defaultProjectId: string; projects: ProjectConfig[] }
export interface SetupDraft { environment: Record<string, string>; registry: SetupProjectRegistry; runtime?: RuntimeYamlConfig }
export interface SetupContext { root: string; configDirectory: string; stateDirectory: string; serviceName: string; cwd: string; environmentFile?: string; projectsFile?: string; runtimeFile?: string }
export interface SetupCommitResult { environmentFile: string; projectsFile: string; runtimeFile: string; backupDirectory?: string }
export interface SetupCheckReport { checks: SetupCheck[]; policy: SetupCheckPolicy }
export interface SetupWorkspace { id: string; name: string; current: boolean }

export interface SetupPromptPort {
  text(message: string, defaultValue?: string): Promise<string>;
  secret(message: string, existingValue: boolean): Promise<{ action: "retain" } | { action: "replace"; value: string }>;
  confirm(message: string, defaultValue: boolean): Promise<boolean>;
  choose<T extends string>(message: string, options: readonly { value: T; label: string }[]): Promise<T>;
  write(message: string): void;
}

export interface SetupConfigPort {
  load(context: SetupContext): Promise<SetupDraft | null>;
  validate(draft: SetupDraft, context: SetupContext): Promise<SetupCheck[]>;
  commit(draft: SetupDraft, context: SetupContext): Promise<SetupCommitResult>;
}
export interface SetupHerdrProbe {
  listWorkspaces(): Promise<SetupWorkspace[]>;
  check(draft: SetupDraft, context: SetupContext): Promise<SetupCheck[]>;
}
export interface SetupHttpRequest {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
}
export interface SetupHttpClient {
  request(input: SetupHttpRequest): Promise<{ status: number; body: unknown }>;
}
export interface SetupLarkProbe { check(draft: SetupDraft): Promise<SetupCheck[]> }
export interface SetupLifecyclePort {
  inspect(context: SetupContext): Promise<{ installed: boolean; active: boolean; summary: string }>;
  install(context: SetupContext): Promise<void>;
  start(context: SetupContext): Promise<void>;
  restart(context: SetupContext): Promise<void>;
}

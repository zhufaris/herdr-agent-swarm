import { z } from "zod";
import type { CommandRunner } from "../infra/command-runner.js";
import type { SetupCheck, SetupContext, SetupDraft, SetupHerdrProbe, SetupWorkspace } from "../setup/setup-types.js";

const workspaceSchema = z.object({ workspace_id: z.string().min(1), label: z.string().min(1) }).passthrough();
const workspaceListSchema = z.object({ result: z.object({ type: z.literal("workspace_list"), workspaces: z.array(workspaceSchema) }) });
const workspaceGetSchema = z.object({ result: z.object({ type: z.literal("workspace_info"), workspace: workspaceSchema }) });

const herdrVersionSchema = z.string().transform((value, context) => {
  const match = /^herdr (\d+)\.(\d+)\.(\d+)$/m.exec(value.trim());
  if (!match) { context.addIssue({ code: "custom", message: "invalid Herdr version" }); return z.NEVER; }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
});
const agentStartHelpSchema = z.string().refine((value) => /\bpossible values:\s*[^\n]*\btraex\b/i.test(value), "TraeX Agent kind is unavailable");
const integrationStatusSchema = z.string().refine((value) => /^traex:\s+current\s+\(v\d+\)\s+\(.+\)$/m.test(value), "TraeX integration is not current");

export class HerdrSetupProbe implements SetupHerdrProbe {
  constructor(
    private readonly runner: CommandRunner,
    private readonly executable: string,
    private readonly timeoutMs: number,
    private readonly environment: NodeJS.ProcessEnv = process.env
  ) {}

  async listWorkspaces(): Promise<SetupWorkspace[]> {
    try {
      const result = workspaceListSchema.parse(JSON.parse((await this.runner.run(this.executable, ["workspace", "list"], this.timeoutMs)).stdout));
      const currentId = this.environment.HERDR_WORKSPACE_ID;
      return result.result.workspaces.map((workspace) => ({ id: workspace.workspace_id, name: workspace.label, current: workspace.workspace_id === currentId }));
    } catch {
      throw new Error("Herdr did not return valid workspace data");
    }
  }

  async check(draft: SetupDraft, _context: SetupContext): Promise<SetupCheck[]> {
    let workspaces: SetupWorkspace[];
    try {
      workspaces = await this.listWorkspaces();
    } catch {
      return [{ id: "herdr.available", status: "fail", summary: "Herdr is unavailable or returned invalid data", remediation: `Install or start Herdr and verify ${this.executable} workspace list.` }];
    }
    const checks: SetupCheck[] = [{ id: "herdr.available", status: "pass", summary: "Herdr workspace discovery succeeded" }];
    for (const project of draft.registry.projects) {
      const listed = workspaces.find((workspace) => workspace.id === project.workspaceId);
      if (!listed) {
        checks.push({ id: `herdr.workspace.${project.id}`, status: "fail", summary: `Workspace ${project.workspaceId} does not exist`, remediation: "Select one of the live Herdr workspaces." });
        continue;
      }
      try {
        const raw = await this.runner.run(this.executable, ["workspace", "get", project.workspaceId], this.timeoutMs);
        const live = workspaceGetSchema.parse(JSON.parse(raw.stdout)).result.workspace;
        const expected = project.spaceName ?? project.displayName;
        checks.push(live.label === expected
          ? { id: `herdr.workspace.${project.id}`, status: "pass", summary: `Workspace ${project.workspaceId} matches Space ${expected}` }
          : { id: `herdr.workspace.${project.id}`, status: "fail", summary: `Workspace ${project.workspaceId} is named ${live.label}, not ${expected}`, remediation: "Choose the matching workspace or update the configured Space name." });
      } catch {
        checks.push({ id: `herdr.workspace.${project.id}`, status: "fail", summary: `Workspace ${project.workspaceId} could not be inspected`, remediation: "Verify the workspace remains available in Herdr." });
      }
    }

    checks.push(...await this.checkNativeTraex());
    return checks;
  }

  private async checkNativeTraex(): Promise<SetupCheck[]> {
    return Promise.all([
      this.capabilityCheck("herdr.version", "Herdr 0.9.0 or newer is available", `Update the configured Herdr executable ${this.executable} to version 0.9.0 or newer.`, async () => {
        const version = herdrVersionSchema.parse((await this.runner.run(this.executable, ["--version"], this.timeoutMs)).stdout);
        if (version.major < 1 && version.minor < 9) throw new Error("unsupported Herdr version");
      }),
      this.capabilityCheck("herdr.agent.traex", "Herdr exposes the native TraeX Agent kind", `Verify ${this.executable} agent start --help lists traex as a supported kind.`, async () => {
        agentStartHelpSchema.parse((await this.runner.run(this.executable, ["agent", "start", "--help"], this.timeoutMs)).stdout);
      }),
      this.capabilityCheck("herdr.integration.traex", "The Herdr TraeX integration is current", `Update the TraeX integration reported by ${this.executable} integration status.`, async () => {
        integrationStatusSchema.parse((await this.runner.run(this.executable, ["integration", "status"], this.timeoutMs)).stdout);
      })
    ]);
  }

  private async capabilityCheck(id: string, summary: string, remediation: string, inspect: () => Promise<void>): Promise<SetupCheck> {
    try { await inspect(); return { id, status: "pass", summary }; }
    catch { return { id, status: "fail", summary: `${summary} check failed`, remediation }; }
  }
}

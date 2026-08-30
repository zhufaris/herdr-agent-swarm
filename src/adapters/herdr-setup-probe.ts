import { join } from "node:path";
import { z } from "zod";
import type { CommandRunner } from "../infra/command-runner.js";
import type { SetupCheck, SetupContext, SetupDraft, SetupHerdrProbe, SetupWorkspace } from "../setup/setup-types.js";

const workspaceSchema = z.object({ workspace_id: z.string().min(1), label: z.string().min(1) }).passthrough();
const workspaceListSchema = z.object({ result: z.object({ type: z.literal("workspace_list"), workspaces: z.array(workspaceSchema) }) });
const workspaceGetSchema = z.object({ result: z.object({ type: z.literal("workspace_info"), workspace: workspaceSchema }) });

const shimStatusSchema = z.string().refine((value) => /^status: ready$/m.test(value));

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

  async check(draft: SetupDraft, context: SetupContext): Promise<SetupCheck[]> {
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

    checks.push(await this.checkTraexShim(context));
    return checks;
  }

  private async checkTraexShim(context: SetupContext): Promise<SetupCheck> {
    const script = join(context.root, "scripts/install-herdr-traex-shim.sh");
    try {
      const result = await this.runner.run("bash", [script, "status"], this.timeoutMs);
      shimStatusSchema.parse(result.stdout);
      return { id: "herdr.agent.traex", status: "pass", summary: "The Herdr TraeX shim is ready" };
    } catch {
      return {
        id: "herdr.agent.traex", status: "fail", summary: "The Herdr TraeX shim is not ready",
        remediation: `Run bash ${script} install with the required --bin-dir after reviewing the installer options.`
      };
    }
  }
}

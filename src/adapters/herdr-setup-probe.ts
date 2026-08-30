import { execFile } from "node:child_process";
import { join } from "node:path";
import { z } from "zod";
import type { CommandRunner } from "../infra/command-runner.js";
import type { SetupCheck, SetupContext, SetupDraft, SetupHerdrProbe, SetupWorkspace } from "../setup/setup-types.js";

const workspaceSchema = z.object({ workspace_id: z.string().min(1), label: z.string().min(1) }).passthrough();
const workspaceListSchema = z.object({ result: z.object({ type: z.literal("workspace_list"), workspaces: z.array(workspaceSchema) }) });
const workspaceGetSchema = z.object({ result: z.object({ type: z.literal("workspace_info"), workspace: workspaceSchema }) });

const nativeAgentKind = { codex: "codex", "claude-code": "claude", pi: "pi" } as const;
const capabilityResultSchema = z.object({ exitCode: z.union([z.literal(0), z.literal(2)]), stdout: z.string(), stderr: z.string() });
const shimStatusSchema = z.string().refine((value) => /^status: ready$/m.test(value));

export interface HerdrCapabilityReader {
  read(executable: string, args: string[], timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

class ExecFileHerdrCapabilityReader implements HerdrCapabilityReader {
  read(executable: string, args: string[], timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(executable, args, { timeout: timeoutMs, maxBuffer: 256 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
        if (!error) { resolve({ exitCode: 0, stdout, stderr }); return; }
        const code = typeof error.code === "number" ? error.code : null;
        if (code === 2 && stdout.trim()) { resolve({ exitCode: code, stdout, stderr }); return; }
        reject(new Error("Herdr capability output is unavailable"));
      });
    });
  }
}

export class HerdrSetupProbe implements SetupHerdrProbe {
  constructor(
    private readonly runner: CommandRunner,
    private readonly executable: string,
    private readonly timeoutMs: number,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly capabilityReader: HerdrCapabilityReader = new ExecFileHerdrCapabilityReader()
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

    const selected = new Set(draft.registry.projects.flatMap((project) => (project.instances ?? []).map((instance) => instance.agent)));
    if (selected.has("traex")) checks.push(await this.checkTraexShim(context));
    const selectedNative = [...selected].filter((kind): kind is keyof typeof nativeAgentKind => kind !== "traex");
    if (selectedNative.length === 0) return checks;

    let kinds: Set<string>;
    try {
      const result = capabilityResultSchema.parse(await this.capabilityReader.read(this.executable, ["agent"], this.timeoutMs));
      const match = result.stdout.match(/^\s*kinds:\s*([^\n]+)$/mi);
      if (!match) throw new Error("missing kinds");
      kinds = new Set(match[1]!.split("|").map((value) => value.trim()));
    } catch {
      checks.push({ id: "herdr.agent-capabilities", status: "fail", summary: "Herdr agent capabilities could not be inspected", remediation: `Run ${this.executable} agent and verify the installed Herdr version.` });
      return checks;
    }
    for (const selectedKind of selectedNative) {
      const supported = kinds.has(nativeAgentKind[selectedKind]);
      checks.push(supported
        ? { id: `herdr.agent.${selectedKind}`, status: "pass", summary: `Herdr supports ${selectedKind}` }
        : { id: `herdr.agent.${selectedKind}`, status: "fail", summary: `Herdr does not support agent kind ${selectedKind}`, remediation: "Upgrade Herdr or select a supported agent kind." });
    }
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

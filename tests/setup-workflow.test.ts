import { describe, expect, it } from "vitest";
import { SetupCancelledError } from "../src/setup/setup-prompts.js";
import { runSetupWorkflow } from "../src/setup/setup-workflow.js";
import type { SetupCheck, SetupContext, SetupDraft, SetupPromptPort } from "../src/setup/setup-types.js";

const context: SetupContext = { root: "/app", configDirectory: "/config", stateDirectory: "/state", serviceName: "swarm.service", cwd: "/work/My App!" };

class ScriptedPrompts implements SetupPromptPort {
  readonly output: string[] = [];
  constructor(private readonly answers: unknown[]) {}
  async text(_message: string, defaultValue?: string) { const answer = this.answers.shift(); return String(answer === "" || answer === undefined ? defaultValue ?? "" : answer); }
  async secret(_message: string, existingValue: boolean) {
    const answer = this.answers.shift();
    if (answer === "retain" && existingValue) return { action: "retain" } as const;
    return { action: "replace", value: String(answer ?? "secret") } as const;
  }
  async confirm() { return Boolean(this.answers.shift()); }
  async choose<T extends string>(_message: string, options: readonly { value: T }[]) {
    return String(this.answers.shift() ?? options[0]!.value) as T;
  }
  write(message: string) { this.output.push(message); }
}

function dependencies(answers: unknown[], options: { existing?: SetupDraft; checks?: SetupCheck[]; active?: boolean } = {}) {
  const events: string[] = [];
  let committed: SetupDraft | undefined;
  const prompts = new ScriptedPrompts(answers);
  return {
    events, prompts, get committed() { return committed; },
    value: {
      prompts,
      config: {
        async load() { events.push("load"); return options.existing ?? null; },
        async validate() { return options.checks ?? [{ id: "config.schema", status: "pass", summary: "valid" }]; },
        async commit(draft: SetupDraft) { events.push("commit"); committed = draft; return { environmentFile: "/config/.env", projectsFile: "/config/projects.json" }; }
      },
      herdr: {
        async listWorkspaces() { return [{ id: "w-old", name: "Old", current: false }, { id: "w-current", name: "Current", current: true }]; },
        async check() { events.push("validate:herdr"); return [{ id: "herdr.available", status: "pass", summary: "ready" }]; }
      },
      lark: { async check() { events.push("validate:lark"); return [{ id: "lark.auth", status: "pass", summary: "ready" }]; } },
      lifecycle: {
        async inspect() { events.push("inspect-service"); return { installed: false, active: options.active ?? false, summary: "idle" }; },
        async install() { events.push("install"); }, async start() { events.push("start"); }, async restart() { events.push("restart"); }
      },
      async runLocalChecks() { events.push("validate:local"); return [{ id: "local.node", status: "pass", summary: "ready" }]; },
      onStep(step: string) { events.push(step); }
    }
  };
}

describe("setup workflow", () => {
  it("collects first-run defaults, checks, reviews, commits, installs, and starts in order", async () => {
    const fixture = dependencies(["app", "secret", "chat", "bot", "", "", "", "", "", "", true, true, true]);
    await expect(runSetupWorkflow(fixture.value, context)).resolves.toMatchObject({ status: "started" });
    expect(fixture.committed?.registry).toEqual({
      defaultProjectId: "my-app",
      projects: [expect.objectContaining({ id: "my-app", displayName: "My App!", spaceName: "My App!", workspaceId: "w-current", cwd: "/work/My App!", maxInstances: 8, instances: [
        { name: "primary", role: "primary", agent: "traex", workspace: { kind: "main-checkout" } },
        { name: "worker", role: "worker", agent: "traex", workspace: { kind: "git-worktree", baseRef: "HEAD" } }
      ] })]
    });
    expect(fixture.events).toEqual(["load", "collect:lark", "collect:project", "validate:local", "validate:herdr", "validate:lark", "review", "commit", "inspect-service", "confirm-install", "install", "confirm-start", "start"]);
  });

  it("retains an existing secret and preserves multi-project configuration unless editing is requested", async () => {
    const existing: SetupDraft = { environment: { LARK_APP_ID: "old-app", LARK_APP_SECRET: "kept", LARK_CHAT_ID: "old-chat", LARK_BOT_OPEN_ID: "old-bot" }, registry: { defaultProjectId: "one", projects: [
      { id: "one", displayName: "One", description: "One", workspaceId: "w-old", cwd: "/one" },
      { id: "two", displayName: "Two", description: "Two", workspaceId: "w-current", cwd: "/two" }
    ] } };
    const fixture = dependencies(["new-app", "retain", "", "", "", false, true, false], { existing });
    expect((await runSetupWorkflow(fixture.value, context)).status).toBe("saved");
    expect(fixture.committed?.environment.LARK_APP_SECRET).toBe("kept");
    expect(fixture.committed?.registry).toEqual(existing.registry);
  });

  it("replaces only the selected default project when editing a multi-project registry", async () => {
    const existing: SetupDraft = { environment: { LARK_APP_ID: "app", LARK_APP_SECRET: "old", LARK_CHAT_ID: "chat", LARK_BOT_OPEN_ID: "bot" }, registry: { defaultProjectId: "one", projects: [
      { id: "one", displayName: "One", description: "One", workspaceId: "w-old", cwd: "/one" },
      { id: "two", displayName: "Two", description: "Two", workspaceId: "w-current", cwd: "/two" }
    ] } };
    const fixture = dependencies(["", "replace-secret", "", "", "", true, "one-edited", "One edited", "One space", "w-current", "/one", true, false], { existing });
    expect((await runSetupWorkflow(fixture.value, context)).status).toBe("saved");
    expect(fixture.committed?.environment.LARK_APP_SECRET).toBe("replace-secret");
    expect(fixture.committed?.registry.defaultProjectId).toBe("one-edited");
    expect(fixture.committed?.registry.projects.map((project) => project.id)).toEqual(["one-edited", "two"]);
  });

  it("requires explicit acceptance for warnings and saves skips without lifecycle mutation", async () => {
    const warning = dependencies(["app", "secret", "chat", "bot", "", "", "", "", "", "", true, true, false], { checks: [{ id: "config.manual", status: "warning", summary: "verify manually" }] });
    expect((await runSetupWorkflow(warning.value, context)).status).toBe("saved");
    expect(warning.prompts.output.join("\n")).toContain("verify manually");

    const skipped = dependencies(["app", "secret", "chat", "bot", "", "", "", "", "", "", true, true], {});
    skipped.value.skipNetwork = true;
    expect((await runSetupWorkflow(skipped.value, context)).status).toBe("saved");
    expect(skipped.events).not.toContain("validate:lark");
    expect(skipped.events).not.toContain("inspect-service");
  });

  it("cancels before commit and separately confirms an active-service restart", async () => {
    const cancelled = dependencies(["app", "secret", "chat", "bot", "", "", "", "", "", "", false]);
    expect((await runSetupWorkflow(cancelled.value, context)).status).toBe("cancelled");
    expect(cancelled.events).not.toContain("commit");

    const active = dependencies(["app", "secret", "chat", "bot", "", "", "", "", "", "", true, true, true], { active: true });
    await expect(runSetupWorkflow(active.value, context)).resolves.toMatchObject({ status: "started" });
    expect(active.events.slice(-5)).toEqual(["inspect-service", "confirm-install", "install", "confirm-restart", "restart"]);
  });

  it("converts typed prompt cancellation and lifecycle safety refusal without committing or forcing", async () => {
    const fixture = dependencies([]);
    fixture.value.prompts.text = async () => { throw new SetupCancelledError(); };
    expect((await runSetupWorkflow(fixture.value, context)).status).toBe("cancelled");
    expect(fixture.events).toEqual(["load", "collect:lark"]);

    const active = dependencies(["app", "secret", "chat", "bot", "", "", "", "", "", "", true, true, true], { active: true });
    active.value.lifecycle.restart = async () => { throw new Error("active work prevents safe restart"); };
    await expect(runSetupWorkflow(active.value, context)).rejects.toThrow("active work prevents safe restart");
  });
});

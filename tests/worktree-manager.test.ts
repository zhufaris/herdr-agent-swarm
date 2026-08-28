import { describe, expect, it } from "vitest";
import type { CommandRunner } from "../src/infra/command-runner.js";
import { WorktreeManager } from "../src/runtime/worktree-manager.js";

class ScriptedRunner implements CommandRunner {
  readonly calls: Array<{ executable: string; args: string[] }> = [];
  constructor(private readonly replies: Array<{ stdout?: string; stderr?: string; error?: Error }>) {}
  async run(executable: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    this.calls.push({ executable, args });
    const reply = this.replies.shift();
    if (!reply) throw new Error(`Unexpected command: ${executable} ${args.join(" ")}`);
    if (reply.error) throw reply.error;
    return { stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" };
  }
}

const registered = [
  "worktree /repo",
  "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "branch refs/heads/main",
  "",
  "worktree /repo/.worktree/worker-1",
  "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "branch refs/heads/solo/worker-1",
  ""
].join("\n");

describe("WorktreeManager", () => {
  it("prepares an owned worker worktree with argv-only Git commands", async () => {
    const runner = new ScriptedRunner([
      { stdout: "/repo\n" }, { stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" },
      { stdout: "worktree /repo\nHEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nbranch refs/heads/main\n" },
      { error: new Error("branch missing") }, { stdout: "" }, { stdout: registered }
    ]);
    const manager = new WorktreeManager(runner, { managedRoot: "/repo/.worktree", timeoutMs: 5_000 });

    await expect(manager.prepare({ repositoryRoot: "/repo", targetPath: "/repo/.worktree/worker-1", branch: "solo/worker-1", baseRef: "main" }))
      .resolves.toMatchObject({ cwd: "/repo/.worktree/worker-1", branch: "solo/worker-1", baseCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    expect(runner.calls).toContainEqual({ executable: "git", args: ["-C", "/repo", "worktree", "add", "-b", "solo/worker-1", "/repo/.worktree/worker-1", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] });
  });

  it("adopts an already-created matching worktree after a missed durable checkpoint", async () => {
    const runner = new ScriptedRunner([{ stdout: "/repo\n" }, { stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" }, { stdout: registered }]);
    const manager = new WorktreeManager(runner, { timeoutMs: 5_000 });
    await expect(manager.prepare({ repositoryRoot: "/repo", targetPath: "/repo/.worktree/worker-1", branch: "solo/worker-1", baseRef: "main" }))
      .resolves.toMatchObject({ cwd: "/repo/.worktree/worker-1", branch: "solo/worker-1" });
    expect(runner.calls.some(({ args }) => args.includes("add"))).toBe(false);
  });

  it("rejects paths outside the managed root before invoking Git", async () => {
    const runner = new ScriptedRunner([]);
    const manager = new WorktreeManager(runner, { managedRoot: "/repo/.worktree", timeoutMs: 5_000 });
    await expect(manager.prepare({ repositoryRoot: "/repo", targetPath: "/tmp/worker", branch: "solo/worker", baseRef: "main" }))
      .rejects.toThrow(/managed worktree root/);
    expect(runner.calls).toEqual([]);
  });

  it("rejects an existing branch without mutating worktrees", async () => {
    const runner = new ScriptedRunner([{ stdout: "/repo\n" }, { stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" }, { stdout: "worktree /repo\nHEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nbranch refs/heads/main\n" }, { stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" }]);
    const manager = new WorktreeManager(runner, { managedRoot: "/repo/.worktree", timeoutMs: 5_000 });
    await expect(manager.prepare({ repositoryRoot: "/repo", targetPath: "/repo/.worktree/worker-1", branch: "solo/worker-1", baseRef: "main" }))
      .rejects.toThrow(/branch already exists/);
    expect(runner.calls.some(({ args }) => args.includes("add"))).toBe(false);
  });

  it.each([
    ["dirty", " M src/a.ts\n", "", "0\n"],
    ["conflicted", "UU src/a.ts\n", "100644 a 1\tsrc/a.ts\n", "0\n"],
    ["ahead", "", "", "2\n"]
  ] as const)("retains a %s worktree", async (reason, status, conflicts, ahead) => {
    const runner = inspectionRunner(status, conflicts, ahead);
    const manager = new WorktreeManager(runner, { managedRoot: "/repo/.worktree", timeoutMs: 5_000 });
    const plan = await manager.planRemoval({ repositoryRoot: "/repo", targetPath: "/repo/.worktree/worker-1", baseCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", leaseGeneration: 4 });
    expect(plan).toMatchObject({ safe: false, reason, leaseGeneration: 4 });
  });

  it("reports uncertain inspection failures and never removes them", async () => {
    const runner = new ScriptedRunner([{ error: new Error("git unavailable") }]);
    const manager = new WorktreeManager(runner, { managedRoot: "/repo/.worktree", timeoutMs: 5_000 });
    const plan = await manager.planRemoval({ repositoryRoot: "/repo", targetPath: "/repo/.worktree/worker-1", baseCommit: "base", leaseGeneration: 1 });
    expect(plan).toMatchObject({ safe: false, reason: "uncertain" });
    await expect(manager.release(plan)).rejects.toThrow(/not safe/);
  });

  it("removes only when a clean plan still matches generation and Git fingerprint", async () => {
    const runner = new ScriptedRunner([
      ...inspectionReplies("", "", "0\n"),
      ...inspectionReplies("", "", "0\n"),
      { stdout: "" }
    ]);
    const manager = new WorktreeManager(runner, { managedRoot: "/repo/.worktree", timeoutMs: 5_000 });
    const plan = await manager.planRemoval({ repositoryRoot: "/repo", targetPath: "/repo/.worktree/worker-1", baseCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", leaseGeneration: 7 });
    expect(plan.safe).toBe(true);
    await expect(manager.release(plan, 7)).resolves.toBeUndefined();
    expect(runner.calls.at(-1)).toEqual({ executable: "git", args: ["-C", "/repo", "worktree", "remove", "/repo/.worktree/worker-1"] });
  });

  it("rejects stale generation and changed fingerprints", async () => {
    const staleGenerationRunner = inspectionRunner("", "", "0\n");
    const manager = new WorktreeManager(staleGenerationRunner, { managedRoot: "/repo/.worktree", timeoutMs: 5_000 });
    const plan = await manager.planRemoval({ repositoryRoot: "/repo", targetPath: "/repo/.worktree/worker-1", baseCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", leaseGeneration: 2 });
    await expect(manager.release(plan, 3)).rejects.toThrow(/stale generation/);

    const changedRunner = new ScriptedRunner([
      ...inspectionReplies("", "", "0\n"),
      ...inspectionReplies(" M changed.ts\n", "", "0\n")
    ]);
    const changed = new WorktreeManager(changedRunner, { managedRoot: "/repo/.worktree", timeoutMs: 5_000 });
    const changedPlan = await changed.planRemoval({ repositoryRoot: "/repo", targetPath: "/repo/.worktree/worker-1", baseCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", leaseGeneration: 2 });
    await expect(changed.release(changedPlan, 2)).rejects.toThrow(/changed since confirmation/);
  });

  it("treats an already-unregistered target as a completed release retry", async () => {
    const runner = new ScriptedRunner([{ stdout: "worktree /repo\nHEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nbranch refs/heads/main\n" }]);
    const manager = new WorktreeManager(runner, { managedRoot: "/repo/.worktree", timeoutMs: 5_000 });
    await expect(manager.release({ repositoryRoot: "/repo", targetPath: "/repo/.worktree/worker-1", baseCommit: "base", leaseGeneration: 1, safe: true, reason: "clean", fingerprint: "confirmed", inspection: null })).resolves.toBeUndefined();
    expect(runner.calls).toHaveLength(1);
  });
});

function inspectionRunner(status: string, conflicts: string, ahead: string): ScriptedRunner {
  return new ScriptedRunner(inspectionReplies(status, conflicts, ahead));
}

function inspectionReplies(status: string, conflicts: string, ahead: string): Array<{ stdout: string }> {
  return [
    { stdout: registered }, { stdout: status }, { stdout: conflicts },
    { stdout: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n" }, { stdout: ahead }
  ];
}

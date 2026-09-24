import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { CommandRunner } from "../infra/command-runner.js";
import type { PreparedWorktree, WorktreeInspection, WorktreePort, WorktreeRemovalPlan, WorktreeRemovalReason } from "../domain/ports/worktree.js";
export type { PreparedWorktree, WorktreeInspection, WorktreeRemovalPlan, WorktreeRemovalReason } from "../domain/ports/worktree.js";

interface WorktreeManagerOptions { managedRoot?: string; timeoutMs: number }

export class WorktreeManager implements WorktreePort {
  constructor(private readonly runner: CommandRunner, private readonly options: WorktreeManagerOptions) {}

  async prepare(input: { repositoryRoot: string; targetPath: string; branch: string; baseRef: string }): Promise<PreparedWorktree> {
    const repositoryRoot = resolve(input.repositoryRoot);
    const targetPath = this.requireOwnedPath(repositoryRoot, input.targetPath);
    const canonicalRoot = (await this.git(repositoryRoot, ["rev-parse", "--show-toplevel"])).trim();
    if (resolve(canonicalRoot) !== repositoryRoot) throw new Error("Repository root does not own the requested worktree");
    const baseCommit = (await this.git(repositoryRoot, ["rev-parse", "--verify", `${input.baseRef}^{commit}`])).trim();
    const existing = this.findRegistration(await this.git(repositoryRoot, ["worktree", "list", "--porcelain"]), targetPath);
    if (existing) {
      if (existing.branch !== input.branch || existing.headCommit !== baseCommit) throw new Error("Existing worktree does not match the requested allocation");
      return { cwd: targetPath, branch: input.branch, baseCommit, headCommit: existing.headCommit };
    }
    try {
      await this.git(repositoryRoot, ["show-ref", "--verify", `refs/heads/${input.branch}`]);
      throw new Error(`Worktree branch already exists: ${input.branch}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Worktree branch already exists:")) throw error;
    }
    await this.git(repositoryRoot, ["worktree", "add", "-b", input.branch, targetPath, baseCommit]);
    const registration = this.findRegistration(await this.git(repositoryRoot, ["worktree", "list", "--porcelain"]), targetPath);
    if (!registration || registration.branch !== input.branch || registration.headCommit !== baseCommit) {
      throw new Error("Created worktree could not be verified against Git ownership");
    }
    return { cwd: targetPath, branch: input.branch, baseCommit, headCommit: registration.headCommit };
  }

  async inspect(input: { repositoryRoot: string; targetPath: string; baseCommit: string }): Promise<WorktreeInspection> {
    const repositoryRoot = resolve(input.repositoryRoot);
    const targetPath = this.requireOwnedPath(repositoryRoot, input.targetPath);
    const registration = this.findRegistration(await this.git(repositoryRoot, ["worktree", "list", "--porcelain"]), targetPath);
    if (!registration) throw new Error("Target is not a registered worktree owned by this repository");
    const status = await this.git(targetPath, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const conflicts = await this.git(targetPath, ["ls-files", "--unmerged"]);
    const headCommit = (await this.git(targetPath, ["rev-parse", "HEAD"])).trim();
    const aheadText = (await this.git(targetPath, ["rev-list", "--count", `${input.baseCommit}..HEAD`])).trim();
    const aheadCount = Number.parseInt(aheadText, 10);
    if (!headCommit || !Number.isSafeInteger(aheadCount) || aheadCount < 0) throw new Error("Git returned an invalid worktree inspection");
    const dirty = status.length > 0;
    const conflicted = conflicts.length > 0 || status.split(/\r?\n/).some((line) => /^(?:DD|AU|UD|UA|DU|AA|UU) /.test(line));
    const fingerprint = createHash("sha256").update(JSON.stringify({ targetPath, branch: registration.branch, headCommit, status, conflicts, aheadCount })).digest("hex");
    return { registered: true, cwd: targetPath, branch: registration.branch, headCommit, dirty, conflicted, aheadCount, fingerprint };
  }

  async planRemoval(input: { repositoryRoot: string; targetPath: string; baseCommit: string; leaseGeneration: number }): Promise<WorktreeRemovalPlan> {
    const common = { repositoryRoot: resolve(input.repositoryRoot), targetPath: resolve(input.targetPath), baseCommit: input.baseCommit, leaseGeneration: input.leaseGeneration };
    try {
      const inspection = await this.inspect(input);
      const reason: WorktreeRemovalReason = inspection.conflicted ? "conflicted" : inspection.dirty ? "dirty" : inspection.aheadCount > 0 ? "ahead" : "clean";
      return { ...common, safe: reason === "clean", reason, fingerprint: inspection.fingerprint, inspection };
    } catch {
      return { ...common, safe: false, reason: "uncertain", fingerprint: null, inspection: null };
    }
  }

  async release(plan: WorktreeRemovalPlan, currentLeaseGeneration = plan.leaseGeneration): Promise<void> {
    if (!plan.safe || !plan.fingerprint) throw new Error(`Worktree removal plan is not safe: ${plan.reason}`);
    if (currentLeaseGeneration !== plan.leaseGeneration) throw new Error("Worktree removal plan has a stale generation");
    let current: WorktreeInspection;
    try { current = await this.inspect(plan); }
    catch (error) {
      if (error instanceof Error && error.message === "Target is not a registered worktree owned by this repository") return;
      throw error;
    }
    if (current.fingerprint !== plan.fingerprint) throw new Error("Worktree changed since confirmation");
    await this.git(plan.repositoryRoot, ["worktree", "remove", plan.targetPath]);
  }

  private requireOwnedPath(repositoryRoot: string, path: string): string {
    if (!isAbsolute(path)) throw new Error("Worktree path must be absolute");
    const target = resolve(path);
    const managedRoot = resolve(this.options.managedRoot ?? join(repositoryRoot, ".worktree"));
    const ownership = relative(managedRoot, target);
    if (!ownership || ownership.startsWith("..") || isAbsolute(ownership)) throw new Error("Target must be inside the managed worktree root");
    return target;
  }

  private git(cwd: string, args: string[]): Promise<string> {
    return this.runner.run("git", ["-C", cwd, ...args], this.options.timeoutMs).then(({ stdout }) => stdout);
  }

  private findRegistration(output: string, targetPath: string): { branch: string | null; headCommit: string } | null {
    for (const block of output.trim().split(/\r?\n\r?\n/)) {
      const fields = block.split(/\r?\n/);
      const path = fields.find((line) => line.startsWith("worktree "))?.slice(9);
      if (!path || resolve(path) !== targetPath) continue;
      const branchRef = fields.find((line) => line.startsWith("branch "))?.slice(7) ?? null;
      return { branch: branchRef?.startsWith("refs/heads/") ? branchRef.slice(11) : null, headCommit: fields.find((line) => line.startsWith("HEAD "))?.slice(5) ?? "" };
    }
    return null;
  }
}

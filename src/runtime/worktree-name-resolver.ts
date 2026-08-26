import { basename } from "node:path";
import type { CommandRunner } from "../infra/command-runner.js";

interface CacheEntry { value: string | null; expiresAt: number }

export class WorktreeNameResolver {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly runner: CommandRunner,
    private readonly timeoutMs: number,
    private readonly ttlMs = 30_000,
    private readonly clock: () => number = Date.now
  ) {}

  async resolve(cwd: string | null | undefined): Promise<string | null> {
    if (!cwd) return null;
    const cached = this.cache.get(cwd);
    if (cached && cached.expiresAt > this.clock()) return cached.value;
    let value: string | null = null;
    try {
      const { stdout } = await this.runner.run("git", ["-C", cwd, "rev-parse", "--show-toplevel"], this.timeoutMs);
      const root = stdout.trim();
      value = root ? basename(root) || null : null;
    } catch {
      // A pane may be in a non-Git directory or briefly unavailable. The card
      // intentionally shows no worktree rather than exposing a host path.
    }
    this.cache.set(cwd, { value, expiresAt: this.clock() + this.ttlMs });
    return value;
  }
}

import { describe, expect, it, vi } from "vitest";
import type { CommandRunner } from "../src/infra/command-runner.js";
import { WorktreeNameResolver } from "../src/runtime/worktree-name-resolver.js";

describe("worktree name resolver", () => {
  it("shows only the Git worktree root directory for a nested pane directory", async () => {
    const run = vi.fn(async () => ({ stdout: "/data/work/.worktree/feat-main-card\n", stderr: "" }));
    const resolver = new WorktreeNameResolver({ run } as CommandRunner, 1_000);

    await expect(resolver.resolve("/data/work/.worktree/feat-main-card/src/cards")).resolves.toBe("feat-main-card");
    expect(run).toHaveBeenCalledWith("git", ["-C", "/data/work/.worktree/feat-main-card/src/cards", "rev-parse", "--show-toplevel"], 1_000);
  });

  it("caches a failed non-Git lookup and never returns the source path", async () => {
    const run = vi.fn(async () => { throw new Error("not a git repository: /private/host/path"); });
    const resolver = new WorktreeNameResolver({ run } as CommandRunner, 1_000);

    await expect(resolver.resolve("/private/host/path")).resolves.toBeNull();
    await expect(resolver.resolve("/private/host/path")).resolves.toBeNull();
    expect(run).toHaveBeenCalledOnce();
  });
});

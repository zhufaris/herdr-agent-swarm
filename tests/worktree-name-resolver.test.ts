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

  it("coalesces concurrent lookups for the same working directory", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const run = vi.fn(async () => { await pending; return { stdout: "/repo/shared-worktree\n", stderr: "" }; });
    const resolver = new WorktreeNameResolver({ run } as CommandRunner, 1_000);

    const first = resolver.resolve("/repo/shared-worktree/src");
    const second = resolver.resolve("/repo/shared-worktree/src");

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(["shared-worktree", "shared-worktree"]);
    expect(run).toHaveBeenCalledOnce();
  });

  it("keeps lookups for different working directories concurrent", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const run = vi.fn(async (_command: string, args: string[]) => { await pending; return { stdout: `/repo/${args[1]}\n`, stderr: "" }; });
    const resolver = new WorktreeNameResolver({ run } as CommandRunner, 1_000);

    const first = resolver.resolve("first");
    const second = resolver.resolve("second");

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
  });

  it("evicts the least recently used entry when the cache reaches its bound", async () => {
    const run = vi.fn(async (_command: string, args: string[]) => ({ stdout: `/repo/${args[1]}\n`, stderr: "" }));
    const resolver = new WorktreeNameResolver({ run } as CommandRunner, 1_000, 30_000, () => 0, 2);

    await resolver.resolve("a");
    await resolver.resolve("b");
    await resolver.resolve("a");
    await resolver.resolve("c");
    await resolver.resolve("a");
    await resolver.resolve("b");

    expect(run.mock.calls.map(([, args]) => args[1])).toEqual(["a", "b", "c", "b"]);
  });

  it("prunes expired entries before applying the capacity limit", async () => {
    let now = 0;
    const run = vi.fn(async (_command: string, args: string[]) => ({ stdout: `/repo/${args[1]}\n`, stderr: "" }));
    const resolver = new WorktreeNameResolver({ run } as CommandRunner, 1_000, 10, () => now, 2);

    await resolver.resolve("expired");
    now = 11;
    await resolver.resolve("fresh-a");
    await resolver.resolve("fresh-b");
    await resolver.resolve("fresh-a");

    expect(run.mock.calls.map(([, args]) => args[1])).toEqual(["expired", "fresh-a", "fresh-b"]);
  });
});

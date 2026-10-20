export type CommitState = "pending" | "committed" | "rolled_back";

export class PostCommitReceipt<TResult, TEffect> {
  private state: CommitState = "pending";
  private consumed = false;
  private readonly committedListeners = new Set<() => void>();

  constructor(readonly result: TResult, private readonly pendingEffects: readonly TEffect[]) {}

  get commitState(): CommitState { return this.state; }

  consumeEffects(): readonly TEffect[] {
    if (this.state === "pending") throw new Error("Post-commit effects cannot run before the outer transaction commits");
    if (this.state === "rolled_back" || this.consumed) return [];
    this.consumed = true;
    return this.pendingEffects;
  }

  afterCommit(listener: () => void): void {
    if (this.state === "committed") {
      try { listener(); } catch {}
      return;
    }
    if (this.state === "pending") this.committedListeners.add(listener);
  }

  markCommitted(): void {
    if (this.state !== "pending") return;
    this.state = "committed";
    for (const listener of this.committedListeners) {
      try { listener(); } catch {}
    }
    this.committedListeners.clear();
  }

  markRolledBack(): void {
    if (this.state !== "pending") return;
    this.state = "rolled_back";
    this.committedListeners.clear();
  }
}

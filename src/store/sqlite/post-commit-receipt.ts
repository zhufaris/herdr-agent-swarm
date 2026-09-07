export type CommitState = "pending" | "committed" | "rolled_back";

export class PostCommitReceipt<TResult, TEffect> {
  private state: CommitState = "pending";
  private consumed = false;

  constructor(readonly result: TResult, private readonly pendingEffects: readonly TEffect[]) {}

  get commitState(): CommitState { return this.state; }

  consumeEffects(): readonly TEffect[] {
    if (this.state === "pending") throw new Error("Post-commit effects cannot run before the outer transaction commits");
    if (this.state === "rolled_back" || this.consumed) return [];
    this.consumed = true;
    return this.pendingEffects;
  }

  markCommitted(): void { if (this.state === "pending") this.state = "committed"; }
  markRolledBack(): void { if (this.state === "pending") this.state = "rolled_back"; }
}

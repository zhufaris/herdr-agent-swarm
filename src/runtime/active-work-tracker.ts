/** Tracks independently launched work so shutdown can await a stable snapshot. */
export class ActiveWorkTracker {
  private readonly active = new Set<Promise<unknown>>();

  track<T>(work: Promise<T>): Promise<T> {
    this.active.add(work);
    void work.then(
      () => this.active.delete(work),
      () => this.active.delete(work)
    );
    return work;
  }

  get size(): number { return this.active.size; }

  async settle(): Promise<void> {
    await Promise.allSettled([...this.active]);
  }
}

/**
 * Serializes asynchronous work per key while permitting independent keys to run
 * concurrently. A failed item does not poison later work for the same key.
 */
export class KeyedSerialWorkQueue<Key> {
  private readonly tails = new Map<Key, Promise<void>>();
  private stopping = false;

  enqueue<Result>(key: Key, work: () => Promise<Result>): Promise<Result> {
    if (this.stopping) return Promise.resolve(undefined as Result);
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(work);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return result;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.settle();
  }

  async settle(): Promise<void> {
    await Promise.allSettled([...this.tails.values()]);
  }
}

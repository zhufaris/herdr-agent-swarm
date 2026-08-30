export class LruMap<K, V> {
  private readonly values = new Map<K, V>();

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("LRU capacity must be a positive integer");
  }

  get(key: K): V | undefined {
    const value = this.values.get(key);
    if (value === undefined) return undefined;
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.values.delete(key);
    this.values.set(key, value);
    while (this.values.size > this.capacity) this.values.delete(this.values.keys().next().value!);
  }

  delete(key: K): boolean { return this.values.delete(key); }
  clear(): void { this.values.clear(); }
  get size(): number { return this.values.size; }
}

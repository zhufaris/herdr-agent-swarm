export class StoreLink<T> {
  private value: T | undefined;

  constructor(private readonly name: string) {}

  connect(value: T): void {
    if (this.value !== undefined) throw new Error(`${this.name} store link is already connected`);
    this.value = value;
  }

  get(): T {
    if (this.value === undefined) throw new Error(`${this.name} store link is not connected`);
    return this.value;
  }
}

type Callable<Capability> = Capability extends (...args: infer Args) => infer Result
  ? (...args: Args) => Result
  : never;

/** A single-assignment link for the few synchronous capabilities that are cyclic at composition time. */
export class RuntimeLink<Capability extends object> {
  private target: Capability | null = null;

  constructor(private readonly name: string) {}

  connect(target: Capability): void {
    if (this.target) throw new Error(`Runtime link already connected: ${this.name}`);
    this.target = target;
  }

  get(): Capability {
    if (!this.target) throw new Error(`Runtime link is not connected: ${this.name}`);
    return this.target;
  }

  callable(): Callable<Capability> {
    return ((...args: unknown[]) => Reflect.apply(this.get() as Function, undefined, args)) as Callable<Capability>;
  }
}

export const DEFAULT_SHUTDOWN_GRACE_MS = 30_000;

export interface ShutdownContext {
  signal: AbortSignal;
  deadlineAt: number;
  remainingMs(): number;
}

export function createShutdownContext(budgetMs: number, now: () => number = Date.now): { context: ShutdownContext; abort(reason?: unknown): void } {
  const controller = new AbortController();
  const deadlineAt = now() + budgetMs;
  return {
    context: { signal: controller.signal, deadlineAt, remainingMs: () => Math.max(0, deadlineAt - now()) },
    abort: (reason?: unknown) => controller.abort(reason)
  };
}

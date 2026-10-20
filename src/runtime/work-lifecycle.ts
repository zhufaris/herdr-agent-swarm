import { ActiveWorkTracker } from "./active-work-tracker.js";

/** Admits process-local work until shutdown begins, then drains admitted work. */
export class WorkAdmissionGate {
  private open = true;
  private readonly activeWork = new ActiveWorkTracker();

  get isOpen(): boolean { return this.open; }

  close(): void {
    this.open = false;
  }

  admit<T>(start: () => Promise<T> | T): Promise<T> | null {
    if (!this.open) return null;

    let work: Promise<T>;
    try {
      work = Promise.resolve(start());
    } catch (error) {
      work = Promise.reject(error);
    }
    return this.activeWork.track(work);
  }

  settle(): Promise<void> {
    return this.activeWork.settle();
  }
}

/** Owns rejection from work whose caller intentionally does not await it. */
export function observeDetached(
  task: Promise<unknown>,
  onRejected: (error: unknown) => void
): void {
  void task.catch((error: unknown) => {
    try {
      onRejected(error);
    } catch {
      // The detached task already has an owner; observer failures are absorbed.
    }
  });
}

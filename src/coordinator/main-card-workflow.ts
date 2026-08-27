import type { Logger } from "pino";
import { renderProjectEntryCard } from "../cards/run-card.js";
import type { MainCardStore } from "../domain/ports.js";
import type { TopicViewState } from "../domain/topic-view.js";

export interface MainCardWorkflowPort {
  converge(bindingId: string): Promise<void>;
  project(view: TopicViewState): Promise<void>;
}

export class MainCardWorkflow implements MainCardWorkflowPort {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly store: MainCardStore, private readonly wake: () => void, private readonly logger?: Logger) {}

  converge(bindingId: string): Promise<void> { return this.enqueue(bindingId); }
  project(view: TopicViewState): Promise<void> { return this.enqueue(view.bindingId, view); }

  private enqueue(bindingId: string, desired?: TopicViewState): Promise<void> {
    const previous = this.tails.get(bindingId) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(() => this.reserve(bindingId, desired));
    const tail = work.catch(() => undefined);
    this.tails.set(bindingId, tail);
    void tail.then(() => { if (this.tails.get(bindingId) === tail) this.tails.delete(bindingId); });
    return work;
  }

  private async reserve(bindingId: string, desired?: TopicViewState): Promise<void> {
    const binding = this.store.getBinding(bindingId);
    const view = desired ?? this.store.loadTopicView(bindingId);
    if (!binding || !view) return;
    if (!binding.rootMessageId) {
      if (desired) this.store.saveTopicView(desired);
      return;
    }
    const outcome = this.store.reserveMainCard(view, binding.rootMessageId, renderProjectEntryCard(view, { lastActivityAt: binding.lastActivityAt }));
    this.logger?.debug({ event: "main-card-converged", bindingId, viewVersion: view.viewVersion, outcome }, "converged Main Card delivery");
    if (outcome === "reserved") this.wake();
  }
}

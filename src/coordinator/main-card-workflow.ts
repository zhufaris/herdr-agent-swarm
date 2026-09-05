import type { Logger } from "pino";
import { renderProjectEntryCard } from "../cards/run-card.js";
import type { MainCardStore } from "../domain/ports/projection.js";
import { updateTopicModelPreference, type TopicViewState } from "../domain/topic-view.js";

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
    const stored = desired ?? this.store.loadTopicView(bindingId);
    const view = stored ? updateTopicModelPreference(stored, this.store.getModelPreference(bindingId)) : null;
    if (!binding || !view) return;
    if (!binding.rootMessageId) {
      if (desired) this.store.saveTopicView(view);
      return;
    }
    const outcome = this.store.reserveMainCard(view, binding.rootMessageId, renderProjectEntryCard(view));
    this.logger?.debug({ event: "main-card-converged", bindingId, viewVersion: view.viewVersion, outcome }, "converged Main Card delivery");
    if (outcome === "reserved") this.wake();
  }
}

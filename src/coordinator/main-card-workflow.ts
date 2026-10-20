import type { Logger } from "pino";
import type { MainCardStore } from "../domain/ports/projection.js";
import type { PrimaryPresentation } from "../domain/ports/presentation.js";
import { updateTopicModelPreference, updateTopicView, type TopicViewState } from "../domain/topic-view.js";
import type { OutboundWorkClass } from "../domain/types.js";
import type { MainCardConvergencePort } from "../domain/ports/card-convergence.js";
import { runtimeModelPreference } from "../domain/model-selection.js";
import { projectionGapWarning } from "../domain/projection-gap.js";

export class MainCardWorkflow implements MainCardConvergencePort {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly store: MainCardStore, private readonly wake: () => void, private readonly presentation: Pick<PrimaryPresentation, "mainCard" | "paneEntryCard">, private readonly logger?: Logger) {}

  converge(bindingId: string, workClass?: OutboundWorkClass): Promise<void> { return this.enqueue(bindingId, undefined, workClass); }
  project(view: TopicViewState, workClass?: OutboundWorkClass): Promise<void> { return this.enqueue(view.bindingId, view, workClass); }

  private enqueue(bindingId: string, desired?: TopicViewState, workClass?: OutboundWorkClass): Promise<void> {
    const previous = this.tails.get(bindingId) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(() => this.reserve(bindingId, desired, workClass));
    const tail = work.catch(() => undefined);
    this.tails.set(bindingId, tail);
    void tail.then(() => { if (this.tails.get(bindingId) === tail) this.tails.delete(bindingId); });
    return work;
  }

  private async reserve(bindingId: string, desired?: TopicViewState, workClass?: OutboundWorkClass): Promise<void> {
    const binding = this.store.getBinding(bindingId);
    const stored = desired ?? this.store.loadTopicView(bindingId);
    const current = stored && binding ? updateTopicView(stored, {
      bindingGeneration: binding.generation,
      nativeInputBacklog: this.store.getNativeInputBacklog(bindingId, binding.generation)
    }) : stored;
    const view = current ? updateTopicModelPreference(current, runtimeModelPreference.snapshot(this.store.getModelPreference(bindingId))) : null;
    if (!binding || !view) return;
    if (!binding.rootMessageId) {
      if (desired) this.store.saveTopicView(view);
      return;
    }
    const gapWarning = projectionGapWarning(this.store.getProjectionGapSummary?.({ bindingId }));
    const sessionActivity = this.store.loadSessionActivity?.(bindingId) ?? null;
    const outcome = this.store.reserveMainCard(view, binding.rootMessageId, this.presentation.mainCard(view, { gapWarning, sessionActivity }), workClass, this.presentation.paneEntryCard(view, { gapWarning, sessionActivity }));
    this.logger?.debug({ event: "main-card-converged", bindingId, viewVersion: view.viewVersion, outcome }, "converged Main Card delivery");
    if (outcome === "reserved") this.wake();
  }
}

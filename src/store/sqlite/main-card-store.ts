import type { MainCardStore } from "../../domain/ports/projection.js";
import type { SqliteProjectionStore } from "./projection-store.js";
import type { SqlitePromptAcceptanceStore } from "./prompt-acceptance-store.js";
import type { SqliteSessionActivityStore } from "./session-activity-store.js";

export class SqliteMainCardStore implements MainCardStore {
  constructor(
    private readonly projections: SqliteProjectionStore,
    private readonly promptExecution: SqlitePromptAcceptanceStore,
    private readonly sessionActivity: SqliteSessionActivityStore
  ) {}

  getBinding: MainCardStore["getBinding"] = (id) => this.projections.getBinding(id);
  getModelPreference: MainCardStore["getModelPreference"] = (id) => this.projections.getModelPreference(id);
  getNativeInputBacklog: MainCardStore["getNativeInputBacklog"] = (id, generation) => this.promptExecution.getNativeInputBacklog(id, generation);
  loadTopicView: MainCardStore["loadTopicView"] = (id) => this.projections.loadTopicView(id);
  loadSessionActivity(id: string) {
    const binding = this.projections.getBinding(id);
    return binding?.paneId ? this.sessionActivity.load(
      { kind: "pane", workspaceId: binding.workspaceId, paneId: binding.paneId },
      { bindingId: binding.id, bindingGeneration: binding.generation, sessionEpoch: binding.sessionEpoch }
    ) : null;
  }
  listRunCardsByPhases: MainCardStore["listRunCardsByPhases"] = (id, phases) => this.projections.listRunCardsByPhases(id, phases);
  getProjectionGapSummary(input: { bindingId: string }) { return this.projections.getProjectionGapSummary(input); }
  reserveMainCard: MainCardStore["reserveMainCard"] = (view, rootMessageId, card, workClass, paneEntryCard) => this.projections.reserveMainCard(view, rootMessageId, card, workClass, paneEntryCard);
  saveTopicView: MainCardStore["saveTopicView"] = (view) => this.projections.saveTopicView(view);
}

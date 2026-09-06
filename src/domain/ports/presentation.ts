export interface PanePresentation {
  paneCloseConfirmation(input: { spaceName: string; paneId: string; agentState: string; code: string; expiresAt: string }): object;
  paneCloseResult(input: { paneId: string; workerPaneCount?: number; workerPaneSucceededCount?: number; workerPaneUncertainCount?: number }): object;
  paneRetentionWarning(input: { paneId: string; warningAt: string; closeAt: string }): object;
  requestRejected(message: string): object;
}

import type { RunCardView } from "../run-card-view.js";
import type { TopicViewState } from "../topic-view.js";

export interface PrimaryPresentation {
  mainCard(view: TopicViewState): object;
  answerCard(view: RunCardView, options?: { pageNumber?: number; initialContent?: string; streaming?: boolean }): object;
  disconnectedTopic(reason: "archived" | "unbound"): object;
  requestRejected(message: string): object;
}

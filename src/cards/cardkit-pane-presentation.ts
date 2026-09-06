import type { PanePresentation } from "../domain/ports/presentation.js";
import { renderPaneCloseConfirmationCard, renderPaneCloseResultCard, renderPaneRetentionWarningCard } from "./pane-close-card.js";
import { renderMessageRejectedCard } from "./run-card.js";

export const cardKitPanePresentation: PanePresentation = {
  paneCloseConfirmation: renderPaneCloseConfirmationCard,
  paneCloseResult: renderPaneCloseResultCard,
  paneRetentionWarning: renderPaneRetentionWarningCard,
  requestRejected: renderMessageRejectedCard
};

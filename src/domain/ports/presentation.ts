export interface PanePresentation {
  paneCloseConfirmation(input: { spaceName: string; paneId: string; agentState: string; code: string; expiresAt: string }): object;
  paneCloseResult(input: { paneId: string; workerPaneCount?: number; workerPaneSucceededCount?: number; workerPaneUncertainCount?: number }): object;
  paneRetentionWarning(input: { paneId: string; warningAt: string; closeAt: string }): object;
  requestRejected(message: string): object;
}

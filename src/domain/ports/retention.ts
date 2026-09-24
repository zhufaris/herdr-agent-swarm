export interface RetentionStore {
  compactDeliveryIntents?(limit: number): number;
  pruneDeliveredOutboundReplies(cutoff: string, limit: number): number;
  pruneAcceptedInboundMessages(cutoff: string, limit: number): number;
  pruneTerminalSessionOperations(cutoff: string, limit: number): number;
}

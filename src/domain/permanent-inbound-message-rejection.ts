/**
 * A message was handled conclusively but rejected by business policy.
 *
 * The inbound dispatcher must acknowledge this message instead of returning it
 * to the durable FIFO for a retry. The user-facing rejection is persisted to
 * the outbox before this error is raised.
 */
export class PermanentInboundMessageRejection extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentInboundMessageRejection";
  }
}

export function isPermanentInboundMessageRejection(error: unknown): error is PermanentInboundMessageRejection {
  return error instanceof PermanentInboundMessageRejection;
}

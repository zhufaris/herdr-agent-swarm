export const INSTANCE_TURN_QUEUE_FULL_MESSAGE = "Target instance queue is full";

export class InstanceTurnCapacityExceeded extends Error {
  constructor() {
    super(INSTANCE_TURN_QUEUE_FULL_MESSAGE);
    this.name = "InstanceTurnCapacityExceeded";
  }
}

export function isInstanceTurnCapacityExceeded(error: unknown): error is InstanceTurnCapacityExceeded {
  return error instanceof InstanceTurnCapacityExceeded;
}

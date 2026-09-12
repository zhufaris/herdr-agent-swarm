import type { DeliveryOperationContext } from "../domain/delivery.js";

/** Retains bounded call-site identity without copying request or response data. */
export class DeliveryOperationError extends Error {
  readonly name = "DeliveryOperationError";

  constructor(readonly context: DeliveryOperationContext, readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : "Lark delivery operation failed", { cause });
  }
}

export async function performDeliveryOperation<T>(context: DeliveryOperationContext, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { throw new DeliveryOperationError(context, error); }
}

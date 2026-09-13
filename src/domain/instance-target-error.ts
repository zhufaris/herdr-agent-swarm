export type InstanceTargetErrorCode = "instance_not_running" | "instance_not_found" | "instance_project_mismatch";

const messages: Record<InstanceTargetErrorCode, string> = {
  instance_not_running: "Target instance is not running",
  instance_not_found: "Target instance not found",
  instance_project_mismatch: "Target instance is not in the requested project"
};

export class InstanceTargetError extends Error {
  constructor(readonly code: InstanceTargetErrorCode) {
    super(messages[code]);
    this.name = "InstanceTargetError";
  }
}

export function isInstanceTargetError(error: unknown): error is InstanceTargetError {
  return error instanceof InstanceTargetError;
}

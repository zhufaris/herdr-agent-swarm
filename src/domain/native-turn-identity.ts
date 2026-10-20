import { createHash } from "node:crypto";

export interface NativeTurnIdentity {
  bindingId: string;
  bindingGeneration: number;
  paneId: string;
  nativeSessionId: string;
  turnId: string;
  startedAt: string;
}

export function nativeTurnCanonical(identity: NativeTurnIdentity): string {
  return [
    `binding_id=${identity.bindingId}`,
    `binding_generation=${identity.bindingGeneration}`,
    `pane_id=${identity.paneId}`,
    `native_session_id=${identity.nativeSessionId}`,
    `turn_id=${identity.turnId}`,
    `started_at=${identity.startedAt}`
  ].join("\n");
}

export function nativeTurnHash(identity: NativeTurnIdentity): string {
  return createHash("sha256").update(nativeTurnCanonical(identity)).digest("hex");
}

export function nativeTurnSourceKey(identity: NativeTurnIdentity): string {
  return `herdr-turn:v2:${nativeTurnHash(identity)}`;
}

export function nativeTurnPromptId(identity: NativeTurnIdentity): string {
  return `herdr-prompt:v1:${nativeTurnHash(identity)}`;
}
